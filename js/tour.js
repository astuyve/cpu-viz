/*
 * CPU Viz — guided tour.
 *
 * A tour is a list of steps defined by the scenario. Each step can:
 *   - spotlight diagram regions          focus: ['cpu:0', 'row:0x1000', 'bus', ...]
 *   - play the simulation at its own speed   speed: ms of screen time per ns
 *   - run until a hardware event, then pause until: (event, sim) => boolean
 *   - switch layout                          variant: 'soa' (applies from this step on)
 *   - set the scenario parameter             param: 1024 (likewise; tour default def.param)
 *   - fill in other layouts' results          precompute: ['aos'] (run off-screen on entry)
 *
 * A tour (or a single step) may set `card: { x, top, width }` to place its card:
 * x is the card's centre and top its top edge, both as fractions of the diagram.
 *
 * The simulation is deterministic, so Back/Replay simply rebuild a fresh
 * simulation and fast-forward through the earlier steps' breakpoints.
 */
(function (NS) {
  'use strict';

  class Tour {
    /**
     * @param {object} app  { sim(), resetSim(variantId), setSpeed(ms), getSpeed(),
     *                        setPlaying(bool), isPlaying(), view, lat, onEnd(action) }
     * @param {HTMLElement} root  container for the card
     */
    constructor(app, root) {
      this.app = app;
      this.root = root;
      this.active = false;
      this.def = null;
      this.i = 0;
      this.done = false;
    }

    start(def) {
      this.def = def;
      this.active = true;
      this.prevSpeed = this.app.getSpeed();
      this.root.hidden = false;
      document.body.classList.add('touring');
      this.goto(0);
    }

    end(action) {
      if (!this.active) return;
      this.active = false;
      const sim = this.app.sim();
      if (sim) sim.hook = null;
      this.app.view.setFocus(null);
      this.clearLayout();
      this.root.hidden = true;
      this.root.innerHTML = '';
      document.body.classList.remove('touring');
      this.app.setSpeed(this.prevSpeed);
      this.app.onEnd(action || 'close', this.def);
    }

    get steps() {
      return this.def.steps;
    }

    /** Rebuild the simulation at the start of step i, then enter it. */
    goto(i) {
      this.app.resetSim(this.variantAt(0), this.paramAt(0));
      for (let k = 0; k < i; k++) {
        this.ensureVariant(k);
        this.runInstant(this.app.sim(), this.steps[k]);
      }
      this.enter(i);
    }

    /** The layout in effect at step k: the latest step.variant at or before it. */
    variantAt(k) {
      for (let j = k; j >= 0; j--) if (this.steps[j].variant) return this.steps[j].variant;
      return this.def.variant;
    }

    paramAt(k) {
      for (let j = k; j >= 0; j--) if (this.steps[j].param != null) return this.steps[j].param;
      return this.def.param != null ? this.def.param : null;
    }

    /** Switch to a fresh simulation if step k uses a different layout or parameter. */
    ensureVariant(k) {
      const v = this.variantAt(k);
      const p = this.paramAt(k);
      const sim = this.app.sim();
      if (sim.variant.id !== v || (p != null && sim.paramValue !== p)) this.app.resetSim(v, p);
    }

    runInstant(sim, step) {
      if (!step.until) return;
      this.arm(sim, step);
      for (let n = 0; n < 100; n++) {
        if (sim.advanceTo(sim.time + 10000)) return;
      }
    }

    arm(sim, step) {
      sim.hook = step.until
        ? (e, s) => {
            if (step.until(e, s)) s.requestBreak();
          }
        : null;
    }

    enter(i) {
      this.i = i;
      const step = this.steps[i];
      this.ensureVariant(i);
      if (step.precompute) step.precompute.forEach((id) => this.app.precompute(id));
      const sim = this.app.sim();
      this.arm(sim, step);
      this.app.view.setFocus(step.focus || null);
      this.app.setSpeed(step.speed || this.prevSpeed);
      this.done = !step.until;
      this.app.setPlaying(!this.done);
      this.render();
    }

    /** Called by the app when the simulation hit this step's breakpoint. */
    onBreak() {
      this.done = true;
      this.app.setPlaying(false);
      this.renderStatus();
    }

    next() {
      if (!this.done) {
        // skip the rest of this step's animation
        this.runInstant(this.app.sim(), this.steps[this.i]);
        this.done = true;
      }
      if (this.i >= this.steps.length - 1) this.end('finish');
      else this.enter(this.i + 1);
    }

    back() {
      if (this.i > 0) this.goto(this.i - 1);
    }

    replay() {
      this.goto(this.i);
    }

    // ---- UI ----

    render() {
      const step = this.steps[this.i];
      const n = this.steps.length;
      const lat = this.app.lat;
      const body = typeof step.body === 'function' ? step.body(lat, this.app.getSpeed()) : step.body;
      const actions = step.final
        ? step.finalLabel
          ? `<button class="btn" data-a="close">Keep watching</button>
             <button class="btn primary" data-a="fix">${step.finalLabel} →</button>`
          : `<button class="btn" data-a="back">Back</button>
             <button class="btn primary" data-a="close">Done</button>`
        : `<button class="btn" data-a="back" ${this.i === 0 ? 'disabled' : ''}>Back</button>
           ${step.until ? '<button class="btn" data-a="replay" title="Replay this step">Replay</button>' : ''}
           <button class="btn primary" data-a="next">${this.i === 0 ? 'Start' : 'Next'} →</button>`;
      const dots = this.steps
        .map((_, k) => `<span class="tdot${k === this.i ? ' on' : k < this.i ? ' past' : ''}"></span>`)
        .join('');

      this.root.innerHTML = `
        <div class="tour-card" role="dialog" aria-labelledby="tourTitle">
          <div class="tour-head">
            <span class="tour-count">Guided tour · ${this.i + 1} / ${n}</span>
            <span class="tour-dots" aria-hidden="true">${dots}</span>
            <button class="tour-skip" data-a="close">Skip tour</button>
          </div>
          <h3 id="tourTitle">${step.title}</h3>
          <div class="tour-body">${body}</div>
          <div class="tour-foot">
            <span class="tour-status" id="tourStatus"></span>
            <span class="tour-actions">${actions}</span>
          </div>
        </div>`;
      this.root.querySelectorAll('[data-a]').forEach((b) => {
        b.addEventListener('click', () => this.action(b.dataset.a));
      });
      this.renderStatus();
      this.layout();
    }

    renderStatus() {
      const el = this.root.querySelector('#tourStatus');
      if (!el) return;
      const step = this.steps[this.i];
      let html = '';
      if (!step.until) html = '';
      else if (this.done) html = '<span class="ok">✓</span> Step complete';
      else if (this.app.isPlaying()) html = `<span class="live"></span> Playing at 1 ${this.app.timeUnit || 'ns'} = ${fmtMs(this.app.getSpeed())}`;
      else html = 'Paused · press Space to resume';
      if (el.innerHTML !== html) el.innerHTML = html;
    }

    /** Called every frame while active. */
    tick() {
      if (this.active) this.renderStatus();
    }

    action(a) {
      if (a === 'next') this.next();
      else if (a === 'back') this.back();
      else if (a === 'replay') this.replay();
      else if (a === 'close') this.end('close');
      else if (a === 'fix') this.end('fix');
    }

    /**
     * Float the card over the empty lower part of the diagram, and pad the
     * stage so the card never covers the content below it.
     */
    layout() {
      const host = this.root.parentElement;
      const svg = host.querySelector('svg');
      const card = this.root.firstElementChild;
      if (!svg || !card) return;
      if (window.matchMedia('(max-width: 760px)').matches) {
        this.root.style.top = '';
        this.clearLayout();
        return;
      }
      const h = svg.getBoundingClientRect().height;
      const pos = this.steps[this.i].card || this.def.card || {};
      const top = h * (pos.top != null ? pos.top : 0.715);
      this.root.style.top = top + 'px';
      this.root.style.left = pos.x != null ? pos.x * 100 + '%' : '';
      this.root.style.width = pos.width || '';
      host.style.paddingBottom = Math.max(0, top + card.offsetHeight - h + 12) + 'px';
    }

    clearLayout() {
      const host = this.root.parentElement;
      if (host) host.style.paddingBottom = '';
      this.root.style.left = '';
      this.root.style.width = '';
    }
  }

  function fmtMs(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : (ms >= 10 ? Math.round(ms) : ms.toFixed(1)) + ' ms';
  }

  NS.Tour = Tour;
})((window.CPUViz = window.CPUViz || {}));
