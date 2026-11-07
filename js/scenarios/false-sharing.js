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

  NS.scenarios.push({
    id: 'false-sharing',
    title: 'False sharing',
    summary:
      'Threads that never share data can still slow each other down when their data shares a cache line.',
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
