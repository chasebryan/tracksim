# tracksim — module contracts

This file is the source of truth for how the modules fit together. Signatures live in
`packages/sim/src/core/interfaces.ts` and data shapes in `packages/sim/src/core/types.ts`;
this document fixes the *behaviour* and parameters so independently written modules compose.

Rules that apply to every sim module:

- `packages/sim` has **no DOM**. Its tsconfig has `lib: ["ES2022"]` only. Wall-clock is never read
  inside domain logic; the only clock is the sim tick (`TICK_HZ = 100`, `DT = 0.01`).
- Modules import only from `../core/types`, `../core/constants`, `../core/rng`, `../core/interfaces`
  and `../math/*`. Modules never import each other.
- All randomness comes from an `Rng` passed in by the caller (`Rng.fromLabel(seed, '<module>')`).
  Draw order must be deterministic (iterate arrays in index order, maps in insertion order, never
  iterate object keys of user data).
- Every module that produces log lines implements `drainEvents()` and returns `SimEvent[]` created
  since the previous drain (then clears). `SimEvent.time = tick * DT`.
- Each module ships vitest tests next to its code (`*.test.ts`) that exercise real behaviour,
  not just construction.
- Do not add dependencies. `zod` is available in `@tracksim/sim`; nothing else.

## Tick pipeline (core/simulation.ts)

The simulation starts at `tick = 0` (initial state, `time = 0`). Each `step()` advances one tick
and returns the `Snapshot` for the new tick. "Due at tick T" means applied during the step that
produces tick T. Order inside a step, for the new tick `T`:

1. Apply queued operator commands whose recorded tick is `T` (commands enqueued while the sim was
   at tick `T-1` are recorded with `tick = T`).
2. Apply scenario events with `secondsToTick(event.t) === T`.
3. `world.step(T)` — platform truth and contacts.
4. `nav.step(T, world.platform)`.
5. If `radar.isScanTick(T)`: `detections = radar.scan(T, world.platform, world.contacts)`;
   `tracker.update(T, detections, 1 / scanHz)`.
6. `telemetry.push(record, T)` with the record laid out per `TELEMETRY_FIELDS`.
7. Assemble the `Snapshot`; `events` is the concatenation of `drainEvents()` from
   world, nav, radar, tracker, plus system/operator events for this tick, in that order.

`Simulation` also exposes: `enqueue(cmd)` (records `{tick: this.tick + 1, command}` into the
recording and applies it at step 1), `getRecording(): Recording`, `stepTo(tick)`,
`static fromRecording(scenario, recording)` which replays the command log, and `snapshot()`.
Seeking backwards is done by constructing a fresh `Simulation` and `stepTo(target)` — a 300 s run
is 30 000 ticks and must complete in well under a second in Node.

## world/

`class World implements IWorld`. `Rng.fromLabel(seed, 'world')`.

Platform kinematics per tick:
```
heading += turnRate * DT            (turnRate rad/s, 0 when expired)
speed   = max(0, speed + accel * DT)
vel     = [speed * sin(heading), speed * cos(heading)]
pos    += vel * DT
```
`setTurn(rate, untilTick)` / `setAccel(a, untilTick)` apply until `tick >= untilTick`, then reset to 0.
`alt` is constant from the scenario.

Contacts: alive when `spawnAt <= time < despawnAt` (missing spawnAt = 0, missing despawnAt = ∞).
Per tick for alive contacts: `pos += vel * DT + jitter * sqrt(DT) * N(0,1)` on each axis.
`spawnDecoys(count, tick, nearContactId?)`: reference = the named alive contact, else the first
alive non-decoy contact, else the platform. Each decoy: id from `9000 + counter`, kind `decoy`,
label `decoy`, declared `false`, pos = ref pos + uniform ring 300–800 m, vel = ref vel + N(0, 15)
per axis, `jitter = 60`, `pd = 0.65`, despawn 20–40 s later. Emit one `scenario`-source info event
per spawn batch. Despawning a contact emits an info event.

`contactSnapshots()` reports every contact (alive or not) relative to the platform:
`range = |rel|`, `bearing = atan2(relE, relN)`, `elevation = elevationDeg * DEG`.

## nav/

`class NavigationFilter implements INavigationFilter`. `Rng.fromLabel(seed, 'nav')`.

State `x = [pE, pN, vE, vN]`. Initialise from truth plus N(0, [20, 20, 2, 2]);
`P0 = diag(100², 100², 10², 10²)`. Predict every tick with `constantVelocity2D(DT, sigmaAccel = 2.0)`.

