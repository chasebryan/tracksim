# Architecture

tracksim is split into a pure simulation core and a thin HUD. The core never touches the DOM or a
wall clock; the HUD never computes anything about the world — it renders snapshots and sends
commands.

```
packages/sim                                packages/hud
┌──────────────────────────────────────┐    ┌──────────────────────────────────┐
│ Simulation.step()  (100 Hz, tick)    │    │ main.ts                          │
│  1 commands  2 scenario events       │    │  ├─ worker bridge (postMessage)  │
│  3 World     4 NavigationFilter      │◀──▶│  ├─ GlobeRenderer (2 layers)     │
│  5 Radar → Tracker (10 Hz scans)     │    │  ├─ ScopeRenderer                │
│  6 TelemetryRing.push                │    │  └─ ui/* keyed DOM panels        │
│  7 Snapshot                          │    └──────────────────────────────────┘
└──────────────────────────────────────┘        runs in a Web Worker ▲
```

## Determinism

- One fixed step: `TICK_HZ = 100`, `DT = 0.01 s`. Every module is driven by the tick index.
- One seed. `Rng.fromLabel(seed, 'world' | 'nav' | 'radar')` gives each module its own xoshiro128**
  stream, so a change in one module's draw count cannot shift another's.
- Operator commands are queued with the tick on which they apply and stored in the recording.
  A `Recording` is `{seed, scenarioId, commands[]}` — it reproduces the run exactly, which is how
  the timeline scrubber seeks backwards: construct a fresh `Simulation`, load the commands, `stepTo(t)`.
  30 000 ticks (a 300 s scenario) take a few hundred milliseconds in Node.
- Nothing in `packages/sim` reads `Date`, `Math.random` or timers. `performance.now` is injected
  only to *measure* tick and telemetry-push cost, and never influences state.

## Tick pipeline

Order inside `Simulation.step()` producing tick `T` (fixed in `CONTRACTS.md`):

1. Apply operator commands recorded for `T`.
2. Apply scenario events whose `secondsToTick(t) === T`.
3. `World.step(T)` — platform kinematics (turn/accel schedules), contact motion, spawn/despawn.
4. `NavigationFilter.step(T, truth)` — generate measurements for sensors due on `T`, EKF predict,
   gated updates.
5. On scan ticks (`T % 10 === 0`): `Radar.scan()` → detections + clutter; `Tracker.update()`.
6. `TelemetryRing.push(record)` — one struct-of-arrays record per tick.
7. Assemble the `Snapshot` (truth, estimate, sensor statuses, radar status, tracks, contacts,
   events drained from every module, telemetry metrics, measured tick cost).

## Worker protocol

The HUD hosts the simulation in a module Web Worker (`packages/hud/src/worker/sim.worker.ts`).
Messages are plain data (`packages/hud/src/contracts.ts`):

| direction | message | effect |
|---|---|---|
| host → worker | `init {scenarioId, seed}` | build a `Simulation`; reply `ready` with the scenario list |
| host → worker | `play` / `pause` / `speed {value}` | run loop control (accumulator on `performance.now()` × speed) |
| host → worker | `seek {tick}` | rebuild from the recording and `stepTo(tick)` |
| host → worker | `step {ticks}` | advance while paused (used by e2e tests and the demo recorder) |
| host → worker | `command {command}` | `Simulation.enqueue` |
| host → worker | `export {format}` | reply `export` with JSONL / CSV / binary telemetry or the recording |
| host → worker | `loadRecording {recording}` | rebuild with that seed + command log and replay |
| worker → host | `frame` | snapshot + 24 formatted terminal lines + 300-sample series; ≤ 1 per 16 ms |

If the worker falls more than 0.5 s behind real time it drops the excess and emits a `system` warn
event rather than silently running slow.

## Rendering

- The globe canvas has a static layer (sphere wireframe, range rings, azimuth ticks) rendered to an
  offscreen canvas only on resize/rotation, and a dynamic layer for the sweep, tracks and overlays.
  DPR is applied with `setTransform` once per resize.
- DOM panels are keyed: track cards and sensor cards are created once per id and updated in place
  with compare-before-write on text nodes; the terminal is 24 fixed rows whose text is replaced;
  the event log appends only new events.

## Testing

- `vitest` unit tests live beside each module and run in Node (the sim package has no DOM types,
  so accidental DOM use is a compile error).
- `playwright` e2e tests (`e2e/hud.spec.ts`) drive the built HUD through `window.__tracksim`
  and include a screenshot baseline.
- `tools/run-scenario.ts` runs any scenario headless and fails if the filter diverges.
