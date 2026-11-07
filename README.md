# CPU Viz

Interactive visualizations of how memory layout decisions play out on real
hardware: caches, cache lines and coherence traffic, with animation timed to
the nanoseconds each operation costs.

## Run it

Open `index.html` in a browser. There is no build step and no dependencies.
(Or serve the folder: `python3 -m http.server` and visit http://localhost:8000.)

Deep-link params: `?scenario=aos-soa&variant=padded&speed=5&t=250&paused=1`
(`speed` is milliseconds of screen time per simulated nanosecond).
`?tour=1` starts the guided tour (`?tour=4` jumps to step 4).

## Guided tour

The tour auto-starts on a first visit (remembered in `localStorage`) and can be
restarted with the **Guided tour** button. Each step spotlights parts of the
diagram, plays the simulation at its own slowed-down speed, and pauses on a
hardware event emitted by the engine (`miss`, `phase-start`, `phase-end`,
`op-done`). Because the simulation is deterministic, Back/Replay just rebuild
it and fast-forward through earlier steps. Tours live on the scenario
(`scenario.tour`); the controller is `js/tour.js`. A step can switch layouts
with `variant: '<id>'` (the AoS vs SoA tour runs AoS, then SoA), and a tour can
place its card with `card: { x, top, width }`. Each scenario's tour auto-starts
on its first visit.

## Scenarios

- **False sharing**: four threads increment their own counters. Packed into one
  64-byte line, the cores ping-pong ownership (invalidate → write-back → DRAM
  fetch) for every increment. Padded to a line each, they run from L1 at ~1 ns.
- **AoS vs SoA**: four threads each sum the `x` of 8 particles (`{x, y, z, mass}`).
  As an array of structs, each 64-byte line holds 2 useful values and 6 the loop
  never reads (25% of fetched bytes used, 408 ns). As a struct of arrays, each
  line is 8 consecutive `x` values (100% used, 108 ns). No prefetcher is modeled.

## Layout

| File | Role |
| --- | --- |
| `js/engine.js` | Discrete-event simulator: cores, one-line L1s, simplified MESI, DRAM. Time is in simulated ns. |
| `js/scenarios/*.js` | Scenario definitions: memory layout, per-thread op stream, code, narration. |
| `js/view.js` | SVG renderer. Packet positions derive from simulated time, so durations are proportional to latency. |
| `js/tour.js` | Guided tour controller: spotlight, per-step speed, breakpoints. |
| `js/main.js` | Controls, side panels, animation loop. |

To add a scenario, push another object onto `CPUViz.scenarios` (see
`false-sharing.js`, `aos-soa.js`) and include its script in `index.html`. Ops are
`{ kind: 'read' | 'write' | 'rmw', addr, desc }`; returning `null` from
`nextOp` ends that thread, and a scenario with `metric: 'completion'` is scored
on time-to-finish instead of throughput. `slotStyle(line, slot)` controls how
each 8-byte slot is labelled and coloured.
