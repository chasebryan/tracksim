# Scenarios

A scenario is data (`packages/sim/scenarios/*.json`), validated by a zod schema
(`packages/sim/src/scenario/schema.ts`) and played by tick. Phases are only names for the timeline;
**events** are what change the world.

```jsonc
{
  "id": "sensor-degradation",
  "name": "Sensor degradation",
  "description": "Terrain fix noise, star-tracker dropout and a spoofed swarm fix.",
  "durationS": 180,
  "seed": 7,
  "platform": { "pos": [0, 0], "vel": [176.8, 176.8], "alt": 9000 },
  "phases": [ { "t": 0, "name": "Nominal fusion" }, { "t": 30, "name": "Terrain fix degraded" } ],
  "contacts": [
    { "id": 1, "kind": "beacon", "label": "friendly", "declared": true,
      "pos": [12000, 4000], "vel": [-120, 60], "elevationDeg": 2, "jitter": 0 }
  ],
  "events": [
    { "t": 30, "type": "sensor.noise", "sensor": "TERRAIN", "scale": 10, "durationS": 40 },
    { "t": 60, "type": "sensor.enable", "sensor": "STAR", "enabled": false },
    { "t": 90, "type": "sensor.bias", "sensor": "SWARM", "bias": [400, -150], "durationS": 50 }
  ]
}
```

## Event types

| type | fields | effect |
|---|---|---|
| `sensor.noise` | sensor, scale, durationS? | multiply the generated measurement noise |
| `sensor.bias` | sensor, bias [E, N], durationS? | add a constant offset to generated measurements |
| `sensor.enable` | sensor, enabled | stop/start a sensor |
| `platform.turn` | rateDegS, durationS | constant-rate turn |
| `platform.accel` | mps2, durationS | along-track acceleration |
| `radar.clutter` | rate, durationS? | false alarms per scan (Poisson mean) |
| `radar.pd` | pd, durationS? | detection-probability multiplier |
| `contacts.spawn` | contacts[] | add contacts (decoys included) |
| `contact.despawn` | id | remove a contact |
| `intel` | contactId, label | external label feed for the tracker |
| `log` | message, level? | a line in the event log |

`t` is seconds; an event applies during the step that produces `round(t · 100)`. `durationS` makes it
expire; without it the effect lasts until the end.

## Built-in scenarios

| id | length | demonstrates |
|---|---|---|
| `baseline` | 120 s | nominal fusion, declared/undeclared contacts, an intel label, a gentle turn |
| `sensor-degradation` | 180 s | TERRAIN noise ×10, STAR dropout, SWARM bias — isolation and recovery |
| `decoy-swarm` | 150 s | six decoys around a contact, a clutter burst — gate trade-offs |
| `full-mission` | 300 s | all of the above across five phases with a turn and acceleration |

The same events are available live from the HUD as operator commands (inject noise, spoof, clutter
burst, spawn decoys, gate, sensor toggles). Commands are recorded with their tick, so a session can
be exported as a recording and replayed exactly.