| id      | name                          | rate   | measures            | nominal σ                 |
|---------|-------------------------------|--------|---------------------|---------------------------|
| INS     | Inertial (speed/heading)      | 100 Hz | [speed, heading]    | 0.5 m/s, 0.003 rad        |
| STAR    | Star tracker (position fix)   | 20 Hz  | [pE, pN]            | 12 m                      |
| MAGGRAV | Magnetic/gravity map match    | 50 Hz  | [pE, pN]            | 60 m                      |
| TERRAIN | Terrain-contour radar fix     | 10 Hz  | [pE, pN]            | 8 m                       |
| SWARM   | Swarm-relative mesh fix       | 100 Hz | [pE, pN]            | 35 m                      |

A sensor is due when `tick % (TICK_HZ / rateHz) === 0` and it is enabled. Process sensors in
`SENSOR_IDS` order. Generated measurement:
```
z = h(truth) + bias + noiseScale * σ ⊙ N(0,1)      (+ INS slow bias random walk, see below)
```
INS carries a bias random walk on both components: `σ_rw = 0.02 m/s/√s` and `0.0002 rad/√s`.
The filter always assumes the **nominal** R — it does not know about disturbances; that is what
makes gating meaningful. INS uses `updateNonlinear` with
`h(x) = [sqrt(vE²+vN²), atan2(vE, vN)]`, Jacobian rows `[0,0,vE/s, vN/s]` and
`[0,0, vN/s², -vE/s²]` (guard `s < 0.1`: skip the update), and a residual that wraps the heading
component with `wrapAngle`. Position sensors use `H_POSITION_2D`.

Gate: `chi2Critical(2, 0.99) = 9.21` for every sensor. Bookkeeping per sensor: `lastNis`, `meanNis`
(EMA α = 0.05), `accepted`, `rejected`, `consecutiveRejects`, `influence`, `meanInfluence`
(EMA α = 0.05, decays toward 0 on rejected updates). `isolated` becomes true when
`consecutiveRejects >= ceil(rateHz * 0.5)` (half a second of rejections) — emit a `nav` `warn`
event once on isolation and a `nav` `info` event when the next measurement is accepted.
Disturbances: `setDisturbance(id, {noiseScale, bias, untilTick})`, expire automatically, and
`clearDisturbance`. A disabled sensor produces nothing and reports `enabled: false`.

`estimate(truth)` fills `NavEstimate` including errors vs truth and
`posSigma = sqrt((P00 + P11) / 2)`, `velSigma = sqrt((P22 + P33) / 2)`.

## tracking/

`class Radar implements IRadar` (`Rng.fromLabel(seed, 'radar')`) and `class Tracker implements ITracker`.

Radar: `scanHz = 10` (scan on ticks where `tick % 10 === 0`, tick 0 excluded), `maxRange = 60 000 m`,
`σ_range = 30 m`, `σ_bearing = 0.3°`. Detection probability by kind: vehicle 0.95, beacon 0.98,
decoy 0.7, overridden by `spec.pd`; `setPd` sets a global multiplier (clamped so pd ≤ 1) until a
tick. For each alive contact within range, with probability pd: measurement = truth relative
position perturbed in range/bearing, covariance = R(θ) diag(σ_r², (r σ_b)²) R(θ)ᵀ expressed in the
world-aligned frame; `elevation = spec elevation + N(0, 0.2°)`, `contactId = spec.id`,
`declaredLabel = spec.declared ? spec.label : null`. Then `Poisson(clutterRate)` false detections
uniformly over the disc (range = maxRange·√u), `contactId = null`, `declaredLabel = null`,
elevation uniform ±5°. Default `clutterRate = 2`. `status()` reports the last scan's counts.

Tracker: constant-velocity KF per track in the **relative** frame with `sigmaAccel = 8 m/s²`
(absorbs platform manoeuvres). Per `update(tick, detections, dtScan)`:

1. Predict every live (non-dropped) track by `dtScan`.
2. Gate every (track, detection) pair: `d² = yᵀ S⁻¹ y`, `S = H P Hᵀ + R_det`; keep pairs with
   `d² <= gateChi2`.
3. Greedy global nearest neighbour: sort kept pairs ascending by `d²`, assign while both sides are
   unassigned.
4. Assigned tracks: KF update, `hits++`, `consecutiveMisses = 0`, push `1` into the hit window.
   Unassigned tracks: `misses++`, `consecutiveMisses++`, push `0`.
5. Unassigned detections start tentative tracks: `x = [pos, 0, 0]`, `P = diag(R_det, 30², 30²)`,
   id from an incrementing counter starting at 1.
