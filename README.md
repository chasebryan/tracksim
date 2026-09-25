# tracksim

A deterministic **sensor-fusion and multi-target tracking simulation sandbox** with a real-time HUD.

A platform flies a scripted path. Five simulated navigation sensors (inertial, star tracker,
magnetic/gravity map match, terrain-contour fix, swarm-relative mesh) feed one extended Kalman filter
with chi-square innovation gating. A simulated radar produces noisy detections plus Poisson clutter;
a multi-target tracker maintains tracks with gated nearest-neighbour association, M-of-N confirmation
and quality scoring. Scenarios degrade sensors, spoof fixes, raise clutter and spawn decoys — and the
HUD shows what the estimator actually does about it, against ground truth the sim knows and the
filter does not.

Everything is seeded and fixed-step, so a run is reproducible bit-for-bit, scrubbable backwards, and
testable in Node without a browser.

## Run

```bash
npm install
npm run dev            # HUD at http://localhost:5173
npm test               # unit tests (vitest, Node)
npm run build          # type-check + production build
npm run test:e2e       # Playwright against the built HUD
npm run sim:run -- full-mission 300 42   # headless run, summary table
npm run demo:record    # frames + MP4 of the real HUD into out/
```

## What is real here

| Readout | Where it comes from |
|---|---|
| Sensor "influence" | fractional reduction of trace(P) at that sensor's last accepted EKF update |
| NIS per sensor | innovation ᵀ S⁻¹ innovation, gated at χ²(2, 0.99) = 9.21 |
| ISOLATED badge | ≥ ½ s of consecutive gate rejections; clears on the next accepted measurement |
| Position error / σ | estimate vs simulated truth / sqrt of the position covariance |
| Track status | tentative → confirmed by M-of-N hits → coasting on misses → dropped |
| Track quality | 0.6 · hit ratio (last 10 scans) + 0.4 · positional certainty |
| Telemetry rate / cost | records pushed per second of sim time; measured push time in µs |

Nothing on screen is a random number dressed up as a metric.

## Layout

```
packages/sim        pure TypeScript, no DOM — the whole model, testable in Node
  src/core          types, constants, seeded RNG, module interfaces, Simulation orchestrator
  src/math          Mat, KalmanFilter (Joseph form, gating), chi-square table
  src/world         platform kinematics, contacts, decoys
  src/nav           five sensor models → EKF with innovation gating
  src/tracking      radar model, tracker (GNN association, M-of-N, quality, labels)
  src/scenario      zod schema, player, built-in scenarios (scenarios/*.json)
  src/telemetry     struct-of-arrays ring buffer, JSONL/CSV/binary encoders
packages/hud        Vite app — worker bridge, layered canvas renderers, keyed DOM panels
e2e                 Playwright tests + screenshot baseline
tools               headless runner, demo recorder (Playwright + ffmpeg)
docs                architecture, navigation, tracking, scenarios, telemetry
```

See `CONTRACTS.md` for the exact parameters every module implements and `docs/` for the maths.

## License

AGPL-3.0-or-later.
