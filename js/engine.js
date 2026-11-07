/*
 * CPU Viz — simulation engine.
 *
 * A small discrete-event simulator of N cores, each with a single-line L1
 * cache, kept coherent with a simplified MESI protocol over a shared
 * interconnect, backed by main memory (DRAM).
 *
 * Everything runs in *simulated nanoseconds*. The view maps simulated time
 * to wall-clock time, so every animation lasts exactly as long (relative to
 * the others) as the hardware operation it depicts.
 *
 * Simplifications (deliberate, for teaching):
 *  - one cache line per core, no L2/L3
 *  - an invalidated line is always re-fetched from DRAM (a dirty copy is
 *    first written back to DRAM); real CPUs often forward it core-to-core
 *  - a core performs exactly one operation per ownership of a line
 *  - transactions on the same line are serialized; different lines proceed
 *    in parallel
 */
(function (NS) {
  'use strict';

  const LINE_BYTES = 64;
  const WORD_BYTES = 8;
  const SLOTS = LINE_BYTES / WORD_BYTES;
  const lineOf = (a) => a - (a % LINE_BYTES);
  const slotOf = (a) => Math.floor((a % LINE_BYTES) / WORD_BYTES);
  const hex = (a) => '0x' + a.toString(16).toUpperCase().padStart(4, '0');

  NS.mem = { LINE_BYTES, WORD_BYTES, SLOTS, lineOf, slotOf, hex };

  const DEFAULT_LATENCY = Object.freeze({
    l1: 1,          // L1 hit (~4 cycles)
    invalidate: 20, // broadcast invalidation / snoop across the interconnect
    writeback: 60,  // write a dirty 64 B line back to DRAM
    memRead: 100,   // read a 64 B line from DRAM
  });
  NS.DEFAULT_LATENCY = DEFAULT_LATENCY;

  class Sim {
    /**
     * @param {object} opts
     * @param {number} opts.numCpus
     * @param {object} opts.variant  scenario variant (see scenarios/*.js)
     * @param {object} opts.lat      latency table in ns (read live)
     */
    constructor({ numCpus, variant, lat }) {
      this.n = numCpus;
      this.variant = variant;
      this.lat = lat;

      this.time = 0;
      this.seq = 0;
      this.queue = [];

      this.memory = new Map();
      for (const l of variant.memoryLines) this.memory.set(l, new Array(SLOTS).fill(0));

      // (line:slot) -> owning cpu, so the view can colour each 8-byte slot
      this.owners = new Map();
      for (let i = 0; i < numCpus; i++) {
        const a = variant.addrFor(i);
        this.owners.set(lineOf(a) + ':' + slotOf(a), i);
      }

      this.cpus = Array.from({ length: numCpus }, (_, id) => ({
        id,
        line: null,       // { addr, state: 'M'|'E'|'S'|'I', data: number[], pendingInv }
        status: 'idle',   // 'idle' | 'exec' | 'stall'
        ops: 0,
        iter: 0,
        execNs: 0,
        execSince: null,
        stallNs: 0,
        stallSince: null,
        waiting: null,    // { phase, label, line, start, end }
      }));

      this.locks = new Map(); // line -> { busy, owner, queue: [] }
      this.memWrites = new Map(); // line -> { slots, t } most recent write-back
      this.anims = [];
      this.animSeq = 0;
      this.log = [];
      this.logSeq = 0;
      this.narration = { t: 0, text: variant.intro, cpu: null, seq: 0 };
      this.stats = { hits: 0, misses: 0, invalidations: 0, fetches: 0, writebacks: 0 };
      this.steadyNarrated = false;

      for (const c of this.cpus) this.at(0, () => this.cpuNext(c));
    }

    // ---- public API -------------------------------------------------------

    ownerOf(line, slot) {
      const o = this.owners.get(line + ':' + slot);
      return o === undefined ? null : o;
    }

    totalOps() {
      return this.cpus.reduce((s, c) => s + c.ops, 0);
    }

    liveExec(c) {
      return c.execNs + (c.execSince != null ? this.time - c.execSince : 0);
    }

    liveStall(c) {
      return c.stallNs + (c.stallSince != null ? this.time - c.stallSince : 0);
    }

    nextEventTime() {
      return this.queue.length ? this.queue[0].t : Infinity;
    }

    /**
     * Process every event up to and including `target` ns.
     * Returns true if a hook requested a break (see `hook` / `requestBreak`),
     * in which case time stops at the event that triggered it.
     */
    advanceTo(target) {
      let guard = 0;
      while (this.queue.length && this.queue[0].t <= target && guard++ < 1e6) {
        const ev = this.queue.shift();
        this.time = ev.t;
        ev.fn();
        if (this.breakFlag) {
          this.breakFlag = false;
          this.pruneAnims();
          return true;
        }
      }
      if (target > this.time) this.time = target;
      this.pruneAnims();
      return false;
    }

    pruneAnims() {
      if (this.anims.length) this.anims = this.anims.filter((a) => a.end >= this.time);
    }

    /** Called from a hook to stop advanceTo() after the current event. */
    requestBreak() {
      this.breakFlag = true;
    }

    /**
     * Notify an optional observer of a hardware event. Types:
     *   miss        { cpu, line }
     *   phase-start { phase, cpu, line, from? }   cpu = the requesting core
     *   phase-end   { phase, cpu, line }
     *   op-done     { cpu, ops }
     */
    emit(type, data) {
      if (this.hook) this.hook(Object.assign({ type, t: this.time }, data), this);
    }

    /** Advance to the next moment something happens. */
    step() {
      const t = this.nextEventTime();
      if (t !== Infinity) this.advanceTo(t);
    }

    // ---- internals --------------------------------------------------------

    at(t, fn) {
      const ev = { t, seq: this.seq++, fn };
      let lo = 0;
      let hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.queue[mid].t <= t) lo = mid + 1;
        else hi = mid;
      }
      this.queue.splice(lo, 0, ev);
    }

    anim(a) {
      a.id = ++this.animSeq;
      this.anims.push(a);
      return a;
    }

    narrate(text, cpu = null, opts = {}) {
      this.narration = { t: this.time, text, cpu, seq: this.narration.seq + 1 };
      if (!opts.silent) {
        this.log.push({ seq: ++this.logSeq, t: this.time, text: opts.log || text, cpu });
        if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
      }
    }

    lockFor(line) {
      let l = this.locks.get(line);
      if (!l) {
        l = { busy: false, owner: null, queue: [] };
        this.locks.set(line, l);
      }
      return l;
    }

    cpuNext(cpu) {
      const op = this.variant.nextOp(cpu.id, cpu.iter);
      const line = lineOf(op.addr);
      const c = cpu.line;
      const isWrite = op.kind !== 'read';
      const ok =
        c &&
        c.addr === line &&
        !c.pendingInv &&
        (isWrite ? c.state === 'M' || c.state === 'E' : c.state !== 'I');
      if (ok) this.hit(cpu, op, null, false);
      else this.miss(cpu, op, line);
    }

    hit(cpu, op, onDone, afterMiss) {
      const L = this.lat;
      const t0 = this.time;
      const t1 = t0 + L.l1;
      const slot = slotOf(op.addr);
      if (!afterMiss) this.stats.hits++;
      cpu.status = 'exec';
      cpu.execSince = t0;
      cpu.waiting = null;
      this.anim({ kind: 'hit', cpu: cpu.id, slot, start: t0, end: t1 });

      if (!afterMiss && !this.steadyNarrated) {
        this.steadyNarrated = true;
        this.narrate(this.variant.steadyText(cpu.id, L), null);
      }

      this.at(t1, () => {
        const ln = cpu.line;
        if (op.kind !== 'read') {
          ln.data[slot]++;
          ln.state = 'M';
        }
        cpu.ops++;
        cpu.iter++;
        cpu.execNs += t1 - t0;
        cpu.execSince = null;
        cpu.status = 'idle';
        this.emit('op-done', { cpu: cpu.id, ops: cpu.ops });
        // Continue in a separate event so a breakpoint on op-done pauses
        // *before* the next transaction starts.
        this.at(this.time, () => {
          if (onDone) onDone();
          this.cpuNext(cpu);
        });
      });
    }

    miss(cpu, op, line) {
      this.stats.misses++;
      this.steadyNarrated = false;
      cpu.status = 'stall';
      cpu.stallSince = this.time;
      const lock = this.lockFor(line);
      const c = cpu.line;
      let why;
      if (!c || c.addr !== line) {
        why = `cold miss: line ${hex(line)} is not in its cache yet.`;
      } else if (c.state === 'I' || c.pendingInv) {
        why = `its copy of line ${hex(line)} was invalidated because another core wrote to the same line. It stalls.`;
      } else {
        why = `it holds line ${hex(line)} as Shared, but writing needs exclusive ownership.`;
      }
      this.narrate(`Core ${cpu.id} wants ${op.desc}, but ${why}`, cpu.id, {
        log: `Core ${cpu.id} misses on ${hex(line)} (${op.desc})`,
      });

      cpu.waiting = { phase: 'queued', line, start: this.time, end: null };
      this.emit('miss', { cpu: cpu.id, line });
      lock.queue.push({ cpu, op, line });
      this.startNextTx(line);
    }

    startNextTx(line) {
      const lock = this.lockFor(line);
      if (lock.busy || !lock.queue.length) {
        if (!lock.queue.length) lock.owner = null;
        return;
      }
      lock.busy = true;
      const tx = lock.queue.shift();
      lock.owner = tx.cpu.id;
      this.runTx(tx);
    }

    releaseLock(line) {
      const lock = this.lockFor(line);
      lock.busy = false;
      lock.owner = null;
      this.startNextTx(line);
    }

    runTx(tx) {
      const { cpu, line, op } = tx;
      const excl = op.kind !== 'read';
      const others = this.cpus.filter(
        (o) => o !== cpu && o.line && o.line.addr === line && o.line.state !== 'I'
      );
      const dirty = others.find((o) => o.line.state === 'M') || null;

      const steps = [];
      if (cpu.line && cpu.line.addr !== line && cpu.line.state === 'M') {
        steps.push((next) => this.phaseEvict(cpu, next));
      }
      if (others.length) steps.push((next) => this.phaseSnoop(tx, others, dirty, excl, next));
      if (dirty) steps.push((next) => this.phaseWriteback(tx, dirty, next));
      steps.push((next) => this.phaseFetch(tx, excl, others.length > 0 && !excl, next));
      steps.push(() => this.finishTx(tx));

      // Each phase starts in its own event, so a breakpoint on one phase's
      // end pauses before the next phase begins.
      const run = (i) => steps[i](() => this.at(this.time, () => run(i + 1)));
      run(0);
    }

    phaseEvict(cpu, next) {
      const old = cpu.line;
      const t0 = this.time;
      const t1 = t0 + this.lat.writeback;
      old.pendingInv = true;
      cpu.waiting = { phase: 'evict', line: old.addr, start: t0, end: t1 };
      const slots = this.dirtySlots(old.addr, old.data);
      this.anim({ kind: 'wb', from: cpu.id, line: old.addr, data: old.data.slice(), slots, start: t0, end: t1 });
      this.narrate(`Core ${cpu.id} evicts dirty line ${hex(old.addr)} back to DRAM to make room.`, cpu.id);
      this.emit('phase-start', { phase: 'evict', cpu: cpu.id, line: old.addr });
      this.at(t1, () => {
        this.emit('phase-end', { phase: 'evict', cpu: cpu.id, line: old.addr });
        this.memory.set(old.addr, old.data.slice());
        this.memWrites.set(old.addr, { slots, t: this.time });
        this.stats.writebacks++;
        old.state = 'I';
        old.pendingInv = false;
        next();
      });
    }

    phaseSnoop(tx, others, dirty, excl, next) {
      const { cpu, line } = tx;
      const t0 = this.time;
      const t1 = t0 + Math.max(this.lat.invalidate, this.lat.l1);
      for (const o of others) {
        o.line.pendingInv = true;
        this.anim({ kind: excl ? 'inv' : 'snoop', from: cpu.id, to: o.id, line, start: t0, end: t1 });
      }
      if (excl) this.stats.invalidations += others.length;
      cpu.waiting = { phase: excl ? 'invalidate' : 'snoop', line, start: t0, end: t1 };
      const list = others.map((o) => 'Core ' + o.id).join(', ');
      this.narrate(
        excl
          ? `Core ${cpu.id} requests exclusive ownership of line ${hex(line)}. An invalidation message goes to ${list} (${this.lat.invalidate} ns).`
          : `Core ${cpu.id} snoops ${list} for line ${hex(line)}.`,
        cpu.id,
        { log: `Core ${cpu.id} → invalidate ${hex(line)} on ${list}` }
      );
      const phase = excl ? 'invalidate' : 'snoop';
      this.emit('phase-start', { phase, cpu: cpu.id, line, to: others.map((o) => o.id) });
      this.at(t1, () => {
        if (dirty) tx.wbData = dirty.line.data.slice();
        for (const o of others) {
          o.line.pendingInv = false;
          o.line.state = excl ? 'I' : 'S';
        }
        this.emit('phase-end', { phase, cpu: cpu.id, line });
        next();
      });
    }

    /** Slots of `data` that differ from what DRAM currently holds for `line`. */
    dirtySlots(line, data) {
      const mem = this.memory.get(line) || [];
      const out = [];
      data.forEach((v, k) => {
        if (v !== (mem[k] || 0)) out.push(k);
      });
      return out;
    }

    phaseWriteback(tx, dirty, next) {
      const { cpu, line } = tx;
      const t0 = this.time;
      const t1 = t0 + this.lat.writeback;
      const data = tx.wbData || dirty.line.data.slice();
      cpu.waiting = { phase: 'writeback', from: dirty.id, line, start: t0, end: t1 };
      const slots = this.dirtySlots(line, data);
      this.anim({ kind: 'wb', from: dirty.id, line, data, slots, start: t0, end: t1 });
      this.narrate(
        `Core ${dirty.id} had the only up-to-date (Modified) copy of ${hex(line)}, so it writes it back to main memory (${this.lat.writeback} ns). Core ${cpu.id} is still stalled.`,
        dirty.id,
        { log: `Core ${dirty.id} writes back ${hex(line)} → DRAM` }
      );
      this.emit('phase-start', { phase: 'writeback', cpu: cpu.id, line, from: dirty.id });
      this.at(t1, () => {
        this.memory.set(line, data.slice());
        this.memWrites.set(line, { slots, t: this.time });
        this.stats.writebacks++;
        this.emit('phase-end', { phase: 'writeback', cpu: cpu.id, line, from: dirty.id });
        next();
      });
    }

    phaseFetch(tx, excl, shared, next) {
      const { cpu, line } = tx;
      const t0 = this.time;
      const t1 = t0 + this.lat.memRead;
      if (!this.memory.has(line)) this.memory.set(line, new Array(SLOTS).fill(0));
      const data = this.memory.get(line).slice();
      cpu.waiting = { phase: 'fetch', line, start: t0, end: t1 };
      this.anim({ kind: 'fetch', to: cpu.id, line, data, start: t0, end: t1 });
      this.narrate(
        `Core ${cpu.id} fetches line ${hex(line)} from main memory, which takes ~${this.lat.memRead} ns. That is roughly ${Math.round(this.lat.memRead / this.lat.l1)}× slower than an L1 hit, and instructions that need this data must wait for it.`,
        cpu.id,
        { log: `Core ${cpu.id} fetches ${hex(line)} ← DRAM` }
      );
      this.emit('phase-start', { phase: 'fetch', cpu: cpu.id, line });
      this.at(t1, () => {
        cpu.line = { addr: line, state: shared ? 'S' : 'E', data, pendingInv: false };
        this.stats.fetches++;
        this.emit('phase-end', { phase: 'fetch', cpu: cpu.id, line });
        next();
      });
    }

    finishTx(tx) {
      const { cpu, line, op } = tx;
      const stalled = this.time - cpu.stallSince;
      cpu.stallNs += stalled;
      cpu.stallSince = null;
      cpu.waiting = null;
      this.narrate(
        `Core ${cpu.id} finally owns line ${hex(line)} and performs ${op.desc} in ${this.lat.l1} ns, after stalling for ${fmtNs(stalled)}.`,
        cpu.id,
        { log: `Core ${cpu.id} ${op.desc} done (stalled ${fmtNs(stalled)})` }
      );
      this.hit(cpu, op, () => this.releaseLock(line), true);
    }
  }

  function fmtNs(ns) {
    if (ns >= 1000) return (ns / 1000).toFixed(ns >= 10000 ? 1 : 2) + ' µs';
    return Math.round(ns) + ' ns';
  }

  NS.fmtNs = fmtNs;
  NS.Sim = Sim;
})((window.CPUViz = window.CPUViz || {}));