6. Status: `tentative` until M-of-N over the hit window is met; `confirmed` when confirmed and hit
   this scan; `coasting` when confirmed and missed this scan; `dropped` when
   `consecutiveMisses >= K_confirmed` (confirmed) or `>= K_tentative` (tentative). Dropped tracks
   stay in `tracks()` with status `dropped` for 10 more scans, then are removed.

| gate   | gateChi2 (dof 2) | M of N | K_confirmed | K_tentative |
|--------|------------------|--------|-------------|-------------|
| loose  | 13.816 (0.999)   | 2 / 4  | 8           | 3           |
| normal | 9.21 (0.99)      | 3 / 5  | 5           | 2           |
| strict | 5.991 (0.95)     | 4 / 6  | 3           | 2           |

`quality = 0.6 * hitRatio(last 10 scans) + 0.4 * clamp(1 - posSigma / 400, 0, 1)`.
Label: majority of `declaredLabel` votes over associated detections, confidence = majority / hits;
no votes → `unknown`, confidence 0. `applyIntel(contactId, label)` records a mapping; any track
associated with a detection whose `contactId` is mapped takes that label with confidence 1.
`setLabel` is an operator override with confidence 1 (returns false for unknown id).
`contactId` in the snapshot is the most frequently associated contact id (null if clutter-only).
Events (`tracking` source): confirmation (info, include range in km and bearing in degrees),
drop (warn), operator/intel relabel (info). Suppress per-scan chatter.

## scenario/

`parseScenario(json: unknown): Scenario` validates with zod and throws a readable error listing the
path of each problem. `class ScenarioPlayer implements IScenarioPlayer` precomputes
`secondsToTick(e.t)` per event; `eventsDue(tick)` returns events in authored order.
`phaseAt(time)` returns the name of the last phase with `t <= time` (first phase before that).
Events with a `durationS` expire at `secondsToTick(t + durationS)`; the orchestrator passes that as
`untilTick` (Infinity when absent).

Built-in scenarios live in `packages/sim/scenarios/*.json` and are exported from
`scenario/builtin.ts` as `BUILTIN_SCENARIOS: Scenario[]` (validated on import) plus
`getScenario(id)`. Author these four, each with 4–5 phases and a `description`:

- `baseline` (120 s): nominal sensors; contacts: one declared friendly beacon, two undeclared
  vehicles (one gets `intel: hostile` at t=40); a 20°/s… no: a gentle `platform.turn` of 3°/s for
  15 s at t=50.
- `sensor-degradation` (180 s): `TERRAIN` noise ×10 at t=30 for 40 s; `STAR` disabled t=60–100
  (two `sensor.enable` events); `SWARM` bias [400, −150] m at t=90 for 50 s; log events at each.
- `decoy-swarm` (150 s): three vehicles; at t=40 `contacts.spawn` six decoys around contact 2
  (jitter 60, pd 0.65, despawn ≈ t=75); `radar.clutter` 10 at t=70 for 40 s.
- `full-mission` (300 s): five phases combining the above with a platform turn and acceleration.

Contacts should sit 5–45 km from the platform with plausible speeds (50–300 m/s) so that most stay
in radar range for the whole scenario.

## telemetry/

`TELEMETRY_FIELDS: TelemetryField[]` (in `telemetry/schema.ts`) in this order:
`tick i32, time f64, truthE f64, truthN f64, truthVE f64, truthVN f64, estE f64, estN f64,
estVE f64, estVN f64, posError f64, velError f64, posSigma f64, traceP f64`, then for each sensor
in `SENSOR_IDS` order: `<ID>_nis f32, <ID>_influence f32, <ID>_isolated u8, <ID>_enabled u8`,
then `tracksTotal i32, tracksConfirmed i32, detections i32, clutter i32, radarScan u8,
tickMicros f32`. Export a helper `buildTelemetryRecord(snapshotParts)` that lays a record out in
this order so the orchestrator cannot get it wrong.

`class TelemetryRing implements ITelemetryRing` — struct-of-arrays: one typed array per field,
preallocated to `capacity` (default 36 000), head index, O(1) push, no per-push allocation.
Push cost is measured with an injected `now(): number` (milliseconds, default
`globalThis.performance?.now` bound, else `() => 0`). `metrics(tick)`: `recordsPerSec` is the number
of records pushed in the last `TICK_HZ` ticks (sim-rate, honest), `lastPushMicros`, `meanPushMicros`
(EMA α = 0.01), `bytesPerRecord` from the field kinds, `totalBytes = bytesPerRecord * pushed`.
Encoders: `toJSONL()` (one object per record, oldest first), `toCSV()` (header row), `toBinary()`:
ASCII magic `TSIM`, u32 version = 1, u32 header length, UTF-8 JSON header
`{fields, capacity, length, pushed}`, then each column's retained values oldest-first as a
contiguous little-endian blob in field order. `decodeBinary(buf)` returns
`{fields, records: number[][]}` and must round-trip.

