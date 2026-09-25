# Navigation fusion

`packages/sim/src/nav` fuses five simulated sensors into one estimate with an extended Kalman
filter. These are the equations the code implements — nothing here is decorative.

## State and process model

State `x = [pE, pN, vE, vN]ᵀ` (metres, metres/second, local east/north frame).
Predict every tick with the constant-velocity model, `dt = 0.01 s`:

```
F = [1 0 dt 0 ]        Q = σ_a² · [dt⁴/4   0     dt³/2   0   ]
    [0 1 0  dt]                   [0      dt⁴/4   0     dt³/2]
    [0 0 1  0 ]                   [dt³/2   0     dt²     0   ]
    [0 0 0  1 ]                   [0      dt³/2   0     dt²  ]

x⁻ = F x        P⁻ = F P Fᵀ + Q        σ_a = 2 m/s²
```

Initial `x₀` = truth + N(0, [20 m, 20 m, 2 m/s, 2 m/s]); `P₀ = diag(100², 100², 10², 10²)`.

## Sensors

| id | measures | rate | nominal σ | H / h(x) |
|---|---|---|---|---|
| INS | speed, heading | 100 Hz | 0.5 m/s, 0.003 rad | `h(x) = [√(vE²+vN²), atan2(vE, vN)]` |
| STAR | position | 20 Hz | 12 m | `H = [I₂ 0]` |
| MAGGRAV | position | 50 Hz | 60 m | `H = [I₂ 0]` |
| TERRAIN | position | 10 Hz | 8 m | `H = [I₂ 0]` |
| SWARM | position | 100 Hz | 35 m | `H = [I₂ 0]` |

The INS Jacobian at speed `s`:

```
∂h/∂x = [0 0  vE/s    vN/s  ]
        [0 0  vN/s²  −vE/s² ]
```

and its residual wraps the heading component to (−π, π]. INS also carries a slow bias random walk
(0.02 m/s/√s, 0.0002 rad/√s) that the filter does not model — a small, honest source of drift.

A **generated** measurement is `z = h(truth) + bias + noiseScale · σ ⊙ N(0,1)`. Scenario and operator
disturbances change `noiseScale` and `bias`; the filter **always assumes the nominal R**. That gap
is the point: the filter has to notice degradation from the innovations, not be told.

## Update with innovation gating

For each due measurement:

```
y = z ⊖ h(x⁻)                     innovation (⊖ wraps angles)
S = H P⁻ Hᵀ + R                   innovation covariance
NIS = yᵀ S⁻¹ y                    normalized innovation squared
```

If `NIS > χ²(2, 0.99) = 9.21` the measurement is **rejected** and the state is untouched. Otherwise:

```
K = P⁻ Hᵀ S⁻¹
x = x⁻ + K y
P = (I − K H) P⁻ (I − K H)ᵀ + K R Kᵀ      (Joseph form: stays symmetric and PSD)
```

`influence = 1 − trace(P) / trace(P⁻)` is the fractional uncertainty removed by that update. Its
moving average is the sensor "influence" bar on the HUD — the honest replacement for a hard-coded
weight. Under a consistent filter NIS is χ²-distributed with 2 degrees of freedom, so its mean sits
near 2; the HUD's per-sensor NIS sparklines show it against the 9.21 gate.

## Isolation

A sensor becomes **ISOLATED** after half a second of consecutive rejections
(`ceil(rateHz · 0.5)`: 50 for INS/SWARM, 25 for MAGGRAV, 10 for STAR, 5 for TERRAIN). Nothing
else changes — isolation is a status derived from gating, not a switch. The next measurement that
passes the gate clears it. Both transitions emit `nav` events.

What this produces in the scenarios:

- **Noise ×10 on TERRAIN** (σ 8 m → 80 m while the filter assumes 8 m): NIS ≈ 100, every
  measurement rejected, isolated within 0.5 s; the estimate keeps its accuracy from the other four.
- **Bias +400 m on SWARM** (σ 35 m): NIS ≈ 130; rejected, isolated; the bias never enters the
  estimate.
- **STAR dropout**: no measurements, `enabled: false`; position σ grows slightly, nothing else.
- If *every* position sensor were degraded, `P` would grow until the gate re-admits bad data —
  that is the real failure mode of gating, and the sandbox will show it.
