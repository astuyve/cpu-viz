/*
 * Scenario: SIMD, from rust-url's percent_encoding crate.
 *
 * When `Url::parse` copies a query string into the URL it percent-encodes
 * every byte in the SPECIAL_QUERY set (controls, space, " # < > '). The hot
 * loop is "find the first byte that needs encoding". This scenario runs that
 * search two ways over the same 56-byte query:
 *
 *   scalar: one byte per iteration, about 11 instructions per byte
 *   simd:   16 bytes per iteration with SSSE3 (pshufb table lookups)
 *
 * Unlike the memory scenarios, the unit of time here is one instruction. The
 * whole run is computed up front as a trace (one entry per instruction, with
 * the full register state after it), and SimdSim replays it with the same
 * interface as NS.Sim so the app, tour and panels work unchanged.
 */
(function (NS) {
  'use strict';
  NS.scenarios = NS.scenarios || [];

  // ---- the data ----------------------------------------------------------

  const URL_PREFIX = 'https://example.com/search?';
  const QUERY = 'q=how+do+cpus+scan+bytes&lang=en&sort=top&from=news feed';
  const BYTES = Array.from(QUERY, (c) => c.charCodeAt(0));
  const LEN = BYTES.length;

  // SPECIAL_QUERY = CONTROLS + ' ' '"' '#' '<' '>' '\''   (url/src/parser.rs)
  const MEMBERS = [];
  for (let b = 0; b < 0x20; b++) MEMBERS.push(b);
  MEMBERS.push(0x7f, 0x20, 0x22, 0x23, 0x3c, 0x3e, 0x27);
  // "Nibble-transposed" bitmap: bit hi of TABLE[lo] is set when hi<<4|lo is in the set.
  const TABLE = new Array(16).fill(0);
  for (const b of MEMBERS) TABLE[b & 15] |= 1 << (b >> 4);
  const POW2 = [1, 2, 4, 8, 16, 32, 64, 128, 0, 0, 0, 0, 0, 0, 0, 0];
  const LOW = new Array(16).fill(0x0f);
  const inSet = (b) => b >= 0x80 || ((TABLE[b & 15] >> (b >> 4)) & 1) === 1;

  // fold() checks the first byte itself, then find_encode() checks an 8-byte
  // prefix one byte at a time before the vector loop.
  const SCALAR_HEAD = 9;

  const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');
  const show = (b) => (b === 0x20 ? '␠' : b < 0x20 || b >= 0x7f ? '·' : String.fromCharCode(b));
  const q = (b) => (b === 0x20 ? 'a space' : `'${String.fromCharCode(b)}'`);

  // ---- programs (what the compiler emits, simplified) ---------------------
  // Each line: { id?, asm?, cmt?, label? }. Lines with an id are instructions.

  const scalarLines = (limit, found) => [
    { label: '.byte_loop:' },
    { id: 's_load', asm: 'movzx  eax, byte [rdi+rcx]', cmt: 'b = bytes[i]' },
    { id: 's_mov', asm: 'mov    edx, eax' },
    { id: 's_and', asm: 'and    edx, 0x0F', cmt: 'lo = b & 0x0F' },
    { id: 's_row', asm: 'movzx  edx, byte [rsi+rdx]', cmt: 'row = table[lo]' },
    { id: 's_or', asm: 'or     edx, 0xFF00', cmt: 'non-ASCII: always' },
    { id: 's_shr', asm: 'shr    eax, 4', cmt: 'hi = b >> 4' },
    { id: 's_bt', asm: 'bt     edx, eax', cmt: 'CF = row bit hi' },
    { id: 's_jc', asm: `jc     ${found}` },
    { id: 's_inc', asm: 'inc    rcx', cmt: 'i += 1' },
    { id: 's_cmp', asm: `cmp    rcx, ${limit}` },
    { id: 's_jb', asm: 'jb     .byte_loop' },
  ];

  const PROGRAMS = {
    scalar: [
      { cmt: 'rdi = bytes, rsi = table, r8 = len' },
      ...scalarLines('r8', '.found'),
      { label: '.found:', cmt: 'rcx = index' },
    ],
    simd: [
      { cmt: 'first byte + 8-byte prefix, one at a time' },
      ...scalarLines(String(SCALAR_HEAD), '.found_byte'),
      { cmt: 'vector setup, once per call' },
      { id: 'v_tab', asm: 'vmovdqu   xmm5, [rsi]', cmt: 'the set' },
      { id: 'v_pow', asm: 'vmovdqu   xmm6, [POW2]' },
      { id: 'v_low', asm: 'vmovdqa   xmm7, [LOW]', cmt: '0x0F × 16' },
      { label: '.vec_loop:' },
      { id: 'v_load', asm: 'vmovdqu   xmm0, [rdi+rcx]', cmt: 'v = 16 bytes' },
      { id: 'v_lo', asm: 'vpand     xmm1, xmm0, xmm7', cmt: 'lo nibbles' },
      { id: 'v_row', asm: 'vpshufb   xmm1, xmm5, xmm1', cmt: 'row = table[lo]' },
      { id: 'v_srl', asm: 'vpsrlw    xmm2, xmm0, 4', cmt: 'v >> 4' },
      { id: 'v_hi', asm: 'vpand     xmm2, xmm2, xmm7', cmt: 'hi nibbles' },
      { id: 'v_bit', asm: 'vpshufb   xmm2, xmm6, xmm2', cmt: 'bit = POW2[hi]' },
      { id: 'v_and', asm: 'vpand     xmm1, xmm1, xmm2', cmt: 'row & bit' },
      { id: 'v_eq', asm: 'vpcmpeqb  xmm1, xmm1, xmm2', cmt: '== bit → FF' },
      { id: 'v_msk', asm: 'vpmovmskb eax, xmm1', cmt: '16 lanes → 16 bits' },
      { id: 'v_test', asm: 'test      eax, eax' },
      { id: 'v_jnz', asm: 'jnz       .found_vec' },
      { id: 'v_add', asm: 'add       rcx, 16' },
      { id: 'v_cmp', asm: 'cmp       rcx, r9', cmt: 'r9 = len − 16' },
      { id: 'v_jbe', asm: 'jbe       .vec_loop' },
      { id: 't_cmp', asm: 'cmp       rcx, r8', cmt: 'bytes left?' },
      { id: 't_jae', asm: 'jae       .none' },
      { id: 't_mov', asm: 'mov       rcx, r9', cmt: 'overlap the tail' },
      { id: 't_jmp', asm: 'jmp       .vec_loop' },
      { label: '.found_vec:' },
      { id: 'f_tz', asm: 'tzcnt     eax, eax', cmt: 'first set bit' },
      { id: 'f_add', asm: 'add       rax, rcx', cmt: 'index = i + lane' },
    ],
  };

  // ---- trace generation ----------------------------------------------------

  /**
   * Run one variant and record every instruction. Each step holds the full
   * machine state after it, plus what the view should point at.
   */
  function buildTrace(variantId) {
    const program = PROGRAMS[variantId];
    const lineOf = {};
    program.forEach((l, i) => l.id && (lineOf[l.id] = i));

    const R = {
      rcx: 0,
      rax: 0,
      rdx: 0,
      cf: 0,
      maskLive: false, // rax holds a vpmovmskb result
      xmm0: null,
      xmm1: null,
      xmm2: null,
      xmm5: null,
      xmm6: null,
      xmm7: null,
    };
    const status = new Array(LEN).fill(0); // 0 unknown, 1 copy as-is, 2 must encode
    const counts = new Array(program.length).fill(0);
    const steps = [];
    let win = null; // [start, len] of the most recent load
    let found = null;
    let vecInstr = 0;

    function exec(id, info) {
      const line = lineOf[id];
      counts[line]++;
      const asm = program[line].asm;
      if (/^v|^vp/.test(asm)) vecInstr++;
      steps.push(
        Object.assign(
          {
            id,
            line,
            asm,
            regs: Object.assign({}, R, {
              xmm0: R.xmm0 && R.xmm0.slice(),
              xmm1: R.xmm1 && R.xmm1.slice(),
              xmm2: R.xmm2 && R.xmm2.slice(),
            }),
            status: status.slice(),
            counts: counts.slice(),
            win,
            found,
            vecInstr,
          },
          info
        )
      );
    }

    /** One byte, scalar. Returns true if it must be encoded. */
    function scalarByte(i, limit) {
      const b = BYTES[i];
      const lo = b & 15;
      const hi = b >> 4;
      R.rcx = i;
      win = [i, 1];
      R.rax = b;
      R.maskLive = false;
      exec('s_load', {
        mem: [i, 1],
        dst: ['rax'],
        narr: `movzx loads byte ${i} (${q(b)}, 0x${hex2(b)}) from memory into rax. One byte of data now sits in a 64-bit register.`,
      });
      R.rdx = b;
      exec('s_mov', { dst: ['rdx'], src: ['rax'], narr: 'Copy the byte into rdx so it can be split into two 4-bit halves (nibbles).' });
      R.rdx = lo;
      exec('s_and', { dst: ['rdx'], narr: `Keep the low nibble: 0x${hex2(b)} & 0x0F = ${lo}. It picks the column of the set table.` });
      R.rdx = TABLE[lo];
      exec('s_row', {
        dst: ['rdx'],
        grid: { col: lo },
        narr: `Load table[${lo}] = 0b${TABLE[lo].toString(2).padStart(8, '0')} from memory: column ${lo} of the set. Bit h is set when the byte h·16 + ${lo} is in the set.`,
      });
      R.rdx = TABLE[lo] | 0xff00;
      exec('s_or', { dst: ['rdx'], narr: 'Set bits 8–15, so a non-ASCII byte (high nibble 8–15) always tests as "must encode".' });
      R.rax = hi;
      exec('s_shr', { dst: ['rax'], narr: `Shift right by 4 to get the high nibble: ${hi}. It picks the row.` });
      const hit = inSet(b);
      R.cf = hit ? 1 : 0;
      status[i] = hit ? 2 : 1;
      exec('s_bt', {
        src: ['rax', 'rdx'],
        grid: { col: lo, row: hi, hit },
        checked: [i],
        narr: hit
          ? `Bit ${hi} of the row is set: byte ${i} (${q(b)}) must be percent-encoded.`
          : `Bit ${hi} of the row is clear: ${q(b)} can be copied as-is. That took 7 instructions for one byte.`,
      });
      if (hit) {
        found = i;
        exec('s_jc', { branch: true, narr: `Carry is set, so jump to the exit. The first byte to encode is at index ${i}.` });
        return true;
      }
      exec('s_jc', { narr: 'Carry clear: no jump.' });
      R.rcx = i + 1;
      exec('s_inc', { dst: ['rcx'], narr: `Move to the next byte: i = ${i + 1}.` });
      exec('s_cmp', { src: ['rcx'], narr: `Compare i with ${limit}.` });
      exec('s_jb', {
        branch: i + 1 < limit,
        narr: i + 1 < limit ? 'Jump back for the next byte. 11 instructions per byte so far.' : 'Fall through: this loop is finished.',
      });
      return false;
    }

    if (variantId === 'scalar') {
      for (let i = 0; i < LEN; i++) if (scalarByte(i, LEN)) break;
      return { program, steps, found };
    }

    // ---- SIMD: scalar head, setup, then 16-byte loads ----
    for (let i = 0; i < SCALAR_HEAD; i++) if (scalarByte(i, SCALAR_HEAD)) return { program, steps, found };

    R.xmm5 = TABLE.slice();
    exec('v_tab', {
      dst: ['xmm5'],
      mem: null,
      table: true,
      narr: 'Load the whole 16-byte set table into xmm5. Lane lo holds table[lo]: its 8 bits are the column of the grid below it.',
    });
    R.xmm6 = POW2.slice();
    exec('v_pow', { dst: ['xmm6'], narr: 'Load POW2 = 1, 2, 4 … 128 and then eight zeros: lane h holds the bit for high nibble h.' });
    R.xmm7 = LOW.slice();
    exec('v_low', { dst: ['xmm7'], narr: 'Load 0x0F into all 16 lanes, used to keep one nibble of each byte.' });

    let i = SCALAR_HEAD;
    for (;;) {
      const v = BYTES.slice(i, i + 16);
      R.rcx = i;
      R.maskLive = false;
      win = [i, 16];
      R.xmm0 = v.slice();
      exec('v_load', {
        mem: [i, 16],
        dst: ['xmm0'],
        narr: `One instruction loads 16 bytes, i = ${i} to ${i + 15}, into the 128-bit register xmm0.`,
      });
      const lo = v.map((b) => b & 15);
      R.xmm1 = lo.slice();
      exec('v_lo', { dst: ['xmm1'], src: ['xmm0', 'xmm7'], lanes: true, narr: 'AND every lane with 0x0F at once: 16 low nibbles in one instruction.' });
      R.xmm1 = lo.map((n) => TABLE[n]);
      exec('v_row', {
        dst: ['xmm1'],
        src: ['xmm5'],
        shuffle: { from: 'xmm5', idx: lo },
        lanes: true,
        narr: 'pshufb: each lane uses its low nibble as an index into xmm5 and fetches that table byte. 16 table lookups, one instruction.',
      });
      // psrlw shifts 16-bit lanes, so each byte's low half picks up bits from its neighbour.
      const sh = [];
      for (let k = 0; k < 16; k += 2) {
        const w = (v[k] | (v[k + 1] << 8)) >> 4;
        sh.push(w & 0xff, (w >> 8) & 0xff);
      }
      R.xmm2 = sh.slice();
      exec('v_srl', {
        dst: ['xmm2'],
        src: ['xmm0'],
        lanes: true,
        narr: 'Shift right by 4. x86 has no byte shift, so this shifts 16-bit pairs and even lanes pick up 4 stray bits from their neighbour.',
      });
      const hi = v.map((b) => b >> 4);
      R.xmm2 = hi.slice();
      exec('v_hi', { dst: ['xmm2'], src: ['xmm2', 'xmm7'], lanes: true, narr: 'AND with 0x0F clears the stray bits, leaving the 16 high nibbles.' });
      R.xmm2 = hi.map((h) => POW2[h]);
      exec('v_bit', {
        dst: ['xmm2'],
        src: ['xmm6'],
        shuffle: { from: 'xmm6', idx: hi },
        lanes: true,
        narr: 'Second pshufb: look up 1 << hi for every lane. Non-ASCII bytes (hi ≥ 8) get 0.',
      });
      const anded = R.xmm1.map((r, k) => r & R.xmm2[k]);
      R.xmm1 = anded.slice();
      exec('v_and', { dst: ['xmm1'], src: ['xmm1', 'xmm2'], lanes: true, narr: 'row & bit keeps only the bit for each byte’s own high nibble.' });
      const eq = anded.map((x, k) => (x === R.xmm2[k] ? 0xff : 0));
      R.xmm1 = eq.slice();
      const checked = [];
      eq.forEach((m, k) => {
        status[i + k] = m ? 2 : 1;
        checked.push(i + k);
      });
      const hits = eq.filter(Boolean).length;
      exec('v_eq', {
        dst: ['xmm1'],
        src: ['xmm1', 'xmm2'],
        lanes: true,
        checked,
        gridLanes: v,
        narr: hits
          ? `Compare: lanes where row & bit == bit become 0xFF. ${hits === 1 ? 'One lane says' : `${hits} lanes say`} “encode me”. 16 verdicts in one instruction.`
          : 'Compare: a lane becomes 0xFF if its byte is in the set. Here every lane is 0x00, so all 16 bytes can be copied. 16 verdicts in one instruction.',
      });
      let mask = 0;
      eq.forEach((m, k) => m && (mask |= 1 << k));
      R.rax = mask;
      R.maskLive = true;
      exec('v_msk', {
        dst: ['rax'],
        src: ['xmm1'],
        movemask: true,
        narr: `pmovmskb copies the top bit of each lane into eax: bit k = lane k. eax = 0x${mask.toString(16).padStart(4, '0')}.`,
      });
      exec('v_test', { src: ['rax'], narr: mask ? 'eax is non-zero: some lane matched.' : 'eax is zero: nothing to encode in these 16 bytes.' });
      if (mask) {
        exec('v_jnz', { branch: true, narr: 'Jump to the exit.' });
        const lane = Math.log2(mask & -mask);
        R.rax = lane;
        R.maskLive = false;
        exec('f_tz', { dst: ['rax'], narr: `tzcnt counts trailing zero bits: the first match is lane ${lane}.` });
        found = i + lane;
        R.rax = found;
        exec('f_add', {
          dst: ['rax'],
          found: true,
          narr: `index = ${i} + ${lane} = ${found}: byte ${found} (${q(BYTES[found])}) is the first byte to encode.`,
        });
        return { program, steps, found };
      }
      exec('v_jnz', { narr: 'No jump.' });
      R.rcx = i + 16;
      exec('v_add', { dst: ['rcx'], narr: `Advance 16 bytes: i = ${i + 16}.` });
      const fits = i + 16 + 16 <= LEN;
      exec('v_cmp', { src: ['rcx'], narr: `Is there room for another full 16-byte load? (i ≤ ${LEN - 16})` });
      exec('v_jbe', { branch: fits, narr: fits ? 'Yes: loop.' : `No: only ${LEN - i - 16} bytes are left.` });
      if (fits) {
        i += 16;
        continue;
      }
      i += 16;
      exec('t_cmp', { src: ['rcx'], narr: `${LEN - i} bytes remain unchecked.` });
      if (i >= LEN) {
        exec('t_jae', { branch: true, narr: 'Nothing left.' });
        return { program, steps, found };
      }
      exec('t_jae', { narr: 'Some bytes remain.' });
      R.rcx = LEN - 16;
      exec('t_mov', {
        dst: ['rcx'],
        narr: `Rather than finish byte by byte, step back to i = ${LEN - 16} and load the last 16 bytes. ${i - (LEN - 16)} of them were already checked, which is harmless.`,
      });
      exec('t_jmp', { branch: true, narr: 'One more trip around the vector loop.' });
      i = LEN - 16;
    }
  }

  /**
   * Instruction count for a clean input of n bytes in this model, with the
   * real loop's 4×16 unrolling for long runs (scan! in simd.rs).
   */
  function countFor(variantId, n) {
    if (variantId === 'scalar') return n * 11;
    let c = SCALAR_HEAD * 11 + 3; // head + setup
    const rest = n - SCALAR_HEAD;
    c += 14; // first 16 bytes
    let i = 16;
    while (i + 64 <= rest) {
      c += 4 * 8 + 3 + 6; // 4 × (load + 7 classify), 3 por, movemask/test/jnz/add/cmp/jbe
      i += 64;
    }
    while (i < rest) {
      c += 14;
      i += 16;
    }
    return c;
  }

  // ---- the simulation interface ----------------------------------------------

  const traces = {};
  const traceFor = (id) => (traces[id] = traces[id] || buildTrace(id));

  class SimdSim {
    constructor({ variant }) {
      this.variant = variant;
      const tr = traceFor(variant.id);
      this.program = tr.program;
      this.steps = tr.steps;
      this.found = tr.found;
      this.N = this.steps.length;
      this.bytes = BYTES;
      this.query = QUERY;
      this.urlPrefix = URL_PREFIX;
      this.table = TABLE;
      this.inSet = inSet;
      this.time = 0;
      this.hook = null;
      this.breakFlag = false;
      this.log = [];
      this.logSeq = 0;
      this.doneAt = null;
      this.paramValue = null;
      this.stats = { bytesFetched: 0 };
    }

    get finished() {
      return this.doneAt != null;
    }

    /** Index of the instruction being executed (or just finished, at whole times). -1 before the first. */
    get cur() {
      return Math.min(this.N - 1, Math.ceil(this.time) - 1);
    }

    get retired() {
      return Math.min(this.N, Math.floor(this.time));
    }

    get narration() {
      const k = this.cur;
      if (k < 0) return { t: 0, text: this.variant.intro, cpu: null, seq: 0 };
      if (this.finished) return { t: this.N, text: this.variant.doneText(this), cpu: null, seq: this.N + 1 };
      const s = this.steps[k];
      return { t: k + 1, text: `${s.asm.replace(/\s+/g, ' ')}: ${s.narr}`, cpu: null, seq: k + 1 };
    }

    nextEventTime() {
      const n = Math.floor(this.time) + 1;
      return n <= this.N ? n : Infinity;
    }

    advanceTo(target) {
      for (;;) {
        const n = this.nextEventTime();
        if (n > target) break;
        this.time = n;
        this.retire(n - 1);
        if (this.breakFlag) {
          this.breakFlag = false;
          return true;
        }
      }
      if (!this.finished && target > this.time) this.time = Math.min(target, this.N);
      return false;
    }

    requestBreak() {
      this.breakFlag = true;
    }

    emit(type, data) {
      if (this.hook) this.hook(Object.assign({ type, t: this.time }, data), this);
    }

    retire(k) {
      const s = this.steps[k];
      this.log.push({ seq: ++this.logSeq, t: k + 1, text: s.asm.replace(/\s+/g, ' '), cpu: null });
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
      if (k === this.N - 1) this.doneAt = this.N;
      this.emit('retire', { idx: k, id: s.id });
      if (k === this.N - 1) this.emit('all-done', {});
    }

    /** Bytes classified so far (the scenario's unit of work). */
    totalOps() {
      const k = this.retired - 1;
      return k < 0 ? 0 : this.steps[k].status.filter(Boolean).length;
    }

    vectorInstructions() {
      const k = this.retired - 1;
      return k < 0 ? 0 : this.steps[k].vecInstr;
    }
  }

  // ---- presentation ----------------------------------------------------------

  const fmtInstr = (n) => `${Math.floor(n).toLocaleString()} instr`;

  const doneText = (extra) => (sim) =>
    `Found it: byte ${sim.found} (a space) is the first byte to percent-encode. Getting there took ${sim.N} instructions${extra(sim)}.`;

  // ---- guided tour ----
  // Stateless (Back/Replay re-run breakpoints): the trace records how many
  // times each line has run.
  const retired = (id, nth = 1) => (e, sim) =>
    e.type === 'retire' && e.id === id && sim.steps[e.idx].counts[sim.steps[e.idx].line] === nth;
  const allDone = (e) => e.type === 'all-done';
  const RIGHT_CARD = { x: 0.71, top: 0.385, width: 'min(420px, 52%)' };
  const LEFT_LOW = { x: 0.215, top: 0.5, width: 'min(400px, 42%)' };

  const scalarTotal = () => traceFor('scalar').steps.length;
  const simdTotal = () => traceFor('simd').steps.length;

  const TOUR = {
    variant: 'scalar',
    card: RIGHT_CARD,
    steps: [
      {
        title: 'Percent-encoding a query string',
        body:
          `<code>Url::parse("${URL_PREFIX}…")</code> copies the query into the URL and percent-encodes any byte in the ` +
          '<code>SPECIAL_QUERY</code> set: control characters, space, <code>"</code> <code>#</code> <code>&lt;</code> <code>&gt;</code> and <code>\'</code>. ' +
          'Most bytes need no encoding, so the hot loop is “how far can I copy before the next byte that does?” ' +
          'This tab looks inside the CPU: the instructions on the left, and the registers they work on, on the right.',
        focus: ['memory', 'code'],
      },
      {
        title: 'One byte at a time',
        body:
          'The scalar loop loads byte 0 into <code>rax</code>, a 64-bit register, so 7 of its 8 bytes sit idle. ' +
          'It then splits the byte into two 4-bit nibbles: the low nibble picks a column of the set table, and the high nibble picks a row.',
        focus: ['memory', 'code', 'gpr'],
        speed: 700,
        until: retired('s_shr'),
      },
      {
        title: 'Look it up, test one bit',
        body:
          'The table holds the set as a 16 × 8 grid of bits, one bit for each ASCII character. ' +
          '<code>bt</code> tests the bit at (row, column). For <code>q</code> the bit is clear, so the byte is copied as-is. ' +
          'After 4 more instructions of loop bookkeeping, the loop moves on to the next byte.',
        focus: ['code', 'gpr', 'grid'],
        speed: 700,
        until: retired('s_jb'),
      },
      {
        get title() {
          return `…and again, ${traceFor('scalar').found + 1} times`;
        },
        body: () =>
          `That’s 11 instructions for each byte, and the space we are looking for is byte ${traceFor('scalar').found}. ` +
          `The whole search takes <b>${scalarTotal()} instructions</b>. The 128-bit vector registers on the right sit unused the entire time.`,
        focus: ['memory', 'code', 'gpr'],
        speed: 18,
        until: allDone,
      },
      {
        title: 'SIMD: one instruction, many bytes',
        variant: 'simd',
        body:
          'SIMD (single instruction, multiple data) registers are wide: <code>xmm0</code>–<code>xmm15</code> are 128 bits, ' +
          'or 16 byte-sized <b>lanes</b>. An instruction like <code>vpand</code> works on all 16 lanes at once. ' +
          'Short runs between special bytes are common, so the first 9 bytes are still checked one at a time before the vector loop starts.',
        focus: ['code', 'vec'],
        card: LEFT_LOW,
        speed: 18,
        until: retired('s_jb', SCALAR_HEAD),
      },
      {
        title: 'Load the set into a register',
        body:
          'The set table is exactly 16 bytes, so it fits in one register: <code>xmm5</code>. Lane <i>lo</i> holds the grid column for low nibble <i>lo</i>. ' +
          '<code>xmm6</code> holds 1 &lt;&lt; <i>hi</i> for each high nibble. These loads happen once per call.',
        focus: ['code', 'xmm5', 'xmm6', 'xmm7'],
        card: LEFT_LOW,
        speed: 500,
        until: retired('v_low'),
      },
      {
        title: '16 bytes, one load',
        body: '<code>vmovdqu</code> copies bytes 9 to 24 from memory into <code>xmm0</code>, one byte per lane.',
        focus: ['memory', 'xmm0'],
        card: LEFT_LOW,
        speed: 700,
        until: retired('v_load'),
      },
      {
        title: '16 table lookups in one instruction',
        body:
          '<code>vpand</code> keeps the low nibble of every lane. Then <code>vpshufb</code>, a byte shuffle, uses each lane’s value as an index into <code>xmm5</code>. ' +
          'Lane <i>k</i> receives <code>table[lo<sub>k</sub>]</code>. Each line in the diagram is one lookup, and all 16 happen together.',
        focus: ['xmm0', 'xmm1', 'xmm5', 'xmm7'],
        card: LEFT_LOW,
        speed: 900,
        until: retired('v_row'),
      },
      {
        title: 'The high nibbles',
        body:
          'x86 has no instruction that shifts bytes, so <code>vpsrlw</code> shifts 16-bit pairs and even lanes pick up 4 stray bits from their neighbour. ' +
          '<code>vpand</code> clears them. A second <code>vpshufb</code> turns each high nibble into its bit, 1 &lt;&lt; <i>hi</i>. A non-ASCII byte gets 0, which always counts as a match.',
        focus: ['xmm0', 'xmm2', 'xmm6', 'xmm7'],
        card: LEFT_LOW,
        speed: 900,
        until: retired('v_bit'),
      },
      {
        title: '16 verdicts at once',
        body:
          '<code>vpand</code> and <code>vpcmpeqb</code> answer “is this byte in the set?” for every lane. ' +
          '<code>vpmovmskb</code> packs the 16 answers into the low 16 bits of <code>eax</code>. Here the mask is 0, so all 16 bytes can be copied, ' +
          'and the loop moves on.',
        focus: ['memory', 'xmm1', 'mask'],
        card: LEFT_LOW,
        speed: 900,
        until: retired('v_test'),
      },
      {
        title: 'Run to the match',
        body: () =>
          'The second load is also clean. Only 15 bytes remain after it, so instead of a slow scalar tail, the code reloads the <i>last</i> 16 bytes, overlapping one byte it has already checked. ' +
          `Lane 11 is the space. <code>tzcnt</code> finds the lowest set bit of the mask, and the search ends after <b>${simdTotal()}</b> instructions instead of ${scalarTotal()}.`,
        focus: ['memory', 'code', 'mask'],
        card: { x: 0.71, top: 0.36, width: 'min(420px, 52%)' },
        speed: 90,
        until: allDone,
      },
      {
        title: 'Longer inputs',
        precompute: ['scalar'],
        final: true,
        body: () => {
          const kb = (v) => countFor(v, 1024);
          return (
            `On this 56-byte query, SIMD needs ${(scalarTotal() / simdTotal()).toFixed(1)}× fewer instructions. Most of what it does run is the 9-byte scalar head. ` +
            `On a 1 KB query, the real loop handles 64 bytes per iteration: about <b>${kb('simd').toLocaleString()}</b> instructions against ${kb('scalar').toLocaleString()} for the scalar loop, ` +
            `which is <b>${Math.round(kb('scalar') / kb('simd'))}× fewer</b>. Both results are on the right.`
          );
        },
        focus: null,
        card: { x: 0.71, top: 0.36, width: 'min(420px, 52%)' },
      },
    ],
  };

  const LEGEND = `
    <ul class="legend">
      <li><span class="sw" style="background:var(--ok)"></span><b>Copied as-is</b>: the byte is not in the set</li>
      <li><span class="sw" style="background:var(--bad)"></span><b>Must encode</b>: becomes %XX</li>
      <li><span class="sw" style="background:var(--accent)"></span><b>Written</b>: the register lanes that the current instruction wrote</li>
      <li><span class="sw round" style="background:#a855f7"></span><b>pshufb lookup</b>: a lane fetching a byte from a table register</li>
    </ul>
    <p class="note">To keep the picture readable, this model:</p>
    <ul class="note list">
      <li>counts instructions, not cycles. A real core runs several of these per cycle and overlaps loop iterations, but the scalar loop still costs a few cycles per byte against a fraction of a cycle per byte for SIMD.</li>
      <li>shows the SSSE3 loop in its AVX (VEX) form, as compiled with AVX enabled. Plain SSSE3 needs a few extra register copies.</li>
      <li>checks 16 bytes per iteration. On runs of 80 bytes or more, the real loop checks 64 bytes per iteration and tests the four masks together. On ARM, NEON <code>tbl</code> does the job of <code>pshufb</code>.</li>
    </ul>`;

  const UNIT = { one: 'byte checked', many: 'bytes checked', per: 'byte' };

  NS.scenarios.push({
    id: 'simd',
    title: 'SIMD',
    summary:
      'A loop that handles one byte per iteration leaves most of the CPU idle. SIMD instructions process 16 bytes at once, using registers most code never touches.',
    metric: 'completion',
    tour: TOUR,
    speed: 40,
    Sim: SimdSim,
    get View() {
      return NS.SimdView;
    },
    ariaLabel: 'A CPU’s registers and instruction stream scanning a URL query string for bytes to percent-encode',
    legendHtml: LEGEND,
    noLatencies: true,
    timeUnit: 'instruction',
    ff: { label: '+50 instr', title: 'Run 50 instructions instantly', amount: 50 },
    clockLabel: 'Instructions retired',
    fmtTime: fmtInstr,
    speedText(ms) {
      const f = ms * 1e-3 * 16e9; // ~4 instructions per cycle at 4 GHz
      return {
        label: `1 instruction = ${ms >= 10 ? Math.round(ms) : ms.toFixed(1)} ms`,
        sub: `A fast core retires up to ~16 of these per nanosecond, so this is roughly ${f >= 1e9 ? (f / 1e9).toFixed(1) + ' billion' : Math.round(f / 1e6) + ' million'}× slower than real hardware.`,
      };
    },
    statRows(sim) {
      const r = sim.retired;
      const b = sim.totalOps();
      return [
        ['Instructions retired', `${r.toLocaleString()}${sim.finished ? ' (done)' : ''}`],
        ['Bytes checked', `${b} of ${LEN}`],
        ['Vector instructions', sim.vectorInstructions().toLocaleString()],
        ['Instructions per byte', b ? (r / b).toFixed(2) : '—'],
      ];
    },
    compareSub: (r) => 'to find the first byte to encode',
    ratioText: (label, x) => `<strong>${label}</strong> needs <strong>${x}×</strong> fewer instructions here.`,
    countFor,
    variants: [
      {
        id: 'scalar',
        label: 'Byte at a time',
        tag: 'scalar',
        tone: 'bad',
        unit: UNIT,
        intro:
          `Find the first byte of “${QUERY}” that must be percent-encoded, one byte per loop iteration. Press Play or Step.`,
        doneText: doneText(() => ', about 11 per byte, in 64-bit registers that held 1 byte of data each time'),
        code: [
          '// percent_encode(query, SPECIAL_QUERY)',
          '// hot loop: how far can we copy as-is?',
          'fn find_encode(bytes: &[u8],',
          '               set: &AsciiSet) -> usize {',
          '    bytes.iter()',
          '        .position(|&b|',
          '            set.should_percent_encode(b))',
          '        .unwrap_or(bytes.len())',
          '}',
          '',
          '// impl AsciiSet',
          'fn should_percent_encode(&self, b: u8)',
          '    -> bool {',
          '    let lo = (b & 0x0F) as usize;',
          '    let row = self.table[lo] as u32;',
          '    // bits 8..16: non-ASCII always matches',
          '    ((row | 0xFF00) >> (b >> 4)) & 1 != 0',
          '}',
        ],
        hot: [5, 6, 13, 14, 16],
        note:
          'The table is the 128-character set stored as 16 bytes: bit hi of table[lo] is set when the byte hi·16 + lo is in the set. ' +
          'This is the same check the SIMD version makes, applied to one byte per iteration.',
      },
      {
        id: 'simd',
        label: '16 bytes at a time',
        tag: 'SIMD',
        tone: 'good',
        unit: UNIT,
        intro:
          'The same search with SSSE3: after a short scalar head, each loop iteration loads 16 bytes and classifies them all with a handful of vector instructions.',
        doneText: doneText((sim) => `, ${sim.steps[sim.N - 1].vecInstr} of them vector instructions`),
        code: [
          '// percent_encoding/src/simd.rs (SSSE3)',
          'let table = _mm_loadu_si128(set.table());',
          'let pow2  = _mm_loadu_si128(POW2);',
          'let low   = _mm_set1_epi8(0x0F);',
          'scan!(bytes, |v| {',
          '    let lo  = _mm_and_si128(v, low);',
          '    let row = _mm_shuffle_epi8(table, lo);',
          '    let hi  = _mm_and_si128(',
          '        _mm_srli_epi16(v, 4), low);',
          '    let bit = _mm_shuffle_epi8(pow2, hi);',
          '    // 0xFF where (row & bit) == bit',
          '    _mm_cmpeq_epi8(',
          '        _mm_and_si128(row, bit), bit)',
          '})',
          '// scan!: one 16-byte load per step, then',
          '// movemask + trailing_zeros on a hit',
        ],
        hot: [5, 6, 7, 8, 9, 11, 12],
        note:
          'AsciiSet stores its bitmap “nibble-transposed” so that the 16-byte table can be used directly by pshufb (_mm_shuffle_epi8). ' +
          'pshufb can only index 16 entries, so each byte is split into its low nibble (which column) and high nibble (which bit).',
      },
    ],
  });
})((window.CPUViz = window.CPUViz || {}));
