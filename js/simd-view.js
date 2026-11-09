/*
 * CPU Viz — SVG renderer for the SIMD scenario.
 *
 * Layout: the input bytes in memory across the top, the instruction stream on
 * the left and the register file on the right. Vector registers are drawn as
 * 16 byte lanes in aligned columns, so a lane-wise instruction lights up one
 * column per byte, and the set table's bits are drawn as a grid under xmm5,
 * whose lanes are its columns.
 *
 * Time is in instructions: during [k, k+1] instruction k executes, and the
 * state at time k+1 is the state right after it retired.
 */
(function (NS) {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';

  const G = {
    W: 1000,
    H: 770,
    // memory strip
    memX: 52,
    memY: 42,
    cellW: 16,
    cellH: 28,
    // instruction listing
    codeX: 16,
    codeY: 108,
    codeW: 392,
    lineH: 15,
    // registers
    regX: 424,
    regW: 560,
    gprY: 148,
    gprPitch: 32,
    byteW: 26,
    laneX: 500,
    laneW: 29,
    laneH: 28,
    gridH: 13,
  };
  const PANEL_H = G.H - G.codeY - 12;
  const VEC_TOP = 270;
  const ROWS = [
    { reg: 'xmm0', y: VEC_TOP + 22, role: 'input v' },
    { reg: 'xmm7', y: VEC_TOP + 58, role: '0x0F' },
    { reg: 'xmm2', y: VEC_TOP + 94 },
    { reg: 'xmm1', y: VEC_TOP + 130 },
    { reg: 'mask', y: VEC_TOP + 166, h: 18 },
    { reg: 'xmm6', y: VEC_TOP + 196, role: 'POW2' },
    { reg: 'xmm5', y: VEC_TOP + 232, role: 'table' },
  ];
  const ROW = {};
  ROWS.forEach((r) => (ROW[r.reg] = r));
  const GRID_Y = ROW.xmm5.y + G.laneH + 6;
  const laneCX = (k) => G.laneX + k * G.laneW + G.laneW / 2;
  const cellX = (i) => G.memX + i * G.cellW;

  // The role a register plays after each instruction writes it.
  const ROLE = {
    v_lo: 'lo', v_row: 'row', v_and: 'row & bit', v_eq: 'match',
    v_srl: 'v >> 4', v_hi: 'hi', v_bit: 'bit',
  };
  const GPR_ROLE = {
    s_load: (v) => `b = ${chr(v)}`,
    s_shr: (v) => `hi = ${v}`,
    s_mov: (v) => `b = ${chr(v)}`,
    s_and: (v) => `lo = ${v}`,
    s_row: (v) => `row = 0b${v.toString(2).padStart(8, '0')}`,
    s_or: (v) => `row | 0xFF00`,
    s_inc: (v) => `i = ${v}`,
    v_add: (v) => `i = ${v}`,
    t_mov: (v) => `i = ${v}`,
    v_msk: (v) => `mask = 0x${v.toString(16).padStart(4, '0')}`,
    f_tz: (v) => `lane = ${v}`,
    f_add: (v) => `index = ${v}`,
  };

  function chr(b) {
    return b === 0x20 ? "' '" : `'${String.fromCharCode(b)}'`;
  }
  const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();
  const show = (b) => (b === 0x20 ? '␠' : b < 0x20 || b >= 0x7f ? '' : String.fromCharCode(b));

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
  function setCls(node, c) {
    if (node.getAttribute('class') !== c) node.setAttribute('class', c);
  }
  function setAttr(node, k, v) {
    v = String(v);
    if (node.getAttribute(k) !== v) node.setAttribute(k, v);
  }

  class SimdView {
    constructor(svg) {
      this.svg = svg;
    }

    build(sim) {
      const svg = this.svg;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`);
      this.sim = sim;
      const vector = sim.variant.id === 'simd';
      this.vector = vector;
      const gStatic = el('g', {}, svg);

      // ---- memory strip ----
      txt(gStatic, G.memX, 15, `Memory · the query string, ${sim.bytes.length} bytes`, 't-small muted');
      this.cells = sim.bytes.map((b, i) => {
        const x = cellX(i);
        const r = el('rect', { x: x + 0.5, y: G.memY, width: G.cellW - 1, height: G.cellH, rx: 2, class: 'sv-cell' }, gStatic);
        const t = txt(gStatic, x + G.cellW / 2, G.memY + 18, show(b), 'sv-char', { 'text-anchor': 'middle' });
        if (i % 8 === 0) txt(gStatic, x + 1, G.memY + G.cellH + 12, String(i), 't-tiny muted');
        return { r, t };
      });
      this.gWin = el('g', {}, svg);
      this.winRect = el('rect', { y: G.memY - 4, height: G.cellH + 8, rx: 4, class: 'sv-win' }, this.gWin);
      this.winLab = txt(this.gWin, 0, G.memY - 8, '', 't-tiny sv-winlab', { 'text-anchor': 'middle' });
      this.foundLab = txt(svg, 0, G.memY + G.cellH + 25, '', 't-tiny sv-found', { 'text-anchor': 'middle' });

      // ---- instruction listing ----
      el('rect', { x: G.codeX, y: G.codeY, width: G.codeW, height: PANEL_H, rx: 12, class: 'box' }, gStatic);
      txt(gStatic, G.codeX + 14, G.codeY + 22, 'Instructions', 't-body');
      txt(gStatic, G.codeX + G.codeW - 14, G.codeY + 22, 'times run', 't-tiny muted', { 'text-anchor': 'end' });
      this.pcBar = el('rect', { x: G.codeX + 6, width: G.codeW - 12, height: G.lineH + 1, rx: 4, class: 'sv-pc' }, gStatic);
      this.lines = sim.program.map((l, i) => {
        const y = this.lineY(i) + 11;
        const g = el('g', {}, gStatic);
        if (l.label) txt(g, G.codeX + 14, y, l.label, 'sv-asm sv-label');
        if (l.asm) txt(g, G.codeX + 26, y, l.asm, 'sv-asm');
        if (l.cmt) txt(g, l.asm || l.label ? G.codeX + 226 : G.codeX + 14, y, l.asm || l.label ? `; ${l.cmt}` : `; ${l.cmt}`, 'sv-asm sv-cmt');
        const cnt = l.id ? txt(g, G.codeX + G.codeW - 14, y, '', 'sv-asm sv-cnt', { 'text-anchor': 'end' }) : null;
        return { g, cnt };
      });

      // ---- register file ----
      el('rect', { x: G.regX, y: G.codeY, width: G.regW, height: PANEL_H, rx: 12, class: 'box' }, gStatic);
      txt(gStatic, G.regX + 14, G.codeY + 22, 'Registers', 't-body');
      txt(gStatic, G.regX + 92, G.codeY + 22, 'general purpose · 64 bits = 8 bytes', 't-tiny muted');
      this.gpr = ['rcx', 'rax', 'rdx'].map((name, j) => {
        const y = G.gprY + j * G.gprPitch;
        txt(gStatic, G.regX + 16, y + 18, name, 't-strong sv-reg');
        const cells = [];
        for (let k = 0; k < 8; k++) {
          const x = G.laneX + k * G.byteW;
          const r = el('rect', { x, y, width: G.byteW - 2, height: 24, rx: 3, class: 'sv-lane' }, gStatic);
          const t = txt(gStatic, x + (G.byteW - 2) / 2, y + 16, '', 'sv-hex', { 'text-anchor': 'middle' });
          cells.push({ r, t });
        }
        const role = txt(gStatic, G.laneX + 8 * G.byteW + 10, y + 16, '', 't-small sv-role');
        const used = txt(gStatic, G.regX + G.regW - 14, y + 16, '', 't-tiny muted', { 'text-anchor': 'end' });
        const frame = el('rect', { x: G.laneX - 3, y: y - 3, width: 8 * G.byteW + 4, height: 30, rx: 5, class: 'sv-frame' }, gStatic);
        return { name, y, cells, role, used, frame };
      });
      this.flag = txt(gStatic, G.regX + 16, G.gprY + 3 * G.gprPitch + 10, '', 't-tiny muted');

      // vector registers
      txt(gStatic, G.regX + 14, VEC_TOP, 'Vector registers', 't-body');
      txt(gStatic, G.regX + 138, VEC_TOP, '128 bits = 16 lanes of 1 byte', 't-tiny muted');
      for (let k = 0; k < 16; k++) txt(gStatic, laneCX(k), VEC_TOP + 15, String(k), 't-tiny muted', { 'text-anchor': 'middle' });
      txt(gStatic, G.laneX - 6, VEC_TOP + 15, 'lane', 't-tiny muted', { 'text-anchor': 'end' });
      this.gLinks = el('g', { class: 'sv-links' }, svg); // pshufb / movemask lines, above static
      this.vec = {};
      for (const row of ROWS) {
        const h = row.h || G.laneH;
        const g = el('g', {}, gStatic);
        const name = row.reg === 'mask' ? 'eax' : row.reg;
        txt(g, G.regX + 16, row.y + (h > 20 ? 13 : 13), name, 't-strong sv-reg');
        const role = txt(g, G.regX + 16, row.y + 25, '', 't-tiny muted');
        const lanes = [];
        for (let k = 0; k < 16; k++) {
          const x = G.laneX + k * G.laneW;
          const r = el('rect', { x, y: row.y, width: G.laneW - 2, height: h, rx: 3, class: 'sv-lane' }, g);
          const t = txt(g, x + (G.laneW - 2) / 2, row.y + (row.reg === 'xmm0' ? 12 : h / 2 + 4), '', row.reg === 'mask' ? 'sv-bit' : 'sv-hex', { 'text-anchor': 'middle' });
          const t2 = row.reg === 'xmm0' ? txt(g, x + (G.laneW - 2) / 2, row.y + 24, '', 'sv-hex sv-sub', { 'text-anchor': 'middle' }) : null;
          lanes.push({ r, t, t2 });
        }
        const frame = el('rect', { x: G.laneX - 3, y: row.y - 3, width: 16 * G.laneW + 4, height: h + 6, rx: 5, class: 'sv-frame' }, g);
        const idle = txt(g, G.laneX + 8 * G.laneW, row.y + h / 2 + 4, '', 't-tiny muted', { 'text-anchor': 'middle' });
        this.vec[row.reg] = { row, g, lanes, role, frame, idle, h };
      }

      // set grid under xmm5 (its lanes are the grid's columns)
      this.grid = [];
      for (let hi = 0; hi < 8; hi++) {
        txt(gStatic, G.laneX - 6, GRID_Y + hi * G.gridH + 10, `hi ${hi}`, 't-tiny muted', { 'text-anchor': 'end' });
        const row = [];
        for (let lo = 0; lo < 16; lo++) {
          const b = (hi << 4) | lo;
          const x = G.laneX + lo * G.laneW;
          const y = GRID_Y + hi * G.gridH;
          const inside = sim.inSet(b);
          const r = el('rect', { x, y, width: G.laneW - 2, height: G.gridH - 1, rx: 2, class: inside ? 'sv-g in' : 'sv-g' }, gStatic);
          const s = show(b);
          if (s) txt(gStatic, x + (G.laneW - 2) / 2, y + 9.5, s, inside ? 'sv-gch in' : 'sv-gch', { 'text-anchor': 'middle' });
          row.push(r);
        }
        this.grid.push(row);
      }
      txt(
        gStatic,
        G.laneX,
        GRID_Y + 8 * G.gridH + 14,
        vector ? 'xmm5 as bits: column = low nibble, row = high nibble. Red = in the set.' : 'The set table (16 bytes in memory): column = low nibble, row = high nibble. Red = in the set.',
        't-tiny muted'
      );
      this.gridMarks = el('g', {}, svg);
      this.gFocus = el('g', { class: 'focus' }, svg);
      this.focusKey = null;
    }

    lineY(i) {
      return G.codeY + 34 + i * G.lineH;
    }

    // ---- spotlight (guided tour) ----
    region(name) {
      const pad = 6;
      const vecRow = (reg) => {
        const v = ROW[reg];
        return { x: G.regX + 8, y: v.y - pad, w: G.regW - 16, h: (v.h || G.laneH) + pad * 2 };
      };
      if (name === 'memory') return { x: G.memX - 12, y: 2, w: this.sim.bytes.length * G.cellW + 24, h: G.memY + G.cellH + 30 - 2 };
      if (name === 'code') return { x: G.codeX - 4, y: G.codeY - 4, w: G.codeW + 8, h: PANEL_H + 8 };
      if (name === 'gpr') return { x: G.regX + 4, y: G.codeY + 4, w: G.regW - 8, h: G.gprY + 3 * G.gprPitch + 16 - G.codeY };
      if (name === 'vec') return { x: G.regX + 4, y: VEC_TOP - 18, w: G.regW - 8, h: GRID_Y + 8 * G.gridH + 22 - VEC_TOP + 18 };
      if (name === 'grid') return { x: G.regX + 8, y: GRID_Y - 4, w: G.regW - 16, h: 8 * G.gridH + 24 };
      if (name === 'xmm5') {
        const r = vecRow('xmm5');
        return { x: r.x, y: r.y, w: r.w, h: GRID_Y + 8 * G.gridH + 20 - r.y };
      }
      if (ROW[name]) return vecRow(name);
      return null;
    }

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
      for (const r of rects) el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, fill: '#000' }, mask);
      el('rect', { x: 0, y: 0, width: G.W, height: G.H, class: 'focus-dim', mask: `url(#${id})` }, g);
      for (const r of rects) el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, class: 'focus-ring' }, g);
    }

    // ---- per frame ----
    render(sim) {
      const k = sim.cur;
      const step = k >= 0 ? sim.steps[k] : null;
      const p = k >= 0 ? Math.max(0, Math.min(1, sim.time - k)) : 0;
      const regs = step ? step.regs : null;
      const fresh = (reg) => step && step.dst && step.dst.includes(reg);
      const reads = (reg) => step && step.src && step.src.includes(reg);
      const glow = 1 - p * 0.55;

      // memory strip
      const status = step ? step.status : null;
      this.cells.forEach((c, i) => {
        const s = status ? status[i] : 0;
        const checkedNow = step && step.checked && step.checked.includes(i);
        setCls(c.r, 'sv-cell' + (s === 1 ? ' ok' : s === 2 ? ' bad' : '') + (checkedNow ? ' now' : ''));
      });
      if (step && step.win) {
        const [a, n] = step.win;
        setAttr(this.winRect, 'x', cellX(a) - 3);
        setAttr(this.winRect, 'width', n * G.cellW + 6);
        setAttr(this.gWin, 'opacity', 1);
        setAttr(this.winLab, 'x', cellX(a) + (n * G.cellW) / 2);
        setText(this.winLab, n === 1 ? `i = ${a}` : `i = ${a} … ${a + n - 1}`);
        setCls(this.winRect, 'sv-win' + (step.mem ? ' loading' : ''));
      } else setAttr(this.gWin, 'opacity', 0);
      const found = step && step.found != null && (step.id === 'f_add' || step.id === 's_jc') ? step.found : null;
      if (found != null || sim.finished) {
        const f = sim.found;
        setAttr(this.foundLab, 'x', cellX(f) + G.cellW / 2);
        setText(this.foundLab, `↑ byte ${f}: first to encode`);
      } else setText(this.foundLab, '');

      // listing
      if (step) {
        setAttr(this.pcBar, 'y', this.lineY(step.line) - 1);
        setAttr(this.pcBar, 'opacity', 1);
      } else {
        const first = sim.program.findIndex((l) => l.id);
        setAttr(this.pcBar, 'y', this.lineY(first) - 1);
        setAttr(this.pcBar, 'opacity', 0.4);
      }
      this.lines.forEach((l, i) => {
        if (!l.cnt) return;
        const n = step ? step.counts[i] : 0;
        setText(l.cnt, n ? `×${n}` : '');
      });

      // general-purpose registers
      const lastWriter = (reg, limit = 40) => {
        for (let j = k; j >= 0 && j > k - limit; j--) if (sim.steps[j].dst && sim.steps[j].dst.includes(reg)) return sim.steps[j];
        return null;
      };
      for (const g of this.gpr) {
        const v = regs ? regs[g.name] : 0;
        let used = 0;
        g.cells.forEach((c, b) => {
          const byte = Math.floor(v / Math.pow(256, 7 - b)) & 0xff;
          const live = regs && byte !== 0;
          if (live) used++;
          setText(c.t, regs ? hex2(byte) : '');
          setCls(c.r, 'sv-lane' + (live ? ' live' : '') + (fresh(g.name) && live ? ' wr' : ''));
          if (fresh(g.name)) setAttr(c.r, 'fill-opacity', live ? glow : 1);
          else c.r.removeAttribute('fill-opacity');
        });
        const w = regs ? lastWriter(g.name, 400) : null;
        const roleFn = w && GPR_ROLE[w.id];
        setText(g.role, roleFn ? roleFn(v) : g.name === 'rcx' && regs ? `i = ${v}` : '');
        setText(g.used, regs ? `${Math.max(1, used)} of 8 bytes used` : '');
        setCls(g.frame, 'sv-frame' + (reads(g.name) ? ' rd' : '') + (fresh(g.name) ? ' wr' : ''));
      }
      setText(this.flag, regs && !this.vector ? `CF (carry flag) = ${regs.cf}` : regs && step.id.startsWith('s_') ? `CF (carry flag) = ${regs.cf}` : '');

      // vector registers
      for (const row of ROWS) {
        const V = this.vec[row.reg];
        if (row.reg === 'mask') {
          const live = regs && regs.maskLive;
          V.lanes.forEach((c, b) => {
            const bit = live ? (regs.rax >> b) & 1 : null;
            setText(c.t, bit == null ? '' : String(bit));
            setCls(c.r, 'sv-lane' + (bit ? ' hit' : bit === 0 ? ' live' : ' empty') + (fresh('rax') && live ? ' wr' : ''));
          });
          setCls(V.frame, 'sv-frame' + (fresh('rax') && live ? ' wr' : '') + (reads('rax') && live ? ' rd' : ''));
          setAttr(V.g, 'opacity', this.vector ? 1 : 0.35);
          continue;
        }
        const val = regs ? regs[row.reg] : null;
        V.lanes.forEach((c, b) => {
          if (!val) {
            setText(c.t, '');
            if (c.t2) setText(c.t2, '');
            setCls(c.r, 'sv-lane empty');
            c.r.removeAttribute('fill-opacity');
            return;
          }
          const x = val[b];
          if (row.reg === 'xmm0') {
            setText(c.t, show(x) || '·');
            setText(c.t2, hex2(x));
          } else setText(c.t, hex2(x));
          let cls = 'sv-lane live';
          if (row.reg === 'xmm1' && step && lastWriter('xmm1', 16) && lastWriter('xmm1', 16).id === 'v_eq') cls += x ? ' hit' : ' miss';
          if (fresh(row.reg)) cls += ' wr';
          setCls(c.r, cls);
          if (fresh(row.reg)) setAttr(c.r, 'fill-opacity', glow);
          else c.r.removeAttribute('fill-opacity');
        });
        const w = regs ? lastWriter(row.reg, 16) : null;
        setText(V.role, row.role || (w && ROLE[w.id]) || '');
        setText(V.idle, this.vector ? (val ? '' : 'not loaded yet') : 'unused by this loop');
        setCls(V.frame, 'sv-frame' + (reads(row.reg) ? ' rd' : '') + (fresh(row.reg) ? ' wr' : ''));
        setAttr(V.g, 'opacity', this.vector ? 1 : 0.35);
      }

      // links: pshufb lookups and movemask
      const gl = this.gLinks;
      while (gl.firstChild) gl.removeChild(gl.firstChild);
      if (step && step.shuffle) {
        const from = ROW[step.shuffle.from];
        const to = ROW[step.dst[0]];
        const reveal = Math.min(1, p / 0.45);
        step.shuffle.idx.forEach((ix, lane) => {
          const x1 = laneCX(ix);
          const y1 = from.y;
          const x2 = laneCX(lane);
          const y2 = to.y + G.laneH;
          const ym = (y1 + y2) / 2;
          el('path', { d: `M${x1},${y1} C${x1},${ym} ${x2},${ym} ${x2},${y2}`, class: 'sv-link', opacity: reveal }, gl);
          el('circle', { cx: x1, cy: y1, r: 3, class: 'sv-linkdot', opacity: reveal }, gl);
        });
      }
      if (step && step.movemask) {
        const a = ROW.xmm1;
        const b = ROW.mask;
        for (let lane = 0; lane < 16; lane++) {
          el('line', { x1: laneCX(lane), y1: a.y + G.laneH, x2: laneCX(lane), y2: b.y, class: 'sv-link mm', opacity: Math.min(1, p / 0.3) }, gl);
        }
      }
      // load ribbon: memory window → destination register
      if (step && step.mem) {
        const [a, n] = step.mem;
        const dst = step.dst[0];
        const x1 = cellX(a);
        const x2 = cellX(a + n);
        let tx1;
        let tx2;
        let ty;
        if (dst === 'xmm0') {
          tx1 = G.laneX;
          tx2 = G.laneX + 16 * G.laneW - 2;
          ty = ROW.xmm0.y;
        } else {
          const g = this.gpr.find((r) => r.name === dst);
          tx1 = G.laneX + 7 * G.byteW;
          tx2 = G.laneX + 8 * G.byteW - 2;
          ty = g.y;
        }
        const y0 = G.memY + G.cellH + 2;
        const op = Math.max(0, 1 - Math.abs(p - 0.35) * 1.4);
        el('path', { d: `M${x1},${y0} L${x2},${y0} L${tx2},${ty} L${tx1},${ty} Z`, class: 'sv-ribbon', opacity: 0.15 + op * 0.45 }, gl);
      }

      // grid highlights
      const gm = this.gridMarks;
      while (gm.firstChild) gm.removeChild(gm.firstChild);
      const cellRect = (lo, hi, cls) =>
        el('rect', { x: G.laneX + lo * G.laneW - 1.5, y: GRID_Y + hi * G.gridH - 1.5, width: G.laneW + 1, height: G.gridH + 2, rx: 3, class: cls }, gm);
      if (step && step.grid) {
        const { col, row, hit } = step.grid;
        el('rect', { x: G.laneX + col * G.laneW - 1.5, y: (this.vector ? ROW.xmm5.y : GRID_Y) - 1.5, width: G.laneW + 1, height: GRID_Y + 8 * G.gridH - (this.vector ? ROW.xmm5.y : GRID_Y) + 2, rx: 4, class: 'sv-col' }, gm);
        if (row != null) cellRect(col, row, hit ? 'sv-gmark bad' : 'sv-gmark ok');
      }
      if (step && step.shuffle && step.shuffle.from === 'xmm5') {
        const cols = new Set(step.shuffle.idx);
        cols.forEach((col) =>
          el('rect', { x: G.laneX + col * G.laneW - 1.5, y: GRID_Y - 1.5, width: G.laneW + 1, height: 8 * G.gridH + 2, rx: 4, class: 'sv-col' }, gm)
        );
      }
      if (step && step.gridLanes) {
        step.gridLanes.forEach((b) => {
          if (b >= 0x80) return;
          cellRect(b & 15, b >> 4, sim.inSet(b) ? 'sv-gmark bad' : 'sv-gmark ok');
        });
      }
    }
  }

  NS.SimdView = SimdView;
})((window.CPUViz = window.CPUViz || {}));
