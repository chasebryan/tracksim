# Radar and tracking

`packages/sim/src/tracking` contains a simple radar detection model and a multi-target tracker.
It models *bookkeeping* — association, confirmation, coasting, dropping, quality and labelling —
not any signal-processing beyond additive noise and Poisson clutter.

## Radar model

- Scan every 10 ticks (10 Hz). Max range 60 km.
- Each alive contact within range is detected with probability `pd` (vehicle 0.95, beacon 0.98,
  decoy 0.7, or the contact's own `pd`).
- A detection is the true relative position perturbed in range and bearing
  (`σ_r = 30 m`, `σ_b = 0.3°`), reported with its covariance rotated into the east/north frame:

  ```
  R_det = R(θ) · diag(σ_r², (r · σ_b)²) · R(θ)ᵀ
  ```

  so a far contact has a long uncertainty ellipse across the line of sight — which is exactly what
  makes crossing tracks hard to separate at range.
- `Poisson(clutterRate)` false detections per scan, uniform over the disc (default rate 2/scan).
- A detection carries `declaredLabel` only if the contact broadcasts one (transponder). It also
  carries `contactId` as ground truth **for metrics only**; the tracker never uses it for
  association.

## Tracker

Each track is a constant-velocity Kalman filter in the platform-relative frame with
`σ_a = 8 m/s²` (large enough to absorb the platform's own manoeuvres).

Per scan:

1. Predict every live track forward by 0.1 s.
2. Gate every (track, detection) pair with the Mahalanobis distance
   `d² = yᵀ (H P Hᵀ + R_det)⁻¹ y`; keep pairs with `d² ≤ gateChi2`.
3. Greedy global nearest neighbour: sort surviving pairs by `d²`, assign each track and detection at
   most once.
4. Assigned tracks update; unassigned tracks record a miss; unassigned detections start tentative
   tracks with `x = [pos, 0, 0]`, `P = diag(R_det, 30², 30²)`.
5. Status transitions:

   ```
   tentative ──(M of the last N scans hit)──▶ confirmed ◀──hit── coasting
        │                                        │ miss              │
        └──(K_tentative consecutive misses)──▶ dropped ◀──(K_confirmed misses)
   ```

   Dropped tracks stay listed for 10 scans (so the HUD can show them fading) and are then removed.

| gate | gateChi2 | M of N | K_confirmed | K_tentative |
|---|---|---|---|---|
| loose | 13.816 (χ² 0.999) | 2 / 4 | 8 | 3 |
| normal | 9.21 (χ² 0.99) | 3 / 5 | 5 | 2 |
| strict | 5.991 (χ² 0.95) | 4 / 6 | 3 | 2 |

**Quality** `= 0.6 · (hits in the last 10 scans / scans alive, ≤ 10) + 0.4 · clamp(1 − σ_pos / 400 m)`.

## Labels

A track's label is data, never inference:

- majority of `declaredLabel` votes over its associated detections (confidence = majority / hits);
- an `intel` scenario event mapping a contact id to a label (confidence 1) — an external feed;
- an operator override from the HUD (confidence 1).

With no source it is `unknown`. Decoys are never "detected as decoys": they are contacts with low
`pd`, short lifetimes and a large position jitter, so their tracks confirm less often, carry lower
quality, coast more and drop sooner — most visibly under the `strict` gate, which also drops more
genuine tracks. That trade-off is the thing the sandbox exists to show.
