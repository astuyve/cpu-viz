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
  const TOUR_KEY = 'cpuviz.tourSeen.';

  const tour = new NS.Tour(
    {
      sim: () => state.sim,
      resetSim(variantId) {
        const i = state.scenario.variants.findIndex((v) => v.id === variantId);
        if (i >= 0 && i !== state.variantIdx) {
          state.variantIdx = i;
          renderVariants();
        }
        reset();
      },
      getSpeed: () => state.msPerNs,
      setSpeed,
      isPlaying: () => state.playing,
      setPlaying: (p) => setPlaying(p),
      view,
      lat,
      onEnd(action, def) {
        try {
          localStorage.setItem(TOUR_KEY + state.scenario.id, '1');
        } catch (e) {
          /* storage unavailable */
        }
        if (action === 'fix') {
          state.variantIdx = state.scenario.variants.length - 1;
          renderVariants();
          reset();
        }
        setPlaying(true);
      },
    },
    $('tour')
  );

  /** Advance the simulation, handing tour breakpoints to the tour. */
  function advance(target) {
    const broke = state.sim.advanceTo(target);
    if (broke && tour.active) tour.onBreak();
  }
  function startTour() {
    if (state.scenario.tour) tour.start(state.scenario.tour);
  }

  // ---- speed: slider 0..100 maps logarithmically to 0.2..200 ms per ns ----
  const S_MIN = 0.2;
  const S_RANGE = 1000;
  const speedToSlider = (ms) => (Math.log(ms / S_MIN) / Math.log(S_RANGE)) * 100;
  const sliderToSpeed = (v) => S_MIN * Math.pow(S_RANGE, v / 100);

  function variant() {
    return state.scenario.variants[state.variantIdx];
  }

  /** Save a run's result for the comparison panel (called every panel refresh and before a reset). */
  function recordResult(sim) {
    const v = sim.variant;
    if (!state.scenario.variants.includes(v)) return; // scenario changed
    if (state.scenario.metric === 'completion') {
      if (sim.finished) state.results[v.id] = { val: sim.doneAt, fetched: sim.stats.bytesFetched };
    } else if (sim.time >= 50) {
      state.results[v.id] = { val: sim.totalOps() / (sim.time / 1000), time: sim.time };
    }
  }

  function reset() {
    if (state.sim) recordResult(state.sim);
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
        tour.end('close');
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
    $('tourBtn').hidden = !state.scenario.tour;
  }

  function renderVariants() {
    const seg = $('variantSeg');
    seg.innerHTML = '';
    state.scenario.variants.forEach((v, i) => {
      const b = document.createElement('button');
      b.className = 'seg-btn' + (i === state.variantIdx ? ' active' : '');
      b.innerHTML = `${v.label} <span class="seg-tag ${v.tone || ''}">${v.tag}</span>`;
      b.onclick = () => {
        tour.end('close');
        state.variantIdx = i;
        renderVariants();
        reset();
      };
      seg.appendChild(b);
    });
  }

  // ---- code panel with a tiny C highlighter ----
  const KW = /\b(struct|int64_t|char|void|for|int|double|alignas|sizeof|return)\b/g;
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

    if (state.scenario.metric === 'completion') renderCompletion(sim, v);
    else renderThroughput(sim, v);
  }

  function statRows(rows) {
    $('stats').innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd class="mono">${val}</dd>`).join('');
  }

  /** Open-ended workloads (false sharing): operations per µs, higher is better. */
  function renderThroughput(sim, v) {
    const ops = sim.totalOps();
    const us = sim.time / 1000;
    const thr = us > 0 ? ops / us : 0;
    const s = sim.stats;
    const U = v.unit;
    statRows([
      [`${cap(U.many)} (all cores)`, ops.toLocaleString()],
      ['Throughput', us > 0 ? `${fmtNum(thr)} / µs` : '—'],
      ['L1 hits', s.hits.toLocaleString()],
      ['Cache misses', s.misses.toLocaleString()],
      ['Invalidations sent', s.invalidations.toLocaleString()],
      ['Write-backs to DRAM', s.writebacks.toLocaleString()],
      ['Line fetches from DRAM', s.fetches.toLocaleString()],
    ]);
    recordResult(sim);
    renderCompare({
      value: (r) => `${fmtNum(r.val)} ${U.per}/µs`,
      sub: (r) => `measured over ${fmtClock(r.time)} of simulated time`,
      higherIsBetter: true,
      title: 'Throughput',
      tag: 'running',
    });
  }

  /** Finite workloads (AoS vs SoA): time to finish, lower is better. */
  function renderCompletion(sim, v) {
    const s = sim.stats;
    const pct = s.bytesFetched ? Math.round((s.bytesUsed / s.bytesFetched) * 100) : 0;
    statRows([
      ['Elapsed', sim.finished ? `${fmtClock(sim.doneAt)} (done)` : fmtClock(sim.time)],
      [cap(v.unit.many), sim.totalOps().toLocaleString()],
      ['L1 hits', s.hits.toLocaleString()],
      ['Cache misses', s.misses.toLocaleString()],
      ['Lines fetched from DRAM', s.fetches.toLocaleString()],
      ['Bytes fetched', `${s.bytesFetched.toLocaleString()} B`],
      ['Bytes actually used', s.bytesFetched ? `${s.bytesUsed.toLocaleString()} B (${pct}%)` : '—'],
    ]);
    recordResult(sim);
    renderCompare({
      value: (r) => fmtClock(r.val),
      sub: (r) => `to finish · ${r.fetched.toLocaleString()} B fetched from DRAM`,
      pending: sim.finished ? null : `running… ${fmtClock(sim.time)}`,
      higherIsBetter: false,
      title: 'Time to finish',
      tag: sim.finished ? 'this run' : 'running',
    });
  }

  /** Bar per variant (its last result) plus a ratio line. */
  function renderCompare(o) {
    const v = variant();
    const variants = state.scenario.variants;
    const max = Math.max(1e-9, ...variants.map((vv) => (state.results[vv.id] ? state.results[vv.id].val : 0)));
    $('compareTitle').textContent = o.title;
    $('compare').innerHTML =
      variants
        .map((vv) => {
          const r = state.results[vv.id];
          const running = vv.id === v.id && o.pending && !r;
          const pct = r ? Math.max(0.6, (r.val / max) * 100) : 0;
          const head = r ? o.value(r) : running ? o.pending : 'not run yet';
          const sub = r ? o.sub(r) : running ? '&nbsp;' : `switch to “${vv.label}” to measure`;
          return `<div class="cmp-row${vv.id === v.id ? ' current' : ''}">
            <div class="cmp-head"><span>${vv.label}${vv.id === v.id ? ` <span class="muted">(${o.tag})</span>` : ''}</span><span class="mono">${head}</span></div>
            <div class="cmp-track"><div class="cmp-bar ${vv.tone || ''}" style="width:${pct}%"></div></div>
            <div class="cmp-sub">${sub}</div>
          </div>`;
        })
        .join('') + ratioLine(variants, o);
  }

  function ratioLine(variants, o) {
    const rs = variants.map((vv) => state.results[vv.id]);
    if (rs.some((r) => !r || !r.val)) {
      return '<p class="cmp-ratio muted">Run both layouts to compare them.</p>';
    }
    let best = 0;
    rs.forEach((r, i) => {
      if (o.higherIsBetter ? r.val > rs[best].val : r.val < rs[best].val) best = i;
    });
    const other = rs[best === 0 ? 1 : 0];
    const ratio = o.higherIsBetter ? rs[best].val / other.val : other.val / rs[best].val;
    const txt = ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1);
    return `<p class="cmp-ratio"><strong>${variants[best].label}</strong> is <strong>${txt}×</strong> faster in this model.</p>`;
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
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
  function stepOnce() {
    setPlaying(false);
    const t = state.sim.nextEventTime();
    if (t !== Infinity) advance(t);
  }
  function setSpeed(ms) {
    state.msPerNs = ms;
    $('speed').value = speedToSlider(ms);
    renderSpeed();
  }
  $('stepBtn').onclick = stepOnce;
  $('ffBtn').onclick = () => advance(state.sim.time + 1000);
  $('resetBtn').onclick = () => {
    tour.end('close');
    reset();
  };
  $('tourBtn').onclick = startTour;
  $('speed').addEventListener('input', (e) => {
    state.msPerNs = sliderToSpeed(parseFloat(e.target.value));
    renderSpeed();
  });
  window.addEventListener('resize', () => tour.active && tour.layout());
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (tour.active) {
      if (e.code === 'ArrowRight') tour.next();
      else if (e.code === 'ArrowLeft') tour.back();
      else if (e.code === 'Escape') tour.end('close');
    } else if (e.code === 'ArrowRight') {
      stepOnce();
    } else if (e.key === 'r') {
      reset();
    }
  });

  // ---- loop ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (state.playing) advance(state.sim.time + dt / state.msPerNs);
    view.render(state.sim, now);
    tour.tick();
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
  const sc = NS.scenarios.find((x) => x.id === q.get('scenario'));
  if (sc) state.scenario = sc;
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

  // Guided tour: auto-start on a first visit (or with ?tour=1 / ?tour=<step>).
  let seen = false;
  try {
    seen = localStorage.getItem(TOUR_KEY + state.scenario.id) === '1';
  } catch (e) {
    /* storage unavailable */
  }
  const tq = q.get('tour');
  if (tq != null && tq !== '0') {
    startTour();
    const n = parseInt(tq, 10);
    if (n > 1 && tour.active) tour.goto(Math.min(n, state.scenario.tour.steps.length) - 1);
  } else if (!seen && !q.toString()) {
    startTour();
  }
  requestAnimationFrame(frame);

  // expose for debugging in the console
  NS.app = { state, reset, hex, tour };
})((window.CPUViz = window.CPUViz || {}));
