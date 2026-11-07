/*
 * CPU Viz — app wiring: controls, side panels and the animation loop.
 */
(function (NS) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { hex } = NS.mem;

  const lat = Object.assign({}, NS.DEFAULT_LATENCY);
  const state = {
    scenario: NS.scenarios[0],
    variantIdx: 0,
    playing: true,
    msPerNs: 15,
    sim: null,
    results: {}, // variantId -> { thr, nsPerOp, time }
    lastLogSeq: -1,
    lastPanel: 0,
    lastNarr: -1,
  };
  const view = new NS.View($('viz'));

  // ---- speed: slider 0..100 maps logarithmically to 0.2..200 ms per ns ----
  const S_MIN = 0.2;
  const S_RANGE = 1000;
  const speedToSlider = (ms) => (Math.log(ms / S_MIN) / Math.log(S_RANGE)) * 100;
  const sliderToSpeed = (v) => S_MIN * Math.pow(S_RANGE, v / 100);

  function variant() {
    return state.scenario.variants[state.variantIdx];
  }

  function reset() {
    state.sim = new NS.Sim({ numCpus: 4, variant: variant(), lat });
    view.build(state.sim);
    state.lastLogSeq = -1;
    state.lastNarr = -1;
    $('log').innerHTML = '';
    renderCode();
    renderPanels(true);
  }

  // ---- scenario tabs / variant segmented control ----
  function renderScenarioTabs() {
    const nav = $('scenarioTabs');
    nav.innerHTML = '';
    NS.scenarios.forEach((sc) => {
      const b = document.createElement('button');
      b.className = 'tab' + (sc === state.scenario ? ' active' : '');
      b.textContent = sc.title;
      b.onclick = () => {
        state.scenario = sc;
        state.variantIdx = 0;
        state.results = {};
        renderScenarioTabs();
        renderVariants();
        reset();
      };
      nav.appendChild(b);
    });
    $('scenarioSummary').textContent = state.scenario.summary;
  }

  function renderVariants() {
    const seg = $('variantSeg');
    seg.innerHTML = '';
    state.scenario.variants.forEach((v, i) => {
      const b = document.createElement('button');
      b.className = 'seg-btn' + (i === state.variantIdx ? ' active' : '');
      b.innerHTML = `${v.label} <span class="seg-tag ${v.id}">${v.tag}</span>`;
      b.onclick = () => {
        state.variantIdx = i;
        renderVariants();
        reset();
      };
      seg.appendChild(b);
    });
  }

  // ---- code panel with a tiny C highlighter ----
  const KW = /\b(struct|int64_t|char|void|for|int|_Alignas|sizeof|return)\b/g;
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function highlight(line) {
    const ci = line.indexOf('//');
    const code = ci >= 0 ? line.slice(0, ci) : line;
    const cmt = ci >= 0 ? line.slice(ci) : '';
    let h = esc(code)
      .replace(/(#include)/, '<span class="pp">$1</span>')
      .replace(KW, '<span class="kw">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="num">$1</span>');
    if (cmt) h += `<span class="cm">${esc(cmt)}</span>`;
    return h;
  }
  function renderCode() {
    const v = variant();
    $('code').innerHTML = v.code
      .map((l, i) => `<span class="ln${v.hot.includes(i) ? ' hot' : ''}">${highlight(l) || ' '}</span>`)
      .join('');
    $('codeNote').textContent = v.note;
  }

  // ---- panels ----
  function renderPanels(force) {
    const sim = state.sim;
    const v = variant();
    $('clock').textContent = fmtClock(sim.time);

    // narration
    const n = sim.narration;
    if (force || n.seq !== state.lastNarr) {
      state.lastNarr = n.seq;
      const dot = n.cpu != null ? `<span class="dot" style="background:${NS.CPU_COLORS[n.cpu]}"></span>` : '<span class="dot info"></span>';
      $('narration').innerHTML = `${dot}<div><div class="narr-time mono">t = ${fmtClock(n.t)}</div><div>${esc(n.text)}</div></div>`;
    }

    // log (only new entries)
    const log = $('log');
    for (const e of sim.log) {
      if (e.seq <= state.lastLogSeq) continue;
      state.lastLogSeq = e.seq;
      const li = document.createElement('li');
      const col = e.cpu != null ? NS.CPU_COLORS[e.cpu] : 'var(--muted)';
      li.innerHTML = `<span class="mono t">${fmtClock(e.t)}</span><span class="dot" style="background:${col}"></span><span>${esc(e.text)}</span>`;
      log.insertBefore(li, log.firstChild);
    }
    while (log.children.length > 80) log.removeChild(log.lastChild);

    // stats
    const ops = sim.totalOps();
    const us = sim.time / 1000;
    const thr = us > 0 ? ops / us : 0;
    const s = sim.stats;
    $('stats').innerHTML = [
      ['Increments (all cores)', ops.toLocaleString()],
      ['Throughput', us > 0 ? `${fmtNum(thr)} / µs` : '—'],
      ['L1 hits', s.hits.toLocaleString()],
      ['Cache misses', s.misses.toLocaleString()],
      ['Invalidations sent', s.invalidations.toLocaleString()],
      ['Write-backs to DRAM', s.writebacks.toLocaleString()],
      ['Line fetches from DRAM', s.fetches.toLocaleString()],
    ]
      .map(([k, val]) => `<dt>${k}</dt><dd class="mono">${val}</dd>`)
      .join('');

    // comparison
    if (sim.time >= 50) state.results[v.id] = { thr, time: sim.time, ops };
    const variants = state.scenario.variants;
    const max = Math.max(1e-9, ...variants.map((vv) => (state.results[vv.id] ? state.results[vv.id].thr : 0)));
    $('compare').innerHTML =
      variants
        .map((vv) => {
          const r = state.results[vv.id];
          const pct = r ? Math.max(0.6, (r.thr / max) * 100) : 0;
          return `<div class="cmp-row${vv.id === v.id ? ' current' : ''}">
            <div class="cmp-head"><span>${vv.label}</span><span class="mono">${r ? fmtNum(r.thr) + ' ++/µs' : 'not run yet'}</span></div>
            <div class="cmp-track"><div class="cmp-bar ${vv.id}" style="width:${pct}%"></div></div>
            <div class="cmp-sub">${r ? `measured over ${fmtClock(r.time)} of simulated time` : `switch to “${vv.label}” to measure`}</div>
          </div>`;
        })
        .join('') + ratioLine(variants);
  }

  function ratioLine(variants) {
    const [a, b] = variants.map((v) => state.results[v.id]);
    if (!a || !b || !a.thr || !b.thr) {
      return '<p class="cmp-ratio muted">Run both layouts to compare them.</p>';
    }
    const r = b.thr / a.thr;
    return `<p class="cmp-ratio"><strong>${variants[1].label}</strong> is <strong>${r >= 10 ? Math.round(r) : r.toFixed(1)}×</strong> faster in this model.</p>`;
  }

  function fmtNum(n) {
    if (n >= 100) return Math.round(n).toLocaleString();
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
  function fmtClock(ns) {
    if (ns < 10000) return `${ns.toFixed(ns % 1 ? 1 : 0)} ns`;
    return `${(ns / 1000).toFixed(2)} µs`;
  }
  function renderSpeed() {
    const ms = state.msPerNs;
    const msTxt = ms >= 10 ? Math.round(ms) : ms >= 1 ? ms.toFixed(1) : ms.toFixed(2);
    const factor = ms * 1e6; // 1 ns shown as ms milliseconds
    $('speedLabel').textContent = `1 ns = ${msTxt} ms`;
    $('speedSub').textContent = `${fmtFactor(factor)} slower than real hardware. An L1 hit takes ${fmtDur(ms * lat.l1)} on screen and a DRAM fetch takes ${fmtDur(ms * lat.memRead)}.`;
  }
  function fmtFactor(f) {
    if (f >= 1e9) return (f / 1e9).toFixed(1) + ' billion×';
    if (f >= 1e6) return Math.round(f / 1e6) + ' million×';
    return Math.round(f / 1e3) + ' thousand×';
  }
  function fmtDur(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
  }

  // ---- latency editor ----
  function renderLatencies() {
    const rows = [
      ['l1', 'L1 cache hit'],
      ['invalidate', 'Invalidation across interconnect'],
      ['writeback', 'Write dirty line back to DRAM'],
      ['memRead', 'Read line from DRAM'],
    ];
    $('latencies').innerHTML = rows
      .map(([k, label]) => `<label class="lat"><span>${label}</span><span><input type="number" min="0.5" step="0.5" data-k="${k}" value="${lat[k]}"> ns</span></label>`)
      .join('') + '<button class="btn small" id="latReset">Restore defaults</button>';
    $('latencies').querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (isFinite(v) && v > 0) lat[inp.dataset.k] = v;
        inp.value = lat[inp.dataset.k];
        renderSpeed();
      });
    });
    $('latReset').onclick = () => {
      Object.assign(lat, NS.DEFAULT_LATENCY);
      renderLatencies();
      renderSpeed();
    };
  }

  // ---- transport ----
  function setPlaying(p) {
    state.playing = p;
    $('playBtn').textContent = p ? 'Pause' : 'Play';
    $('playBtn').setAttribute('aria-pressed', String(p));
  }
  $('playBtn').onclick = () => setPlaying(!state.playing);
  $('stepBtn').onclick = () => {
    setPlaying(false);
    state.sim.step();
  };
  $('ffBtn').onclick = () => state.sim.advanceTo(state.sim.time + 1000);
  $('resetBtn').onclick = () => reset();
  $('speed').addEventListener('input', (e) => {
    state.msPerNs = sliderToSpeed(parseFloat(e.target.value));
    renderSpeed();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.code === 'ArrowRight') {
      setPlaying(false);
      state.sim.step();
    } else if (e.key === 'r') {
      reset();
    }
  });

  // ---- loop ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (state.playing) state.sim.advanceTo(state.sim.time + dt / state.msPerNs);
    view.render(state.sim, now);
    $('clock').textContent = fmtClock(state.sim.time);
    if (now - state.lastPanel > 90) {
      state.lastPanel = now;
      renderPanels(false);
    }
    requestAnimationFrame(frame);
  }

  // ---- boot ----
  // Optional deep-link params: ?variant=padded&speed=5&t=250&paused=1
  const q = new URLSearchParams(location.search);
  const vi = state.scenario.variants.findIndex((v) => v.id === q.get('variant'));
  if (vi >= 0) state.variantIdx = vi;
  const sp = parseFloat(q.get('speed'));
  if (sp > 0) state.msPerNs = Math.min(200, Math.max(0.2, sp));
  $('speed').value = speedToSlider(state.msPerNs);
  renderScenarioTabs();
  renderVariants();
  renderLatencies();
  renderSpeed();
  reset();
  const t0 = parseFloat(q.get('t'));
  if (t0 > 0) state.sim.advanceTo(t0);
  setPlaying(q.get('paused') !== '1');
  requestAnimationFrame(frame);

  // expose for debugging in the console
  NS.app = { state, reset, hex };
})((window.CPUViz = window.CPUViz || {}));
