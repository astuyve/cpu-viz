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
      const allLines = sim.variant.memoryLines;
      const showValues = sim.variant.showValues !== false;
      // Up to 4 lines: roomy single column. Up to 16: compact two-column grid.
      // More: a sliding window of each core's next 4 lines (rows filled per frame).
      const windowed = allLines.length > 16;
      const lines = windowed ? new Array(16).fill(null) : allLines;
      const compact = lines.length > 4;
      this.windowed = windowed;
      this.lastLine = allLines[allLines.length - 1];
      const geo = compact
        ? { compact, perCol: Math.ceil(lines.length / 2), x0s: [170, 690], y0: G.memY + 52, gap: 36, h: 28, sw: 50, sg: 4 }
        : { compact, perCol: lines.length, x0s: [G.mSlotX0], y0: G.rowY0, gap: G.rowGap, h: G.rowH, sw: G.mSlotW, sg: G.mSlotGap };
      this.memGeo = geo;
      lines.forEach((line, r) => {
        const x0 = geo.x0s[Math.floor(r / geo.perCol)];
        const y = geo.y0 + (r % geo.perCol) * geo.gap;
        const rowW = SLOTS * geo.sw + (SLOTS - 1) * geo.sg;
        const row = { line, y, x0, w: rowW, h: geo.h, cx: x0 + rowW / 2, slots: [], core: Math.floor(r / 4), j: r % 4 };
        const hp = compact ? 4 : 8;
        row.hl = el('rect', { x: x0 - hp, y: y - hp, width: rowW + hp * 2, height: geo.h + hp * 2, rx: compact ? 7 : 10, class: 'rowhl', opacity: 0 }, gm);
        if (windowed && row.j === 0) {
          // colour bar marking which core's stream this group of 4 rows follows
          el('rect', { x: x0 - 82, y: y - 2, width: 4, height: 3 * geo.gap + geo.h + 4, rx: 2, fill: CPU_COLORS[row.core] }, gm);
        }
        if (compact) {
          row.addrText = txt(gm, x0 - 10, y + geo.h / 2 + 4, line == null ? '' : hex(line), 't-mono', { 'text-anchor': 'end' });
        } else {
          txt(gm, x0 - 16, y + 20, hex(line), 't-mono', { 'text-anchor': 'end' });
          txt(gm, x0 - 16, y + 36, 'cache line', 't-tiny muted', { 'text-anchor': 'end' });
        }
        for (let s = 0; s < SLOTS; s++) {
          const sx = x0 + s * (geo.sw + geo.sg);
          const look = line == null ? { label: '', fill: null } : this.slotLook(sim, line, s);
          const r2 = el('rect', { x: sx, y, width: geo.sw, height: geo.h, rx: compact ? 4 : 6, class: look.fill ? 'slot owned' : 'slot' }, gm);
          if (look.fill) r2.setAttribute('fill', look.fill);
          let v;
          if (showValues) {
            const owned = look.owner != null;
            txt(gm, sx + geo.sw / 2, y + 15, look.label, owned ? 't-tiny on-color' : 't-tiny muted', { 'text-anchor': 'middle' });
            v = txt(gm, sx + geo.sw / 2, y + 36, owned ? '0' : '', owned ? 't-memval on-color' : 't-memval muted', { 'text-anchor': 'middle' });
          } else {
            v = txt(gm, sx + geo.sw / 2, y + geo.h / 2 + 4, look.label, 't-tiny t-strong', { 'text-anchor': 'middle' });
            v.style.fill = look.ink || 'var(--muted)';
          }
          const ring = el('rect', { x: sx - 3, y: y - 3, width: geo.sw + 6, height: geo.h + 6, rx: 7, class: 'landing', opacity: 0 }, gm);
          row.slots.push({ r: r2, v, owner: look.owner != null ? look.owner : null, ring, cx: sx + geo.sw / 2 });
        }
        row.stale = txt(gm, x0 + rowW + 18, y + 28, '', 't-small stale');
        this.rows.push(row);
      });
      if (windowed) {
        txt(gm, G.memX + 200, G.memY + 32, `each core’s next 4 of ${allLines.length.toLocaleString()} lines`, 't-small muted');
      }
      if (!compact) {
        txt(gm, G.mSlotX0, G.memY + G.memH - 14, 'Byte offset within each line: 0 · 8 · 16 · 24 · 32 · 40 · 48 · 56', 't-tiny muted');
      }
    }

    /** Windowed memory: point each row at its core's current line + j. */
    updateWindow(sim) {
      for (const row of this.rows) {
        const cpu = sim.cpus[row.core];
        const op = cpu.op || sim.variant.nextOp(row.core, 0);
        let line = op ? NS.mem.lineOf(op.addr) + row.j * 64 : null;
        if (line != null && line > this.lastLine) line = null;
        if (line === row.line) continue;
        row.line = line;
        setText(row.addrText, line == null ? '' : hex(line));
        row.slots.forEach((s, k) => {
          const look = line == null ? { label: '', fill: null } : this.slotLook(sim, line, k);
          if (look.fill) {
            s.r.setAttribute('fill', look.fill);
            s.r.setAttribute('class', 'slot owned');
          } else {
            s.r.removeAttribute('fill');
            s.r.setAttribute('class', 'slot');
          }
          setText(s.v, look.label);
          s.v.style.fill = look.ink || 'var(--muted)';
        });
      }
    }

    /**
     * How to draw one 8-byte slot: { label, short?, fill?, ink?, owner? }.
     * Scenarios can supply variant.slotStyle(line, slot); otherwise slots are
     * coloured by the core whose variable lives there.
     */
    slotLook(sim, line, k) {
      const v = sim.variant;
      if (v.slotStyle) return v.slotStyle(line, k);
      const owner = sim.ownerOf(line, k);
      if (owner == null) return { label: v.fillerName(line, k), fill: null, owner: null };
      return { label: v.slotName(owner), fill: CPU_COLORS[owner], ink: '#fff', owner };
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
        if (this.memGeo.compact) return { x: row.x0 - 70, y: row.y - 8, w: row.w + 80, h: row.h + 16 };
        return { x: row.x0 - 120, y: row.y - 14, w: row.w + 120 + 230, h: row.h + 28 };
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
      const U = sim.variant.unit || { one: 'increment', many: 'increments', per: '++' };
      const showValues = sim.variant.showValues !== false;
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
        } else if (cpu.status === 'done') {
          pillCls = 'pill done';
          pillTxt = 'DONE';
        }
        c.pill.setAttribute('class', pillCls);
        setText(c.pillText, pillTxt);
        c.box.setAttribute('class', 'box core' + (cpu.status === 'stall' ? ' stalled' : ''));

        const elapsed = cpu.doneAt != null ? cpu.doneAt : sim.time;
        setText(c.ops, `${cpu.ops.toLocaleString()} ${cpu.ops === 1 ? U.one : U.many}`);
        setText(c.avg, cpu.ops ? `${NS.fmtNs(elapsed / cpu.ops)} per ${U.per}` : '');

        // detail + phase progress
        let detail = '';
        let prog = 0;
        let progCol = 'var(--muted)';
        const w = cpu.waiting;
        if (cpu.status === 'done') {
          detail = `Finished in ${NS.fmtNs(cpu.doneAt)}`;
          prog = 1;
          progCol = 'var(--accent)';
        } else if (cpu.status === 'exec') {
          const verb = cpu.op && cpu.op.kind === 'read' ? 'read from' : 'write to';
          detail = `L1 hit: ${verb} own cache (${L.l1} ns)`;
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
        const t = Math.max(elapsed, 1e-9);
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
          const look = ln ? this.slotLook(sim, ln.addr, k) : null;
          if (look && look.fill) {
            s.r.setAttribute('fill', look.fill);
            s.r.setAttribute('class', 'slot owned' + (look.owner === i ? ' mine' : ''));
          } else {
            s.r.removeAttribute('fill');
            s.r.setAttribute('class', 'slot');
          }
          if (!look) {
            setText(s.v, '');
          } else if (showValues) {
            setText(s.v, look.owner != null ? fmtCount(ln.data[k]) : '');
            s.v.setAttribute('class', 't-slot on-color');
          } else {
            setText(s.v, look.label);
            s.v.setAttribute('class', 't-slot');
            s.v.style.fill = look.ink || 'var(--muted)';
            // shrink long labels (e.g. x10239) to fit the 28-unit cache slot
            const n = look.label.length;
            s.v.style.fontSize = n <= 3 ? '' : n === 4 ? '9px' : n === 5 ? '7.5px' : '6.5px';
          }
          setText(s.lab, look && showValues ? look.label : '');
        });

        // flash the slot the core just accessed + wire glow
        const op = cpu.op;
        const fa = Math.max(0, 1 - (now - this.flash[i]) / 260);
        if (op && ln && ln.addr === NS.mem.lineOf(op.addr)) {
          c.flashRect.setAttribute('x', c.slots[NS.mem.slotOf(op.addr)].x - 2);
          c.flashRect.setAttribute('opacity', fa);
        } else {
          c.flashRect.setAttribute('opacity', 0);
        }
        c.flashRect.setAttribute('stroke', col);
        c.wire.setAttribute('class', cpu.status === 'exec' ? 'wire hot' : 'wire');
        c.wire.style.stroke = cpu.status === 'exec' ? col : '';
      });

      // memory rows
      if (this.windowed) this.updateWindow(sim);
      const active = new Map();
      for (const a of sim.anims) {
        if ((a.kind === 'wb' || a.kind === 'fetch') && a.start <= sim.time) active.set(a.line, a.kind);
      }
      for (const row of this.rows) {
        const data = sim.memory.get(row.line);
        const holder = sim.cpus.find((c) => c.line && c.line.addr === row.line && c.line.state === 'M');
        row.slots.forEach((s, k) => {
          if (showValues && s.owner != null) setText(s.v, fmtCount(data[k]));
          s.v.style.opacity = holder && s.owner != null && holder.line.data[k] !== data[k] ? 0.45 : 1;
        });
        setText(row.stale, holder ? `stale: Core ${holder.id} has newer copy` : '');
        // pulse the slots a write-back just landed on (fades over 40 ns of sim time)
        const w = sim.memWrites.get(row.line);
        const age = w ? sim.time - w.t : Infinity;
        row.slots.forEach((s, k) => {
          const on = w && w.slots.includes(k) && age < 40;
          s.ring.setAttribute('opacity', on ? 1 - age / 40 : 0);
        });
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
          const memPt = row ? [memCX, row.y + row.h / 2] : [memCX, G.memY + 40];
          const cpuId = a.kind === 'wb' ? a.from : a.to;
          const cb = cacheBottom(cpuId);
          let pts;
          if (!row && this.memGeo.compact) {
            pts = [cb, [cb[0], G.memY + 24]];
            if (a.kind === 'fetch') pts = pts.reverse();
          } else if (row && this.memGeo.compact) {
            // Compact grid: each core gets its own vertical channel, so
            // simultaneous fetches don't pile up on one wire.
            if (a.kind === 'wb' && p >= 1) continue;
            const lane = G.memY - 26; // gap between interconnect and memory box
            const tx = a.kind === 'wb' && a.slots && a.slots.length ? row.slots[a.slots[0]].cx : row.cx;
            pts = [cb, [cb[0], lane], [tx, lane], [tx, row.y + row.h / 2]];
            if (a.kind === 'fetch') pts = pts.reverse();
          } else if (a.kind === 'wb' && row) {
            // Write-back: dock onto the slot(s) that actually changed (e.g. c[0]),
            // then vanish; the slot pulses as the new value lands.
            if (p >= 1) continue;
            const slots = a.slots && a.slots.length ? a.slots : [0];
            const tx = slots.reduce((sum, k) => sum + row.slots[k].cx, 0) / slots.length;
            const lane = row.y - 18;
            pts = [cb, [cb[0], busMid], [memCX, busMid], [memCX, lane], [tx, lane], [tx, row.y + row.h / 2]];
          } else {
            pts = [cb, [cb[0], busMid], [memCX, busMid], [memCX, G.memY + 6], memPt];
            if (a.kind === 'fetch') pts = pts.reverse();
          }
          const pos = along(pts, p);
          const pg = el('g', { transform: `translate(${pos[0]},${pos[1]})` }, g);
          const col = KIND[a.kind].color;
          el('rect', { x: -42, y: -11, width: 84, height: 22, rx: 5, class: 'pkt-bg', stroke: col }, pg);
          for (let s = 0; s < SLOTS; s++) {
            const look = this.slotLook(sim, a.line, s);
            el('rect', { x: -38 + s * 9.6, y: -6, width: 8.4, height: 12, rx: 1.5, fill: look.fill || 'var(--slot-empty)' }, pg);
          }
          const lab = txt(pg, 0, -17, KIND[a.kind].label, 't-pktlab', { 'text-anchor': 'middle' });
          lab.setAttribute('fill', col);
        }
      }
    }
  }

  NS.View = View;
})((window.CPUViz = window.CPUViz || {}));
