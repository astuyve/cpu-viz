/*
 * CPU Viz — SVG renderer.
 *
 * build(sim) lays out the static diagram; render(sim, now) updates it from
 * the simulation state every animation frame. Packet positions are derived
 * from simulated time, so a 100 ns DRAM fetch is drawn 100× longer than a
 * 1 ns L1 hit.
 */
(function (NS) {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const { SLOTS, hex } = NS.mem;

  const CPU_COLORS = ['#3b82f6', '#e5508a', '#22a06b', '#a855f7'];
  const STATES = {
    M: { name: 'Modified', color: '#f76b15' },
    E: { name: 'Exclusive', color: '#0d9488' },
    S: { name: 'Shared', color: '#3e63dd' },
    I: { name: 'Invalid', color: '#8b8d98' },
  };
  const KIND = {
    inv: { color: '#e5484d', label: 'INV' },
    snoop: { color: '#e5484d', label: 'SNOOP' },
    wb: { color: '#f76b15', label: 'write-back → DRAM' },
    fetch: { color: '#0d9488', label: 'fetch ← DRAM' },
  };
  NS.CPU_COLORS = CPU_COLORS;
  NS.STATES = STATES;

  const G = {
    W: 1200,
    H: 806,
    coreY: 16,
    coreW: 260,
    coreH: 144,
    cacheY: 190,
    cacheH: 112,
    busY: 356,
    busH: 36,
    memX: 60,
    memW: 1080,
    memY: 446,
    memH: 344,
    rowY0: 510,
    rowGap: 68,
    rowH: 46,
    mSlotW: 64,
    mSlotGap: 6,
    mSlotX0: 340,
    cSlotW: 28,
    cSlotGap: 2,
  };
  const coreX = (i) => 150 + i * 300;
  const busMid = G.busY + G.busH / 2;
  const memRowW = SLOTS * G.mSlotW + (SLOTS - 1) * G.mSlotGap;
  const memCX = G.mSlotX0 + memRowW / 2;
  const cSlotX0 = (cx) => cx - (SLOTS * G.cSlotW + (SLOTS - 1) * G.cSlotGap) / 2;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, s, cls, extra) {
    const t = el('text', Object.assign({ x, y, class: cls }, extra || {}), parent);
    t.textContent = s;
    return t;
  }
  function setText(node, s) {
    if (node.textContent !== s) node.textContent = s;
  }
  function fmtCount(n) {
    if (n < 1000) return String(n);
    if (n < 1e4) return (n / 1e3).toFixed(1) + 'k';
    if (n < 1e6) return Math.round(n / 1e3) + 'k';
    return (n / 1e6).toFixed(1) + 'M';
  }

  // Polyline interpolation.
  function along(pts, p) {
    p = Math.max(0, Math.min(1, p));
    let total = 0;
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      segs.push(d);
      total += d;
    }
    let target = p * total;
    for (let i = 0; i < segs.length; i++) {
      if (target <= segs[i] || i === segs.length - 1) {
        const f = segs[i] ? target / segs[i] : 1;
        return [
          pts[i][0] + (pts[i + 1][0] - pts[i][0]) * Math.min(1, f),
          pts[i][1] + (pts[i + 1][1] - pts[i][1]) * Math.min(1, f),
        ];
      }
      target -= segs[i];
    }
    return pts[pts.length - 1];
  }

  class View {
    constructor(svg) {
      this.svg = svg;
    }

    build(sim) {
      const svg = this.svg;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`);
      this.variant = sim.variant;
      this.cores = [];
      this.rows = [];
      this.lastOps = sim.cpus.map(() => 0);
      this.flash = sim.cpus.map(() => -1e9);

      const gWires = el('g', { class: 'wires' }, svg);
      const gStatic = el('g', {}, svg);
      this.gFocus = el('g', { class: 'focus' }, svg);
      this.gPackets = el('g', { class: 'packets' }, svg);
      this.focusKey = null;

      // ---- interconnect ----
      el('rect', { x: 40, y: G.busY, width: G.W - 80, height: G.busH, rx: 18, class: 'bus' }, gStatic);
      txt(gStatic, G.W / 2, busMid + 5, 'Coherence interconnect · memory controller', 't-bus', { 'text-anchor': 'middle' });

      // wire: bus → memory
      el('line', { x1: memCX, y1: G.busY + G.busH, x2: memCX, y2: G.memY, class: 'wire' }, gWires);

      // ---- cores + caches ----
      for (let i = 0; i < sim.n; i++) {
        const cx = coreX(i);
        const x = cx - G.coreW / 2;
        const col = CPU_COLORS[i];
        const c = {};
        const g = el('g', {}, gStatic);

        // wires
        c.wire = el('line', { x1: cx, y1: G.coreY + G.coreH, x2: cx, y2: G.cacheY, class: 'wire' }, gWires);
        c.busWire = el('line', { x1: cx, y1: G.cacheY + G.cacheH, x2: cx, y2: G.busY, class: 'wire' }, gWires);

        // core box
        c.box = el('rect', { x, y: G.coreY, width: G.coreW, height: G.coreH, rx: 12, class: 'box core' }, g);
        el('circle', { cx: x + 20, cy: G.coreY + 21, r: 6, fill: col }, g);
        txt(g, x + 33, G.coreY + 26, `Core ${i}`, 't-title');
        c.pill = el('rect', { x: x + G.coreW - 124, y: G.coreY + 10, width: 112, height: 22, rx: 11, class: 'pill' }, g);
        c.pillText = txt(g, x + G.coreW - 68, G.coreY + 25, 'IDLE', 't-pill', { 'text-anchor': 'middle' });
        txt(g, x + 14, G.coreY + 50, `thread ${i}: ${sim.variant.threadDesc(i)}`, 't-mono muted');
        c.ops = txt(g, x + 14, G.coreY + 73, '0 increments', 't-body');
        c.avg = txt(g, x + G.coreW - 14, G.coreY + 73, '', 't-small muted', { 'text-anchor': 'end' });
        c.detail = txt(g, x + 14, G.coreY + 93, '', 't-small muted');
        el('rect', { x: x + 14, y: G.coreY + 100, width: G.coreW - 28, height: 5, rx: 2.5, class: 'track' }, g);
        c.prog = el('rect', { x: x + 14, y: G.coreY + 100, width: 0, height: 5, rx: 2.5 }, g);
        c.busyTxt = txt(g, x + 14, G.coreY + 122, '', 't-small ok');
        c.stallTxt = txt(g, x + G.coreW - 14, G.coreY + 122, '', 't-small bad', { 'text-anchor': 'end' });
        el('rect', { x: x + 14, y: G.coreY + 128, width: G.coreW - 28, height: 7, rx: 3.5, class: 'track' }, g);
        c.utilBusy = el('rect', { x: x + 14, y: G.coreY + 128, width: 0, height: 7, rx: 3.5, class: 'fill-ok' }, g);
        c.utilStall = el('rect', { x: x + 14, y: G.coreY + 128, width: 0, height: 7, rx: 3.5, class: 'fill-bad' }, g);

        // cache box
        const y = G.cacheY;
        el('rect', { x, y, width: G.coreW, height: G.cacheH, rx: 10, class: 'box cache' }, g);
        txt(g, x + 14, y + 22, `L1 cache · core ${i}`, 't-small muted');
        c.badge = el('rect', { x: x + G.coreW - 124, y: y + 8, width: 112, height: 22, rx: 6 }, g);
        c.badgeText = txt(g, x + G.coreW - 68, y + 23, '', 't-badge', { 'text-anchor': 'middle' });
        c.tag = txt(g, x + 14, y + 44, 'empty', 't-mono');
        txt(g, x + G.coreW - 14, y + 44, '64 B = 8 × 8 B', 't-small muted', { 'text-anchor': 'end' });
        c.lineG = el('g', {}, g);
        c.slots = [];
        const sx0 = cSlotX0(cx);
        for (let s = 0; s < SLOTS; s++) {
          const sx = sx0 + s * (G.cSlotW + G.cSlotGap);
          const r = el('rect', { x: sx, y: y + 54, width: G.cSlotW, height: 34, rx: 4, class: 'slot' }, c.lineG);
          const v = txt(c.lineG, sx + G.cSlotW / 2, y + 75, '', 't-slot', { 'text-anchor': 'middle' });
          const lab = txt(g, sx + G.cSlotW / 2, y + 102, '', 't-tiny muted', { 'text-anchor': 'middle' });
          c.slots.push({ r, v, lab, x: sx });
        }
        c.flashRect = el('rect', { x: 0, y: y + 52, width: G.cSlotW + 4, height: 38, rx: 6, class: 'flash', opacity: 0 }, g);
        c.strike = el('line', { x1: sx0 - 4, y1: y + 71, x2: sx0 + SLOTS * (G.cSlotW + G.cSlotGap) + 2, y2: y + 71, class: 'strike' }, g);
        this.cores.push(c);
      }

      // ---- main memory ----
      const gm = el('g', {}, gStatic);
      el('rect', { x: G.memX, y: G.memY, width: G.memW, height: G.memH, rx: 14, class: 'box mem' }, gm);
      txt(gm, G.memX + 22, G.memY + 32, 'Main memory (DRAM)', 't-title');
      this.memLat = txt(gm, G.memX + G.memW - 22, G.memY + 32, '', 't-small muted', { 'text-anchor': 'end' });
      sim.variant.memoryLines.forEach((line, r) => {
        const y = G.rowY0 + r * G.rowGap;
        const row = { line, y, slots: [] };
        row.hl = el('rect', { x: G.mSlotX0 - 8, y: y - 8, width: memRowW + 16, height: G.rowH + 16, rx: 10, class: 'rowhl', opacity: 0 }, gm);
        txt(gm, G.mSlotX0 - 16, y + 20, hex(line), 't-mono', { 'text-anchor': 'end' });
        txt(gm, G.mSlotX0 - 16, y + 36, 'cache line', 't-tiny muted', { 'text-anchor': 'end' });
        for (let s = 0; s < SLOTS; s++) {
          const sx = G.mSlotX0 + s * (G.mSlotW + G.mSlotGap);
          const owner = sim.ownerOf(line, s);
          const r2 = el('rect', { x: sx, y, width: G.mSlotW, height: G.rowH, rx: 6, class: 'slot' }, gm);
          if (owner != null) {
            r2.setAttribute('fill', CPU_COLORS[owner]);
            r2.setAttribute('class', 'slot owned');
          }
          const lab = owner != null ? sim.variant.slotName(owner) : sim.variant.fillerName(line, s);
          txt(gm, sx + G.mSlotW / 2, y + 15, lab, owner != null ? 't-tiny on-color' : 't-tiny muted', { 'text-anchor': 'middle' });
          const v = txt(gm, sx + G.mSlotW / 2, y + 36, owner != null ? '0' : '', owner != null ? 't-memval on-color' : 't-memval muted', { 'text-anchor': 'middle' });
          row.slots.push({ v, owner });
        }
        row.stale = txt(gm, G.mSlotX0 + memRowW + 18, y + 28, '', 't-small stale');
        this.rows.push(row);
      });
      txt(gm, G.mSlotX0, G.memY + G.memH - 14, 'Byte offset within each line: 0 · 8 · 16 · 24 · 32 · 40 · 48 · 56', 't-tiny muted');
    }

    // ---- spotlight (used by the guided tour) ----

    /** Named diagram regions in viewBox units. */
    region(name) {
      const [kind, arg] = name.split(':');
      const pad = 8;
      if (kind === 'cpu') {
        const x = coreX(+arg) - G.coreW / 2;
        return { x: x - pad, y: G.coreY - pad, w: G.coreW + pad * 2, h: G.cacheY + G.cacheH - G.coreY + pad * 2 };
      }
      if (kind === 'core') {
        const x = coreX(+arg) - G.coreW / 2;
        return { x: x - pad, y: G.coreY - pad, w: G.coreW + pad * 2, h: G.coreH + pad * 2 };
      }
      if (kind === 'cache') {
        const x = coreX(+arg) - G.coreW / 2;
        return { x: x - pad, y: G.cacheY - pad, w: G.coreW + pad * 2, h: G.cacheH + pad * 2 };
      }
      if (kind === 'bus') return { x: 40 - pad, y: G.busY - pad, w: G.W - 80 + pad * 2, h: G.busH + pad * 2 };
      if (kind === 'memory') return { x: G.memX - pad, y: G.memY - pad, w: G.memW + pad * 2, h: G.memH + pad * 2 };
      if (kind === 'row') {
        const row = this.rows.find((r) => r.line === parseInt(arg, 16));
        if (!row) return null;
        return { x: G.mSlotX0 - 120, y: row.y - 14, w: memRowW + 120 + 230, h: G.rowH + 28 };
      }
      return null;
    }

    /** Dim everything except the named regions. Pass null to clear. */
    setFocus(names) {
      const key = names ? names.join(',') : '';
      if (key === this.focusKey) return;
      this.focusKey = key;
      const g = this.gFocus;
      while (g.firstChild) g.removeChild(g.firstChild);
      if (!names || !names.length) return;
      const rects = names.map((n) => this.region(n)).filter(Boolean);
      const id = 'focus-mask-' + Math.random().toString(36).slice(2, 8);
      const defs = el('defs', {}, g);
      const mask = el('mask', { id }, defs);
      el('rect', { x: 0, y: 0, width: G.W, height: G.H, fill: '#fff' }, mask);
      for (const r of rects) el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 16, fill: '#000' }, mask);
      el('rect', { x: 0, y: 0, width: G.W, height: G.H, class: 'focus-dim', mask: `url(#${id})` }, g);
      for (const r of rects) el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 16, class: 'focus-ring' }, g);
    }

    // ---- per frame ----
    render(sim, now) {
      const L = sim.lat;
      setText(this.memLat, `read a line ≈ ${L.memRead} ns · write back ≈ ${L.writeback} ns`);

      // cores
      sim.cpus.forEach((cpu, i) => {
        const c = this.cores[i];
        const col = CPU_COLORS[i];
        if (cpu.ops !== this.lastOps[i]) {
          this.lastOps[i] = cpu.ops;
          this.flash[i] = now;
        }

        // pill
        let pillCls = 'pill idle';
        let pillTxt = 'IDLE';
        if (cpu.status === 'exec') {
          pillCls = 'pill exec';
          pillTxt = 'EXECUTING';
        } else if (cpu.status === 'stall') {
          pillCls = 'pill stall';
          pillTxt = 'STALLED ' + NS.fmtNs(sim.time - cpu.stallSince);
        }
        c.pill.setAttribute('class', pillCls);
        setText(c.pillText, pillTxt);
        c.box.setAttribute('class', 'box core' + (cpu.status === 'stall' ? ' stalled' : ''));

        setText(c.ops, `${cpu.ops.toLocaleString()} increment${cpu.ops === 1 ? '' : 's'}`);
        setText(c.avg, cpu.ops ? `${NS.fmtNs(sim.time / cpu.ops)} per ++` : '');

        // detail + phase progress
        let detail = '';
        let prog = 0;
        let progCol = 'var(--muted)';
        const w = cpu.waiting;
        if (cpu.status === 'exec') {
          detail = `L1 hit: write to own cache (${L.l1} ns)`;
          prog = 1;
          progCol = 'var(--ok)';
        } else if (w) {
          const span = w.end != null ? `  ${Math.min(Math.round(sim.time - w.start), w.end - w.start)}/${Math.round(w.end - w.start)} ns` : '';
          if (w.phase === 'queued') {
            const lock = sim.locks.get(w.line);
            detail = lock && lock.owner != null && lock.owner !== i ? `Waiting: Core ${lock.owner} is using line ${hex(w.line)}` : `Waiting for line ${hex(w.line)}`;
          } else if (w.phase === 'invalidate') detail = 'Sending invalidations' + span;
          else if (w.phase === 'snoop') detail = 'Snooping other caches' + span;
          else if (w.phase === 'writeback') detail = `Core ${w.from} writing line back to DRAM` + span;
          else if (w.phase === 'fetch') detail = 'Fetching line from DRAM' + span;
          else if (w.phase === 'evict') detail = 'Evicting dirty line' + span;
          if (w.end != null) {
            prog = (sim.time - w.start) / (w.end - w.start);
            progCol = w.phase === 'fetch' ? KIND.fetch.color : w.phase === 'writeback' || w.phase === 'evict' ? KIND.wb.color : KIND.inv.color;
          }
        }
        setText(c.detail, detail);
        c.prog.setAttribute('width', Math.max(0, Math.min(1, prog)) * (G.coreW - 28));
        c.prog.setAttribute('fill', progCol);

        // utilization
        const t = Math.max(sim.time, 1e-9);
        const busy = sim.liveExec(cpu) / t;
        const stall = sim.liveStall(cpu) / t;
        const bw = G.coreW - 28;
        const x0 = coreX(i) - G.coreW / 2 + 14;
        c.utilBusy.setAttribute('width', busy * bw);
        c.utilStall.setAttribute('x', x0 + busy * bw);
        c.utilStall.setAttribute('width', stall * bw);
        setText(c.busyTxt, sim.time > 0 ? `useful work ${(busy * 100).toFixed(busy < 0.1 ? 1 : 0)}%` : '');
        setText(c.stallTxt, sim.time > 0 ? `stalled ${(stall * 100).toFixed(0)}%` : '');

        // cache line
        const ln = cpu.line;
        const st = ln ? ln.state : 'I';
        const sInfo = STATES[st];
        const pending = ln && ln.pendingInv;
        const blink = pending && Math.floor(now / 180) % 2 === 0;
        c.badge.setAttribute('fill', blink ? KIND.inv.color : sInfo.color);
        setText(c.badgeText, ln ? (pending ? 'INVALIDATING' : `${st} · ${sInfo.name}`) : 'empty');
        setText(c.tag, ln ? `tag ${hex(ln.addr)}` : 'no line cached');
        const invalid = !ln || st === 'I';
        c.lineG.setAttribute('opacity', ln && invalid ? 0.32 : 1);
        c.strike.setAttribute('opacity', ln && invalid ? 1 : 0);

        c.slots.forEach((s, k) => {
          const owner = ln ? sim.ownerOf(ln.addr, k) : null;
          if (ln && owner != null) {
            s.r.setAttribute('fill', CPU_COLORS[owner]);
            s.r.setAttribute('class', 'slot owned' + (owner === i ? ' mine' : ''));
            setText(s.v, fmtCount(ln.data[k]));
            s.v.setAttribute('class', 't-slot on-color');
          } else {
            s.r.removeAttribute('fill');
            s.r.setAttribute('class', 'slot');
            setText(s.v, '');
          }
          const lab = ln ? (owner != null ? sim.variant.slotName(owner) : sim.variant.fillerName(ln.addr, k)) : '';
          setText(s.lab, lab);
        });

        // hit flash on own slot + wire glow
        const myAddr = sim.variant.addrFor(i);
        const mySlot = NS.mem.slotOf(myAddr);
        const fa = Math.max(0, 1 - (now - this.flash[i]) / 260);
        c.flashRect.setAttribute('x', c.slots[mySlot].x - 2);
        c.flashRect.setAttribute('opacity', ln && ln.addr === NS.mem.lineOf(myAddr) ? fa : 0);
        c.flashRect.setAttribute('stroke', col);
        c.wire.setAttribute('class', cpu.status === 'exec' ? 'wire hot' : 'wire');
        c.wire.style.stroke = cpu.status === 'exec' ? col : '';
      });

      // memory rows
      const active = new Map();
      for (const a of sim.anims) {
        if ((a.kind === 'wb' || a.kind === 'fetch') && a.start <= sim.time) active.set(a.line, a.kind);
      }
      for (const row of this.rows) {
        const data = sim.memory.get(row.line);
        const holder = sim.cpus.find((c) => c.line && c.line.addr === row.line && c.line.state === 'M');
        row.slots.forEach((s, k) => {
          if (s.owner != null) setText(s.v, fmtCount(data[k]));
          s.v.style.opacity = holder && s.owner != null && holder.line.data[k] !== data[k] ? 0.45 : 1;
        });
        setText(row.stale, holder ? `stale: Core ${holder.id} has newer copy` : '');
        const k = active.get(row.line);
        row.hl.setAttribute('opacity', k ? 1 : 0);
        if (k) row.hl.setAttribute('stroke', KIND[k].color);
      }

      this.drawPackets(sim);
    }

    drawPackets(sim) {
      const g = this.gPackets;
      while (g.firstChild) g.removeChild(g.firstChild);
      const rowOf = (line) => this.rows.find((r) => r.line === line);
      const cacheBottom = (i) => [coreX(i), G.cacheY + G.cacheH];

      for (const a of sim.anims) {
        if (a.start > sim.time) continue;
        const p = (sim.time - a.start) / Math.max(1e-9, a.end - a.start);

        if (a.kind === 'hit') {
          // Ride the wire between core and cache: down to L1, then back up.
          const cx = coreX(a.cpu);
          const r = 5;
          const top = [cx, G.coreY + G.coreH + r];
          const bot = [cx, G.cacheY - r];
          const pos = p < 0.5 ? along([top, bot], p * 2) : along([bot, top], (p - 0.5) * 2);
          el('circle', { cx: pos[0], cy: pos[1], r: 5, fill: CPU_COLORS[a.cpu], class: 'dot' }, g);
          continue;
        }

        if (a.kind === 'inv' || a.kind === 'snoop') {
          const from = cacheBottom(a.from);
          const to = cacheBottom(a.to);
          const pts = [from, [from[0], busMid], [to[0], busMid], to];
          const pos = along(pts, p);
          const pg = el('g', { transform: `translate(${pos[0]},${pos[1]})` }, g);
          el('circle', { r: 15, fill: KIND[a.kind].color, class: 'pkt' }, pg);
          txt(pg, 0, 3.5, KIND[a.kind].label, 't-pkt', { 'text-anchor': 'middle' });
          continue;
        }

        if (a.kind === 'wb' || a.kind === 'fetch') {
          const row = rowOf(a.line);
          const memPt = row ? [memCX, row.y + G.rowH / 2] : [memCX, G.memY + 40];
          const cpuId = a.kind === 'wb' ? a.from : a.to;
          const cb = cacheBottom(cpuId);
          let pts = [cb, [cb[0], busMid], [memCX, busMid], [memCX, G.memY + 6], memPt];
          if (a.kind === 'fetch') pts = pts.reverse();
          const pos = along(pts, p);
          const pg = el('g', { transform: `translate(${pos[0]},${pos[1]})` }, g);
          const col = KIND[a.kind].color;
          el('rect', { x: -42, y: -11, width: 84, height: 22, rx: 5, class: 'pkt-bg', stroke: col }, pg);
          for (let s = 0; s < SLOTS; s++) {
            const owner = sim.ownerOf(a.line, s);
            el('rect', { x: -38 + s * 9.6, y: -6, width: 8.4, height: 12, rx: 1.5, fill: owner != null ? CPU_COLORS[owner] : 'var(--slot-empty)' }, pg);
          }
          const lab = txt(pg, 0, -17, KIND[a.kind].label, 't-pktlab', { 'text-anchor': 'middle' });
          lab.setAttribute('fill', col);
        }
      }
    }
  }

  NS.View = View;
})((window.CPUViz = window.CPUViz || {}));
