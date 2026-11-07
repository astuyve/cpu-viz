/*
 * Scenario: array of structs vs struct of arrays.
 *
 * N particles, each { x, y, z, mass } as 8-byte doubles. Four threads each
 * sum the x of their own N/4 particles, once. Same data, same size, only the
 * order in memory differs. N is a scenario parameter: 32 for the step-by-step
 * tour, 1,024 to see the difference at scale.
 *
 *   AoS: x0 y0 z0 m0 x1 y1 z1 m1 | x2 y2 ...   -> 2 useful values per line
 *   SoA: x0 x1 x2 ... x7 | ... | y0 y1 ...     -> 8 useful values per line
 */
(function (NS) {
  'use strict';
  NS.scenarios = NS.scenarios || [];

  const BASE = 0x1000;
  // Scenario parameter: particle count. `speeds` is the default playback
  // speed (ms per simulated ns) for each size.
  const PARAM = {
    label: 'Particles',
    values: [32, 1024],
    value: 1024,
    speeds: { 32: 15, 1024: 2 },
    format: (n) => n.toLocaleString(),
  };
  const N = () => PARAM.value;
  const PER_CORE = () => N() / 4;
  const FIELDS = ['x', 'y', 'z', 'm'];
  const X_FILL = '#eab308';
  const X_INK = '#1b1b1b';
  const lineCache = {};
  const LINES = () => (lineCache[N()] = lineCache[N()] || Array.from({ length: (N() * 32) / 64 }, (_, i) => BASE + i * 64));
  const fmt = (n) => n.toLocaleString();

  const look = (field, idx) =>
    field === 'x'
      ? { label: `x${idx}`, fill: X_FILL, ink: X_INK, field }
      : { label: `${field}${idx}`, fill: null, ink: null, field };

  const UNIT = { one: 'value summed', many: 'values summed', per: 'value' };

  const doneText = (layoutWord) => (sim) => {
    const s = sim.stats;
    const pct = Math.round((s.bytesUsed / Math.max(1, s.bytesFetched)) * 100);
    return (
      `All four sums finished in ${NS.fmtNs(sim.time)}. The cores fetched ${fmt(s.fetches)} cache lines (${fmt(s.bytesFetched)} B) from DRAM ` +
      `to read ${fmt(s.bytesUsed)} B of x values, so ${pct}% of the bytes moved were actually used${layoutWord}.`
    );
  };


  // ---- guided tour: AoS first, then the same work as SoA ----
  const X = '<b class="st-x">x</b>';
  const fetchDone = (cpu, line) => (e) =>
    e.type === 'phase-end' && e.phase === 'fetch' && e.cpu === cpu && (line == null || e.line === line);
  const opDone = (cpu, ops) => (e) => e.type === 'op-done' && e.cpu === cpu && e.ops === ops;
  const allDone = (e) => e.type === 'all-done';
  const SMALL = 8; // values per core in the walkthrough (32 particles)
  const BIG = 1024 / 4;
  const aosNs = (lat, per = SMALL) => (per / 2) * lat.memRead + per * lat.l1;
  const soaNs = (lat, per = SMALL) => (per / 8) * lat.memRead + per * lat.l1;
  const rows = (...ls) => ls.map((l) => 'row:0x' + l.toString(16).toUpperCase());

  const TOUR = {
    variant: 'aos',
    param: 32,
    // card over the right-hand memory column (cores 2–3, z and mass), out of the way
    card: { x: 0.755, top: 0.585, width: 'min(440px, 42%)' },
    steps: [
      {
        title: 'Array of structs: one particle after another',
        focus: rows(BASE, BASE + 64, BASE + 128, BASE + 192),
        body:
          'Each particle is a struct of four 8-byte doubles: x, y, z and mass, 32 bytes in all. ' +
          'In an array of structs, each 64-byte cache line holds two whole particles. ' +
          `Core 0 will sum the ${X} of particles 0–7, which live in the four highlighted lines. Only the yellow slots matter to this loop.`,
      },
      {
        title: 'Core 0 misses on p[0].x',
        focus: ['cpu:0', ...rows(BASE)],
        speed: 40,
        until: fetchDone(0),
        body: (lat) =>
          'Core 0’s cache is empty, so reading <code>p[0].x</code> is a miss. The cache never fetches just 8 bytes. ' +
          `It brings in the whole 64-byte line, with x, y, z and mass for particles 0 and 1 (~${lat.memRead} ns). ` +
          'The other cores are doing the same for their own particles.',
      },
      {
        title: 'Two useful values, six passengers',
        focus: ['cpu:0', ...rows(BASE)],
        speed: 600,
        until: opDone(0, 2),
        body: (lat) =>
          `<code>p[0].x</code> and then <code>p[1].x</code> are L1 hits at ~${lat.l1} ns each. ` +
          'That is everything this line has to offer the loop. The other 6 slots (48 of 64 bytes) are y, z and mass. They were fetched, and they will never be read.',
      },
      {
        title: 'Back to DRAM for every other particle',
        focus: ['cpu:0', ...rows(BASE, BASE + 64)],
        speed: 40,
        until: fetchDone(0, BASE + 64),
        body: (lat) =>
          `<code>p[2]</code> starts the next line, so that is another ~${lat.memRead} ns miss. Core 0’s single cache line is replaced. ` +
          'It was only read, so nothing needs writing back. The pattern is one trip to DRAM for every 2 values summed.',
      },
      {
        title: 'Array of structs: finished',
        focus: null,
        speed: 15,
        until: allDone,
        body: (lat) =>
          `Each core needs ${SMALL / 2} fetches for its ${SMALL} values: ${SMALL / 2} × ${lat.memRead} + ${SMALL} × ${lat.l1} = <b>${aosNs(lat)} ns</b>. ` +
          'Across all cores, 1,024 bytes came from DRAM to use 256 bytes of x. Three quarters of the memory traffic was wasted.',
      },
      {
        title: 'Struct of arrays: group by field',
        variant: 'soa',
        focus: rows(BASE, BASE + 64, BASE + 128, BASE + 192),
        body:
          'These are the same particles in the same 1 KB, stored one field at a time: all 32 x values first (highlighted), then y, z and mass. ' +
          `Every cache line in the x array is 8 consecutive ${X} values, which is exactly what the loop reads.`,
      },
      {
        title: 'One fetch…',
        focus: ['cpu:0', ...rows(BASE)],
        speed: 40,
        until: fetchDone(0),
        body: (lat) =>
          `Core 0 misses on <code>x[0]</code> and fetches its line. That takes the same ~${lat.memRead} ns as before, ` +
          'but this time every slot in the line is a value the loop needs.',
      },
      {
        title: '…eight values',
        focus: ['cpu:0', ...rows(BASE)],
        speed: 300,
        until: opDone(0, SMALL),
        body: (lat) =>
          `<code>x[0]</code> through <code>x[7]</code> are all L1 hits at ~${lat.l1} ns each. ` +
          'Core 0 sums all 8 of its values from a single trip to DRAM, and no byte it fetched is wasted.',
      },
      {
        title: 'Same data, 4× less traffic',
        focus: null,
        speed: 40,
        until: allDone,
        body: (lat) =>
          `Struct of arrays finished in <b>${soaNs(lat)} ns</b> instead of ${aosNs(lat)} ns (${(aosNs(lat) / soaNs(lat)).toFixed(1)}× faster), fetching 256 bytes instead of 1,024. ` +
          'Array of structs is still the right choice when a loop uses every field of each object. Choose the layout by how the data is read. ' +
          'Real CPUs prefetch sequential lines and hide some of this waiting, but the 4× extra memory traffic remains.',
      },
      {
        title: 'Here’s what it looks like with more data',
        param: 1024,
        focus: null,
        speed: 2,
        until: allDone,
        precompute: ['aos'],
        final: true,
        body: (lat) =>
          `Now there are 1,024 particles, so each core sums ${fmt(BIG)} values, and playback runs 7.5× faster (1 ns = 2 ms). ` +
          'Memory shows each core’s next 4 lines as it works through its range. ' +
          `Struct of arrays needs about <b>${NS.fmtNs(soaNs(lat, BIG))}</b>. The same work as an array of structs takes about ${NS.fmtNs(aosNs(lat, BIG))}, ` +
          'which is already filled in on the right. The gap grows with the data, because every line fetched is still only a quarter useful.',
      },
    ],
  };

  NS.scenarios.push({
    id: 'aos-soa',
    title: 'AoS vs SoA',
    summary:
      'Grouping each object’s fields together feels natural, but a loop that reads one field still pays for the whole cache line.',
    metric: 'completion',
    param: PARAM,
    tour: TOUR,
    variants: [
      {
        id: 'aos',
        label: 'Array of structs',
        tag: 'AoS',
        tone: 'bad',
        unit: UNIT,
        showValues: false,
        get memoryLines() {
          return LINES();
        },
        // particle p, field f lives at BASE + p*32 + f*8
        slotStyle(line, k) {
          const off = line - BASE + k * 8;
          return look(FIELDS[(off % 32) / 8], Math.floor(off / 32));
        },
        threadDesc: (cpu) => `sum p[${cpu * PER_CORE()}..${(cpu + 1) * PER_CORE() - 1}].x`,
        nextOp(cpu, iter) {
          if (iter >= PER_CORE()) return null;
          const p = cpu * PER_CORE() + iter;
          return { kind: 'read', addr: BASE + p * 32, desc: `p[${p}].x` };
        },
        get intro() {
          return (
            'Each particle is a 32-byte struct of x, y, z and mass, so one 64-byte cache line holds two whole particles. ' +
            `Each core sums the x of its own ${fmt(PER_CORE())} particles. Only the yellow slots are needed. The grey ones come along for the ride.`
          );
        },
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
        get memoryLines() {
          return LINES();
        },
        // field f, element i lives at BASE + f*(N*8) + i*8
        slotStyle(line, k) {
          const off = line - BASE + k * 8;
          return look(FIELDS[Math.floor(off / (N() * 8))], (off % (N() * 8)) / 8);
        },
        threadDesc: (cpu) => `sum x[${cpu * PER_CORE()}..${(cpu + 1) * PER_CORE() - 1}]`,
        nextOp(cpu, iter) {
          if (iter >= PER_CORE()) return null;
          const i = cpu * PER_CORE() + iter;
          return { kind: 'read', addr: BASE + i * 8, desc: `x[${i}]` };
        },
        get intro() {
          return (
            `The same particles, stored one field at a time: all ${fmt(N())} x values first, then all y, z and mass values. ` +
            'Each cache line now holds 8 consecutive x values, which is exactly what the loop needs.'
          );
        },
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
          'This is the same data, grouped by field instead of by object. A loop over x now uses every byte it fetches, and SIMD instructions can process the contiguous values directly. ' +
          'Real CPUs prefetch sequential lines, which hides much of the waiting for a simple scan like this one. The waste then shows up as memory bandwidth instead: array of structs moves 4× the bytes.',
      },
    ],
  });
})((window.CPUViz = window.CPUViz || {}));
