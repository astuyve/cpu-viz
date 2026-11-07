/*
 * Scenario: array of structs vs struct of arrays.
 *
 * 32 particles, each { x, y, z, mass } as 8-byte doubles. Four threads each
 * sum the x of their own 8 particles, once. Same data, same 1 KB, only the
 * order in memory differs:
 *
 *   AoS: x0 y0 z0 m0 x1 y1 z1 m1 | x2 y2 ...   -> 2 useful values per line
 *   SoA: x0 x1 x2 ... x7 | ... | y0 y1 ...     -> 8 useful values per line
 */
(function (NS) {
  'use strict';
  NS.scenarios = NS.scenarios || [];

  const BASE = 0x1000;
  const N = 32; // particles
  const PER_CORE = N / 4;
  const FIELDS = ['x', 'y', 'z', 'm'];
  const FIELD_NAMES = { x: 'x', y: 'y', z: 'z', m: 'mass' };
  const X_FILL = '#eab308';
  const X_INK = '#1b1b1b';
  const LINES = Array.from({ length: (N * 32) / 64 }, (_, i) => BASE + i * 64);

  const look = (field, idx) =>
    field === 'x'
      ? { label: `x${idx}`, fill: X_FILL, ink: X_INK, field }
      : { label: `${field}${idx}`, fill: null, ink: null, field };

  const UNIT = { one: 'value summed', many: 'values summed', per: 'value' };

  const doneText = (layoutWord) => (sim) => {
    const s = sim.stats;
    const pct = Math.round((s.bytesUsed / Math.max(1, s.bytesFetched)) * 100);
    return (
      `All four sums finished in ${NS.fmtNs(sim.time)}. The cores fetched ${s.fetches} cache lines (${s.bytesFetched} B) from DRAM ` +
      `to read ${s.bytesUsed} B of x values, so ${pct}% of the bytes moved were actually used${layoutWord}.`
    );
  };

  NS.scenarios.push({
    id: 'aos-soa',
    title: 'AoS vs SoA',
    summary:
      'Grouping each object’s fields together feels natural, but a loop that reads one field still pays for the whole cache line.',
    metric: 'completion',
    variants: [
      {
        id: 'aos',
        label: 'Array of structs',
        tag: 'AoS',
        tone: 'bad',
        unit: UNIT,
        showValues: false,
        memoryLines: LINES,
        // particle p, field f lives at BASE + p*32 + f*8
        slotStyle(line, k) {
          const off = line - BASE + k * 8;
          return look(FIELDS[(off % 32) / 8], Math.floor(off / 32));
        },
        threadDesc: (cpu) => `sum p[${cpu * PER_CORE}..${cpu * PER_CORE + PER_CORE - 1}].x`,
        nextOp(cpu, iter) {
          if (iter >= PER_CORE) return null;
          const p = cpu * PER_CORE + iter;
          return { kind: 'read', addr: BASE + p * 32, desc: `p[${p}].x` };
        },
        intro:
          'Each particle is a 32-byte struct of x, y, z and mass, so one 64-byte cache line holds two whole particles. ' +
          'Each core sums the x of its own 8 particles. Only the yellow slots are needed. The grey ones come along for the ride.',
        steadyText: (cpu, lat, op) =>
          `Core ${cpu} reads ${op.desc} as an L1 hit (${lat.l1} ns). It came in with the previous particle’s line. ` +
          'That is the only free value in this line, because the other 6 slots are y, z and mass, which this loop never reads.',
        steadyCpu: true,
        doneText: doneText(' (the other 75% was y, z and mass)'),
        code: [
          'struct particle {',
          '    double x, y, z;',
          '    double mass;',
          '};  // 32 bytes: 2 per cache line',
          'struct particle p[N];',
          '',
          'double sum_x(int lo, int hi) {',
          '    double sum = 0;',
          '    for (int i = lo; i < hi; i++)',
          '        // reads 8 of every 32 bytes',
          '        sum += p[i].x;',
          '    return sum;',
          '}',
        ],
        hot: [0, 1, 2, 3, 10],
        note:
          'Array of structs is the natural first choice: one struct per object, just like the domain model, and ideal when a loop uses every field. ' +
          'But this loop only needs x, and the cache always moves whole 64-byte lines, so 3 out of every 4 bytes fetched are wasted.',
      },
      {
        id: 'soa',
        label: 'Struct of arrays',
        tag: 'SoA',
        tone: 'good',
        unit: UNIT,
        showValues: false,
        memoryLines: LINES,
        // field f, element i lives at BASE + f*(N*8) + i*8
        slotStyle(line, k) {
          const off = line - BASE + k * 8;
          return look(FIELDS[Math.floor(off / (N * 8))], (off % (N * 8)) / 8);
        },
        threadDesc: (cpu) => `sum x[${cpu * PER_CORE}..${cpu * PER_CORE + PER_CORE - 1}]`,
        nextOp(cpu, iter) {
          if (iter >= PER_CORE) return null;
          const i = cpu * PER_CORE + iter;
          return { kind: 'read', addr: BASE + i * 8, desc: `x[${i}]` };
        },
        intro:
          'The same particles, stored one field at a time: all 32 x values first, then all y, z and mass values. ' +
          'Each cache line now holds 8 consecutive x values, which is exactly what the loop needs.',
        steadyText: (cpu, lat, op) =>
          `Core ${cpu} reads ${op.desc} as an L1 hit (${lat.l1} ns). Every slot in this line is an x value the loop needs, so one DRAM fetch covers all 8 iterations.`,
        steadyCpu: true,
        doneText: doneText(''),
        code: [
          'struct particles {',
          '    double x[N];',
          '    double y[N];',
          '    double z[N];',
          '    double mass[N];',
          '};',
          'struct particles p;',
          '',
          'double sum_x(int lo, int hi) {',
          '    double sum = 0;',
          '    for (int i = lo; i < hi; i++)',
          '        // 8 x values per cache line',
          '        sum += p.x[i];',
          '    return sum;',
          '}',
        ],
        hot: [0, 1, 2, 3, 4, 12],
        note:
          'This is the same 1 KB of data, grouped by field instead of by object. A loop over x now uses every byte it fetches, and SIMD instructions can process the contiguous values directly. ' +
          'Real CPUs prefetch sequential lines, which hides much of the waiting for a simple scan like this one. The waste then shows up as memory bandwidth instead: array of structs moves 4× the bytes.',
      },
    ],
  });
})((window.CPUViz = window.CPUViz || {}));
