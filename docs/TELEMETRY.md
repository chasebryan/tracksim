# Telemetry

`packages/sim/src/telemetry` records one fixed-layout record per tick (100 per simulated second)
into a preallocated struct-of-arrays ring buffer and exports it in three formats.

## Record layout (`TELEMETRY_FIELDS`)

| field | kind | meaning |
|---|---|---|
| tick | i32 | tick index |
| time | f64 | seconds |
| truthE, truthN, truthVE, truthVN | f64 | platform truth |
| estE, estN, estVE, estVN | f64 | EKF estimate |
| posError, velError | f64 | estimate vs truth |
| posSigma, traceP | f64 | filter uncertainty |
| `<ID>_nis` | f32 | last NIS per sensor (INS, STAR, MAGGRAV, TERRAIN, SWARM) |
| `<ID>_influence` | f32 | last influence per sensor |
| `<ID>_isolated`, `<ID>_enabled` | u8 | sensor flags |
| tracksTotal, tracksConfirmed | i32 | tracker counts |
| detections, clutter | i32 | last scan (0 on non-scan ticks) |
| radarScan | u8 | 1 on scan ticks |
| tickMicros | f32 | measured compute cost of the tick |

## Ring buffer

One typed array per field (`Float64Array`, `Float32Array`, `Int32Array`, `Uint8Array`) sized to
`capacity` (default 36 000 = 6 minutes). `push` writes each column at `head` and advances it:
O(1), no allocation. `get(i)` and `column(field, n)` read oldest-first through the wrap.

Metrics are measured, not estimated: `recordsPerSec` counts records pushed in the last 100 ticks
(so it reads 100 at 1× and still 100 at 4× — it is sim-rate, which is the honest number),
`lastPushMicros` / `meanPushMicros` come from the injected clock around the push.

## Formats

- **JSONL** — one object per line, field names as keys, oldest first.
- **CSV** — header row of field names, one row per record.
- **Binary** — `"TSIM"`, `u32 version = 1`, `u32 headerLength`, UTF-8 JSON header
  `{fields, capacity, length, pushed}`, then each column's retained values oldest-first as a
  contiguous little-endian blob in field order. `decodeBinary` reverses it exactly.

A **recording** is separate from telemetry: `{version, seed, scenarioId, commands[], endTick}`.
It is tiny and reproduces the entire run, including every telemetry record.