## hud/ (packages/hud)

Vite app. Entry `src/main.ts`, worker `src/worker/sim.worker.ts` (`new Worker(new URL(...), {type:'module'})`).

Worker protocol (`src/worker/protocol.ts`, shared types):

Host → worker:
- `{type:'init', scenarioId, seed}` → replies `ready`.
- `{type:'play'}`, `{type:'pause'}`, `{type:'speed', value}` (0.25–8).
- `{type:'seek', tick}` — rebuild from scratch and `stepTo(tick)` replaying the recorded commands.
- `{type:'step', ticks}` — advance N ticks while paused; reply with a `frame`.
- `{type:'command', command}` — operator `Command`.
- `{type:'export', format:'jsonl'|'csv'|'bin'|'recording'}` → `{type:'export', format, data}`.
- `{type:'loadRecording', recording}` → rebuilds with that seed/scenario and replays.

Worker → host:
- `{type:'ready', scenarios:[{id,name,durationS,description}], scenarioId, seed}`
- `{type:'frame', snapshot, terminal: string[], series: Record<string, Float32Array>, playing, speed}`
  — at most one per 16 ms while playing, plus one after pause/seek/step. `terminal` = the last 24
  telemetry records formatted as fixed-width text lines; `series` = the last 300 samples of
  `posError`, `posSigma`, `traceP` and each `<ID>_nis`.
- `{type:'export', ...}`, `{type:'error', message}`.

The worker's run loop uses `performance.now()` deltas × speed with an accumulator; if it falls more
than 0.5 s behind it drops the excess and emits a `system` warn event. When the scenario end is
reached it pauses.

Layout (one screen, dark cyan aesthetic, monospace, no external fonts or CDNs):
- Top bar: title, scenario select, seed input + "reseed", play/pause, speed buttons, T+ time,
  phase name, tick cost.
- Left column: platform (truth vs estimate, position error, speed/heading), five sensor cards
  (name, rate, enabled toggle, NIS, mean influence bar, accepted/rejected, ISOLATED badge),
  filter integrity (posSigma, trace P).
- Centre: the layered globe canvas — static offscreen layer (sphere wireframe, range rings at
  15/30/45/60 km, azimuth ticks) redrawn only on rotate/resize; dynamic layer (sweep at the scan
  cadence, tracks with brackets/labels coloured by label, faint last-scan detections, optional
  truth overlay, nav uncertainty circle at centre). Drag to rotate. DPR handled once per resize.
- Right column: radar/tracker status, gate control (loose/normal/strict), disturbance buttons
  (inject TERRAIN noise ×10 for 20 s, spoof SWARM +400 m for 20 s, clutter burst ×10 for 20 s,
  spawn 6 decoys), scope canvas (real series from `series`), track list — keyed by track id,
  create/update/remove nodes in place, filter buttons by label, click a card to label it.
- Bottom: telemetry terminal (the `terminal` lines, replace text in fixed row elements — no node
  churn), measured metrics, export buttons, timeline scrubber (seek), event log (last 40 events,
  newest on top, keyed by tick+index).
- Expose `window.__tracksim = { ready: Promise<void>, pause(), play(), step(ticks): Promise<Snapshot>,
  seek(tick): Promise<Snapshot>, snapshot(): Snapshot | null, send(command) }` for e2e and the demo
  recorder. `data-testid` attributes on the key readouts listed in `e2e/hud.spec.ts`.

## tools/

- `tools/run-scenario.ts <scenarioId> [seconds] [seed]` — headless run, prints a summary table
  (final pos error, mean pos error, per-sensor accept/reject/isolated, confirmed tracks, decoys
  dropped, ms per 1000 ticks) and exits non-zero if the filter diverged (mean pos error > 200 m).
- `tools/record-demo.ts` — Playwright: open the preview URL, wait for `__tracksim.ready`, pause,
  then for each frame call `step(ticksPerFrame)` and screenshot into `out/frames/`; then ffmpeg
  → `out/tracksim-demo.mp4` (30 fps, libx264, yuv420p). Defaults: `full-mission`, 20 ticks/frame.
