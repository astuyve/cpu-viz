/*
 * Scenario: false sharing.
 *
 * Four threads each increment *their own* counter. Nothing is logically
 * shared, but if the counters sit in the same 64-byte cache line the cores
 * fight over that line as if they were sharing it.
 *
 * A scenario is a set of variants. Each variant describes the memory layout
 * (which address each thread touches), the per-thread operation stream, the
 * source code to show, and the narration text. The engine and view are
 * scenario-agnostic.
 */
(function (NS) {
  'use strict';
  const { hex } = NS.mem;
  NS.scenarios = NS.scenarios || [];

  const BASE = 0x1000;

  // ---- guided tour (packed layout) ----
  const ns = (lat, k) => `${lat[k]} ns`;
  const onScreen = (lat, k, ms) => {
    const v = lat[k] * ms;
    return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  };
  const is = (type, phase, cpu) => (e) => e.type === type && e.phase === phase && e.cpu === cpu;
  const opDone = (cpu, ops) => (e) => e.type === 'op-done' && e.cpu === cpu && (ops == null || e.ops === ops);

  const TOUR = {
    variant: 'packed',
    steps: [
      {
        title: 'Four counters, one cache line',
        focus: ['row:0x1000'],
        body:
          'Each of the four threads increments only <b>its own</b> counter. Each counter is 8 bytes and they sit next to each other, ' +
          'so all four fit in the same 64-byte <b>cache line</b> at <code>0x1000</code>. ' +
          'Caches never move single variables. They always move whole 64-byte lines, and they track ownership per line.',
      },
      {
        title: 'Core 0 misses and goes to main memory',
        focus: ['cpu:0', 'bus', 'row:0x1000'],
        speed: 40,
        until: is('phase-end', 'fetch', 0),
        body: (lat, ms) =>
          'Core 0 wants to run <code>counter[0]++</code>, but its cache is empty. This is a <b>cold miss</b>. ' +
          `It requests the whole line from DRAM, which takes about ${ns(lat, 'memRead')} (slowed to ${onScreen(lat, 'memRead', ms)} here). ` +
          'Instructions that need <code>counter[0]</code> must wait for the load. Cores 1–3 miss too, and queue up for the same line.',
      },
      {
        title: 'Exclusive, then Modified',
        focus: ['cpu:0', 'row:0x1000'],
        speed: 600,
        until: opDone(0, 1),
        body: (lat) =>
          'The line arrives in state <b class="st-e">E · Exclusive</b>: Core 0 has the only copy, and it matches memory. ' +
          `The increment itself is now an L1 hit that takes about ${ns(lat, 'l1')}. Watch the dot travel down Core 0’s wire and back. ` +
          'Writing changes the line to <b class="st-m">M · Modified</b>. Core 0 now holds the only up-to-date copy, so the copy in DRAM is <b>stale</b>.',
      },
      {
        title: 'Core 1 needs ownership of the line',
        focus: ['cpu:0', 'cpu:1', 'bus'],
        speed: 90,
        until: is('phase-end', 'invalidate', 1),
        body: (lat) =>
          'Core 1 wants to write <code>counter[1]</code>. That is a different variable, but it lives in the <b>same line</b>. ' +
          'Under MESI, a core may only write a line it holds in M or E, so Core 1 sends a <b>read-for-ownership</b> request. ' +
          `Every other copy of the line must be invalidated. That is the red <b class="st-inv">INV</b> message (~${ns(lat, 'invalidate')}).`,
      },
      {
        title: 'Core 0’s copy is now Invalid',
        focus: ['cpu:0', 'cpu:1', 'row:0x1000'],
        speed: 40,
        until: is('phase-end', 'writeback', 1),
        body: (lat) =>
          'Core 0’s line is now <b class="st-i">I · Invalid</b>, even though Core 1 will never touch <code>counter[0]</code>. ' +
          `Core 0 held the only up-to-date data, so before anyone else can use the line, that data is <b>written back</b> to DRAM (~${ns(lat, 'writeback')}). ` +
          'Core 0 already wants its next increment, so it is stalled now too.',
      },
      {
        title: 'Core 1 fetches the line, finally',
        focus: ['cpu:1', 'row:0x1000'],
        speed: 40,
        until: opDone(1, 1),
        body: (lat) => {
          const total = lat.invalidate + lat.writeback + lat.memRead + lat.l1;
          return (
            `With memory up to date, Core 1 fetches the line (~${ns(lat, 'memRead')}) and then does its ${ns(lat, 'l1')} increment, leaving the line in M. ` +
            `That one increment cost about <b>${total} ns</b>, roughly <b>${Math.round(total / lat.l1)}×</b> the cost of an L1 hit, and nearly all of it was waiting.`
          );
        },
      },
      {
        title: 'Ping-pong, forever',
        focus: null,
        speed: 8,
        until: opDone(0, 2),
        body:
          'Cores 2, 3 and then 0 repeat the same steps: invalidate, write back, fetch, increment. ' +
          'Only one core can own the line at a time, so four “parallel” threads end up taking turns. ' +
          'Watch the <span class="ok">useful work</span> bars stay close to 0%.',
      },
      {
        title: 'The fix: one counter per cache line',
        focus: null,
        final: true,
        finalLabel: 'Show the padded version',
        body:
          'Padding each counter to 64 bytes gives every core a line of its own. After one cold miss each, every core hits its own L1 at ~1 ns, ' +
          'and no invalidations are sent. In this model that is hundreds of times faster. On real hardware, which softens the penalty, expect roughly 2–20×.',
      },
    ],
  };

  NS.scenarios.push({
    id: 'false-sharing',
    title: 'False sharing',
    summary:
      'Threads that never share data can still slow each other down when their data shares a cache line.',
    tour: TOUR,
    variants: [
      {
        id: 'packed',
        label: 'Packed counters',
        tag: 'false sharing',
        memoryLines: [BASE, BASE + 64, BASE + 128, BASE + 192],
        addrFor: (cpu) => BASE + cpu * 8,
        slotName: (cpu) => `c[${cpu}]`,
        fillerName: () => '',
        threadDesc: (cpu) => `counter[${cpu}]++`,
        nextOp(cpu) {
          return { kind: 'rmw', addr: this.addrFor(cpu), desc: `counter[${cpu}]++` };
        },
        intro:
          `All four counters are 8 bytes each, so together they fit in a single 64-byte cache line at ${hex(BASE)}. ` +
          'Each core writes only its own counter, but the hardware tracks ownership per cache line, not per variable.',
        steadyText: () => 'L1 hit: the core already owns the line, so the increment takes ~1 ns.',
        code: [
          '#include <stdint.h>',
          '',
          '// 8 bytes each: all 4 counters land',
          '// in ONE 64-byte cache line.',
          'struct counter { int64_t value; };',
          'struct counter counters[4];',
          '',
          'void *worker(void *arg) {',
          '    int id = *(int *)arg;',
          '    for (;;)',
          '        // invalidates the line in 3 other cores',
          '        counters[id].value++;',
          '}',
        ],
        hot: [4, 5, 11],
        note:
          'No locks and no shared variables, so it looks perfectly parallel. Underneath, the cores take turns owning the one cache line that holds all four counters.',
      },
      {
        id: 'padded',
        label: 'Padded to 64 B',
        tag: 'fixed',
        memoryLines: [BASE, BASE + 64, BASE + 128, BASE + 192],
        addrFor: (cpu) => BASE + cpu * 64,
        slotName: (cpu) => `c[${cpu}]`,
        fillerName: () => 'pad',
        threadDesc: (cpu) => `counter[${cpu}]++`,
        nextOp(cpu) {
          return { kind: 'rmw', addr: this.addrFor(cpu), desc: `counter[${cpu}]++` };
        },
        intro:
          'Each counter is aligned and padded to a full 64-byte cache line, so every core gets a line of its own. ' +
          'After one cold miss each, no core ever has to invalidate another.',
        steadyText: () =>
          'Steady state: every core hits its own line in L1 at ~1 ns per increment. There is no traffic on the interconnect and no stalls.',
        code: [
          '#include <stdint.h>',
          '',
          '// Each counter owns a whole',
          '// 64-byte cache line.',
          'struct counter {',
          '    _Alignas(64) int64_t value;',
          '    char pad[64 - sizeof(int64_t)];',
          '};',
          'struct counter counters[4];',
          '',
          'void *worker(void *arg) {',
          '    int id = *(int *)arg;',
          '    for (;;)',
          '        // stays in this core\'s L1',
          '        counters[id].value++;',
          '}',
        ],
        hot: [5, 6, 14],
        note:
          'This uses 4× the memory and runs orders of magnitude faster. Equivalents in other languages: Rust #[repr(align(64))] or crossbeam::CachePadded, Java @Contended, C++ alignas(std::hardware_destructive_interference_size), Go _ [56]byte padding.',
      },
    ],
  });
})((window.CPUViz = window.CPUViz || {}));
