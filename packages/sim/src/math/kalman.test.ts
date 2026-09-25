import { describe, expect, it } from 'vitest';
import { DT, wrapAngle } from '../core/constants';
import { Rng } from '../core/rng';
import { constantVelocity2D, H_POSITION_2D, H_VELOCITY_2D, KalmanFilter } from './kalman';
import { Mat } from './mat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Largest |P_ij − P_ji| over a square matrix. */
function maxAsymmetry(p: Mat): number {
  let m = 0;
  for (let i = 0; i < p.rows; i++)
    for (let j = i + 1; j < p.cols; j++) m = Math.max(m, Math.abs(p.get(i, j) - p.get(j, i)));
  return m;
}

function minDiagonal(p: Mat): number {
  let m = Infinity;
  for (let i = 0; i < p.rows; i++) m = Math.min(m, p.get(i, i));
  return m;
}

/** h(x) = [speed, heading] for a [pE, pN, vE, vN] state (heading = atan2(vE, vN), 0 = north). */
function speedHeading(x: Mat): Mat {
  const vE = x.get(2, 0);
  const vN = x.get(3, 0);
  return Mat.col([Math.hypot(vE, vN), Math.atan2(vE, vN)]);
}

/** Jacobian of speedHeading at x, as specified in CONTRACTS.md for the INS sensor. */
function speedHeadingJacobian(x: Mat): Mat {
  const vE = x.get(2, 0);
  const vN = x.get(3, 0);
  const s = Math.hypot(vE, vN);
  return Mat.fromRows([
    [0, 0, vE / s, vN / s],
    [0, 0, vN / (s * s), -vE / (s * s)],
  ]);
}

/** Residual z ⊖ h(x) that wraps the heading component into (−π, π]. */
function wrapResidual(z: Mat, hx: Mat): Mat {
  return Mat.col([z.get(0, 0) - hx.get(0, 0), wrapAngle(z.get(1, 0) - hx.get(1, 0))]);
}

interface CvRunStats {
  /** RMS position error over samples after t = 10 s. */
  rmsPosAfter10s: number;
  meanNis: number;
  /** Sum of NEES samples after t = 10 s and their count, for pooling across runs. */
  neesSum: number;
  neesCount: number;
  rejected: number;
  steps: number;
  minInfluence: number;
  maxInfluence: number;
}

/**
 * 60 s of a 2-D constant-velocity target driven by white acceleration noise of
 * sd `sigmaAccel` (the same discrete model the filter assumes), observed by a
 * position sensor with σ = 10 m at 10 Hz. Truth, initial error and measurement
 * noise all come from one seeded Rng, so the run is reproducible.
 */
function runConstantVelocity(seed: number, gateChi2?: number): CvRunStats {
  const dt = 0.1;
  const sigmaAccel = 1.0;
  const sigmaZ = 10;
  const { F, Q } = constantVelocity2D(dt, sigmaAccel);
  const R = Mat.diag([sigmaZ * sigmaZ, sigmaZ * sigmaZ]);
  const rng = new Rng(seed);

  let pE = 1000;
  let pN = -500;
  let vE = 60;
  let vN = -30;
  const x0 = Mat.col([pE + rng.gaussian(0, 20), pN + rng.gaussian(0, 20), vE + rng.gaussian(0, 2), vN + rng.gaussian(0, 2)]);
  const P0 = Mat.diag([100 * 100, 100 * 100, 10 * 10, 10 * 10]);
  const kf = new KalmanFilter(x0, P0);

  const steps = 600;
  let nisSum = 0;
  let sqErr = 0;
  let errCount = 0;
  let neesSum = 0;
  let rejected = 0;
  let minInfluence = Infinity;
  let maxInfluence = -Infinity;
  for (let k = 1; k <= steps; k++) {
    // Truth: discrete white-noise-acceleration model, matching constantVelocity2D's Q exactly.
    const aE = rng.gaussian(0, sigmaAccel);
    const aN = rng.gaussian(0, sigmaAccel);
    pE += vE * dt + 0.5 * aE * dt * dt;
    vE += aE * dt;
    pN += vN * dt + 0.5 * aN * dt * dt;
    vN += aN * dt;

    kf.predict(F, Q);
    const z = Mat.col([pE + rng.gaussian(0, sigmaZ), pN + rng.gaussian(0, sigmaZ)]);
    const res = gateChi2 === undefined ? kf.update(z, H_POSITION_2D, R) : kf.update(z, H_POSITION_2D, R, { gateChi2 });
    nisSum += res.nis;
    if (!res.accepted) rejected++;
    minInfluence = Math.min(minInfluence, res.influence);
    maxInfluence = Math.max(maxInfluence, res.influence);

    if (k * dt > 10) {
      const e = Mat.col([kf.x.get(0, 0) - pE, kf.x.get(1, 0) - pN, kf.x.get(2, 0) - vE, kf.x.get(3, 0) - vN]);
      sqErr += e.get(0, 0) ** 2 + e.get(1, 0) ** 2;
      errCount++;
      neesSum += kf.P.inverse().quadForm(e);
    }
  }
  return {
    rmsPosAfter10s: Math.sqrt(sqErr / errCount),
    meanNis: nisSum / steps,
    neesSum,
    neesCount: errCount,
    rejected,
    steps,
    minInfluence,
    maxInfluence,
  };
}

// ---------------------------------------------------------------------------
// (a) consistency on a constant-velocity target
// ---------------------------------------------------------------------------

describe('KalmanFilter on a 2-D constant-velocity target (σ_z = 10 m, 10 Hz, 60 s)', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const runs = SEEDS.map((seed) => runConstantVelocity(seed));

  it('RMS position error after the first 10 s is below the measurement σ', () => {
    // Tracking index Λ = σ_a·dt²/σ_z = 1e-3 gives a steady-state position σ ≈ 2 m, far below 10 m.
    for (const r of runs) expect(r.rmsPosAfter10s).toBeLessThan(10);
  });

  it('mean NIS over each run lies in [1.5, 2.6] (dof 2 → E[NIS] = 2)', () => {
    // NIS ~ χ²(2) with variance 4 when the filter is consistent; innovations are white, so the
    // standard error of the mean over 600 samples is 2/√600 ≈ 0.082. [1.5, 2.6] is −6σ / +7σ.
    for (const r of runs) {
      expect(r.meanNis).toBeGreaterThanOrEqual(1.5);
      expect(r.meanNis).toBeLessThanOrEqual(2.6);
    }
  });

  it('pooled NEES over all runs ≈ 4 (dof 4): the reported P is honest', () => {
    // NEES samples are time-correlated (error correlation time ≈ 1/α ≈ 23 steps for Λ = 1e-3),
    // so one 500-sample run has only ~11 effective samples (SE ≈ √(8/11) ≈ 0.85). Pooling 16 runs
    // brings the SE to ≈ 0.21, so [3.0, 5.0] is ≈ ±4.7σ.
    let sum = 0;
    let count = 0;
    for (const r of runs) {
      sum += r.neesSum;
      count += r.neesCount;
    }
    const pooled = sum / count;
    expect(pooled).toBeGreaterThan(3.0);
    expect(pooled).toBeLessThan(5.0);
  });

  it('influence stays within [0, 1] on every update', () => {
    for (const r of runs) {
      expect(r.minInfluence).toBeGreaterThanOrEqual(0);
      expect(r.maxInfluence).toBeLessThanOrEqual(1);
      expect(r.maxInfluence).toBeGreaterThan(0);
    }
  });

  it('a 0.99 gate (9.21) rejects about 1% of consistent measurements', () => {
    // P(χ²(2) > 9.21) = 0.01 → over 8·600 = 4800 measurements expect 48 rejections, sd ≈ 6.9;
    // [20, 80] is ≈ ±4σ. Gating alters later innovations only marginally at this rate.
    let rejected = 0;
    let total = 0;
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const r = runConstantVelocity(seed, 9.21);
      rejected += r.rejected;
      total += r.steps;
      expect(r.rmsPosAfter10s).toBeLessThan(10);
    }
    expect(total).toBe(4800);
    expect(rejected).toBeGreaterThanOrEqual(20);
    expect(rejected).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// (b) gating, (c) influence
// ---------------------------------------------------------------------------

describe('KalmanFilter innovation gating', () => {
  it('rejects a 200 m outlier at gateChi2 = 9.21 and leaves x and P untouched', () => {
    const kf = new KalmanFilter(Mat.col([0, 0, 0, 0]), Mat.diag([25, 25, 1, 1]));
    const xBefore = Array.from(kf.x.data);
    const pBefore = Array.from(kf.P.data);
    const R = Mat.diag([100, 100]);
    const res = kf.update(Mat.col([200, 0]), H_POSITION_2D, R, { gateChi2: 9.21 });
    expect(res.accepted).toBe(false);
    expect(res.influence).toBe(0);
    // S = HPHᵀ + R = diag(125, 125) → NIS = 200² / 125 = 320 exactly (up to one division rounding).
    expect(Math.abs(res.nis - 320)).toBeLessThan(1e-9);
    expect(Array.from(res.innovation)).toEqual([200, 0]);
    expect(Array.from(kf.x.data)).toEqual(xBefore);
    expect(Array.from(kf.P.data)).toEqual(pBefore);
  });

  it('accepts the same outlier when no gate is given or the gate exceeds the NIS', () => {
    const R = Mat.diag([100, 100]);
    const ungated = new KalmanFilter(Mat.col([0, 0, 0, 0]), Mat.diag([25, 25, 1, 1]));
    const r1 = ungated.update(Mat.col([200, 0]), H_POSITION_2D, R);
    expect(r1.accepted).toBe(true);
    // K = P Hᵀ S⁻¹ = 25/125 = 0.2 on the position rows → x_E = 40.
    expect(Math.abs(ungated.x.get(0, 0) - 40)).toBeLessThan(1e-9);
    expect(ungated.x.get(1, 0)).toBe(0);

    const wide = new KalmanFilter(Mat.col([0, 0, 0, 0]), Mat.diag([25, 25, 1, 1]));
    const r2 = wide.update(Mat.col([200, 0]), H_POSITION_2D, R, { gateChi2: 400 });
    expect(r2.accepted).toBe(true);
    expect(Array.from(wide.x.data)).toEqual(Array.from(ungated.x.data));
  });

  it('accepts a measurement exactly on the gate (nis <= gate) and rejects one just above', () => {
    // P = 0 → S = R = I, so NIS = |y|² exactly: y = [3, 0] gives 9.
    const on = new KalmanFilter(Mat.col([0, 0]), Mat.zeros(2, 2));
    expect(on.update(Mat.col([3, 0]), Mat.identity(2), Mat.identity(2), { gateChi2: 9 }).accepted).toBe(true);
    const above = new KalmanFilter(Mat.col([0, 0]), Mat.zeros(2, 2));
    expect(above.update(Mat.col([3, 0]), Mat.identity(2), Mat.identity(2), { gateChi2: 8.99 }).accepted).toBe(false);
  });

  it('a NaN NIS is rejected rather than accepted by default', () => {
    const kf = new KalmanFilter(Mat.col([0, 0]), Mat.identity(2));
    const res = kf.update(Mat.col([NaN, 0]), Mat.identity(2), Mat.identity(2), { gateChi2: 9.21 });
    expect(res.accepted).toBe(false);
    expect(kf.x.isFinite()).toBe(true);
  });
});

describe('KalmanFilter influence', () => {
  it('equals the fractional trace(P) reduction — hand-checked at 0.5', () => {
    // P = diag(100, 100), H = I, R = diag(100, 100): posterior P = (P⁻¹ + R⁻¹)⁻¹ = diag(50, 50),
    // so trace drops from 200 to 100 → influence 0.5.
    const kf = new KalmanFilter(Mat.col([0, 0]), Mat.diag([100, 100]));
    const res = kf.update(Mat.col([1, -1]), Mat.identity(2), Mat.diag([100, 100]));
    expect(res.accepted).toBe(true);
    expect(Math.abs(res.influence - 0.5)).toBeLessThan(1e-12);
    expect(Math.abs(kf.P.get(0, 0) - 50)).toBeLessThan(1e-12);
    expect(Math.abs(kf.P.get(1, 1) - 50)).toBeLessThan(1e-12);
    // x moves half-way toward z.
    expect(Math.abs(kf.x.get(0, 0) - 0.5)).toBeLessThan(1e-12);
    expect(Math.abs(kf.x.get(1, 0) + 0.5)).toBeLessThan(1e-12);
  });

  it('is ≈ 0 for an uninformative measurement and ≈ 1 for a near-exact one', () => {
    const loose = new KalmanFilter(Mat.col([0, 0]), Mat.diag([100, 100]));
    const r1 = loose.update(Mat.col([5, 5]), Mat.identity(2), Mat.diag([1e12, 1e12]));
    // Posterior trace = 2·(100·1e12/(100 + 1e12)) → influence = 100/(100+1e12) ≈ 1e-10.
    expect(r1.influence).toBeGreaterThanOrEqual(0);
    expect(r1.influence).toBeLessThan(1e-8);

    const tight = new KalmanFilter(Mat.col([0, 0]), Mat.diag([100, 100]));
    const r2 = tight.update(Mat.col([5, 5]), Mat.identity(2), Mat.diag([1e-6, 1e-6]));
    // Posterior trace ≈ 2e-6 → influence ≈ 1 − 1e-8.
    expect(r2.influence).toBeLessThanOrEqual(1);
    expect(r2.influence).toBeGreaterThan(1 - 1e-6);
  });

  it('is 0 (and reports accepted: false) on rejection', () => {
    const kf = new KalmanFilter(Mat.col([0, 0]), Mat.diag([1, 1]));
    const res = kf.update(Mat.col([100, 100]), Mat.identity(2), Mat.diag([1, 1]), { gateChi2: 9.21 });
    expect(res.accepted).toBe(false);
    expect(res.influence).toBe(0);
  });

  it('only measures the position block when the update observes velocity', () => {
    // Observing velocity with R → 0 leaves the position variance intact: influence = 200/(2e4 + 200).
    const kf = new KalmanFilter(Mat.col([0, 0, 0, 0]), Mat.diag([1e4, 1e4, 100, 100]));
    const res = kf.update(Mat.col([1, 1]), H_VELOCITY_2D, Mat.diag([1e-9, 1e-9]));
    expect(Math.abs(res.influence - 200 / 20200)).toBeLessThan(1e-9);
    expect(Math.abs(kf.P.get(0, 0) - 1e4)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// (d) numerical stability over a long run
// ---------------------------------------------------------------------------

describe('KalmanFilter numerical stability', () => {
  it('P stays symmetric, finite and positive on the diagonal across 20 000 predict/update cycles', () => {
    const { F, Q } = constantVelocity2D(DT, 2.0);
    const P0 = Mat.diag([1e4, 1e4, 100, 100]);
    const kf = new KalmanFilter(Mat.col([0, 0, 50, 50]), P0);
    const rng = new Rng(8);
    const Rpos = Mat.diag([144, 144]);
    const Rvel = Mat.diag([0.25, 0.25]);
    let maxAsym = 0;
    let allFinite = true;
    let minDiag = Infinity;
    let accepted = 0;
    for (let tick = 1; tick <= 20_000; tick++) {
      kf.predict(F, Q);
      const t = tick * DT;
      const z = Mat.col([50 * t + rng.gaussian(0, 12), 50 * t + rng.gaussian(0, 12)]);
      if (kf.update(z, H_POSITION_2D, Rpos, { gateChi2: 9.21 }).accepted) accepted++;
      if (tick % 10 === 0) {
        const zv = Mat.col([50 + rng.gaussian(0, 0.5), 50 + rng.gaussian(0, 0.5)]);
        kf.update(zv, H_VELOCITY_2D, Rvel, { gateChi2: 9.21 });
      }
      maxAsym = Math.max(maxAsym, maxAsymmetry(kf.P));
      minDiag = Math.min(minDiag, minDiagonal(kf.P));
      if (!kf.P.isFinite() || !kf.x.isFinite()) allFinite = false;
    }
    // Joseph form plus symmetrize() should leave no asymmetry at all; 1e-12 is the spec bound.
    expect(maxAsym).toBeLessThan(1e-12);
    expect(allFinite).toBe(true);
    expect(minDiag).toBeGreaterThan(0);
    // The filter converged: covariance well below its prior and the estimate close to truth.
    expect(kf.P.trace()).toBeLessThan(P0.trace() / 100);
    const tEnd = 20_000 * DT;
    expect(Math.abs(kf.x.get(0, 0) - 50 * tEnd)).toBeLessThan(10);
    expect(Math.abs(kf.x.get(1, 0) - 50 * tEnd)).toBeLessThan(10);
    // With a consistent model the gate rejects ≈ 1 %: expect > 98 % acceptance.
    expect(accepted).toBeGreaterThan(19_600);
  });
});

// ---------------------------------------------------------------------------
// (e) nonlinear heading update across ±π
// ---------------------------------------------------------------------------

describe('KalmanFilter.updateNonlinear with a wrapped heading residual', () => {
  const speed = 100;
  const heading0 = Math.PI - 0.05;
  // Prior velocity σ = 5 m/s → prior heading σ ≈ 0.05 rad; measurement σ = 0.003 rad.
  const P0 = Mat.diag([100, 100, 25, 25]);
  const R = Mat.diag([0.5 * 0.5, 0.003 * 0.003]);
  // −π + 0.05 is the same direction as π + 0.05: 0.1 rad clockwise of the prior heading.
  const zHeading = -Math.PI + 0.05;

  function freshFilter(): KalmanFilter {
    return new KalmanFilter(Mat.col([0, 0, speed * Math.sin(heading0), speed * Math.cos(heading0)]), P0);
  }

  it('produces a small wrapped innovation and a small rotation of the velocity, not a 2π jump', () => {
    const kf = freshFilter();
    const vE0 = kf.x.get(2, 0);
    const vN0 = kf.x.get(3, 0);
    const z = Mat.col([speed, zHeading]);
    const res = kf.updateNonlinear(z, speedHeading, speedHeadingJacobian(kf.x), R, { residual: wrapResidual, gateChi2: 9.21 });
    expect(res.accepted).toBe(true);
    expect(Math.abs((res.innovation[1] as number) - 0.1)).toBeLessThan(1e-12);
    // NIS = 0.1² / (0.05² + 0.003²) ≈ 3.99: inside the 0.99 gate.
    expect(Math.abs(res.nis - 0.01 / (0.0025 + 0.000009))).toBeLessThan(1e-6);

    const vE = kf.x.get(2, 0);
    const vN = kf.x.get(3, 0);
    const headingPost = Math.atan2(vE, vN);
    // Kalman weight on the heading is 0.0025/(0.0025+0.000009) ≈ 0.996, so the posterior heading sits
    // ≈ 0.0996 rad from the prior, within 0.01 rad of the measurement (in wrapped terms).
    expect(Math.abs(wrapAngle(headingPost - zHeading))).toBeLessThan(0.01);
    expect(Math.abs(wrapAngle(headingPost - heading0))).toBeLessThan(0.11);
    // A 0.1 rad rotation of a 100 m/s vector moves it by ≈ 10 m/s; speed is essentially unchanged.
    expect(Math.hypot(vE - vE0, vN - vN0)).toBeLessThan(15);
    expect(Math.abs(Math.hypot(vE, vN) - speed)).toBeLessThan(1);
    expect(kf.P.isFinite()).toBe(true);
    expect(maxAsymmetry(kf.P)).toBeLessThan(1e-12);
  });

  it('without the wrapping residual the raw innovation is ≈ −2π + 0.1 and the state jumps', () => {
    const kf = freshFilter();
    const vE0 = kf.x.get(2, 0);
    const vN0 = kf.x.get(3, 0);
    const z = Mat.col([speed, zHeading]);
    const res = kf.updateNonlinear(z, speedHeading, speedHeadingJacobian(kf.x), R);
    expect(Math.abs((res.innovation[1] as number) - (-2 * Math.PI + 0.1))).toBeLessThan(1e-12);
    // NIS ≈ (2π−0.1)²/0.002509 ≈ 15 000: a gate would have rejected it.
    expect(res.nis).toBeGreaterThan(1000);
    // Applied ungated, the linearised correction rotates the velocity by ≈ −6.16 rad·100 m/s ≈ 600 m/s.
    expect(Math.hypot(kf.x.get(2, 0) - vE0, kf.x.get(3, 0) - vN0)).toBeGreaterThan(100);
  });

  it('tracks a heading that sweeps through ±π with no discontinuity in the velocity estimate', () => {
    const dt = 0.1;
    const turnRate = 0.1; // rad/s → centripetal acceleration 10 m/s², absorbed by sigmaAccel = 10
    const { F, Q } = constantVelocity2D(dt, 10);
    const rng = new Rng(555);
    let heading = Math.PI - 0.3;
    let vE = speed * Math.sin(heading);
    let vN = speed * Math.cos(heading);
    let pE = 0;
    let pN = 0;
    const kf = new KalmanFilter(Mat.col([pE, pN, vE, vN]), Mat.diag([100, 100, 25, 25]));
    let prevVE = vE;
    let prevVN = vN;
    let maxVelErr = 0;
    let maxStepChange = 0;
    let rejections = 0;
    for (let k = 1; k <= 60; k++) {
      heading = wrapAngle(heading + turnRate * dt);
      vE = speed * Math.sin(heading);
      vN = speed * Math.cos(heading);
      pE += vE * dt;
      pN += vN * dt;
      kf.predict(F, Q);
      const z = Mat.col([speed + rng.gaussian(0, 0.5), wrapAngle(heading + rng.gaussian(0, 0.003))]);
      const res = kf.updateNonlinear(z, speedHeading, speedHeadingJacobian(kf.x), R, { residual: wrapResidual, gateChi2: 9.21 });
      if (!res.accepted) rejections++;
      const eVE = kf.x.get(2, 0);
      const eVN = kf.x.get(3, 0);
      if (k > 3) maxVelErr = Math.max(maxVelErr, Math.hypot(eVE - vE, eVN - vN));
      maxStepChange = Math.max(maxStepChange, Math.hypot(eVE - prevVE, eVN - prevVN));
      prevVE = eVE;
      prevVN = eVN;
      // The wrapped heading error is small throughout, including the steps where truth crosses ±π.
      expect(Math.abs(wrapAngle(Math.atan2(eVE, eVN) - heading))).toBeLessThan(0.05);
    }
    // Every measurement is consistent, so none should be gated out.
    expect(rejections).toBe(0);
    // The CV model lags a 10 m/s² turn by ≈ 1 m/s per step and the update removes most of it; a
    // 2π-wrap failure would show up as a ~600 m/s swing, so a 5 m/s bound is decisive.
    expect(maxVelErr).toBeLessThan(5);
    // Truth velocity moves 1 m/s per step; the estimate never jumps by more than a few m/s.
    expect(maxStepChange).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// (f) model matrices, selectors, predictNonlinear, shape checks
// ---------------------------------------------------------------------------

describe('constantVelocity2D', () => {
  it('F has unit diagonal and dt in the position–velocity couplings', () => {
    const { F } = constantVelocity2D(0.25, 1);
    expect(F.toRows()).toEqual([
      [1, 0, 0.25, 0],
      [0, 1, 0, 0.25],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
    // F propagates position by velocity·dt and leaves velocity unchanged.
    const { F: F2 } = constantVelocity2D(0.5, 1);
    expect(Array.from(F2.mul(Mat.col([1, 2, 3, 4])).data)).toEqual([2.5, 4, 3, 4]);
  });

  it('Q has the discrete white-noise-acceleration entries, symmetric with non-negative diagonal', () => {
    // dt = 0.1, σ_a = 2 → q = 4: dt⁴/4·q = 1e-4, dt³/2·q = 2e-3, dt²·q = 4e-2.
    const { Q } = constantVelocity2D(0.1, 2);
    expect(Q.rows).toBe(4);
    expect(Q.cols).toBe(4);
    expect(Math.abs(Q.get(0, 0) - 1e-4)).toBeLessThan(1e-18);
    expect(Math.abs(Q.get(1, 1) - 1e-4)).toBeLessThan(1e-18);
    expect(Math.abs(Q.get(0, 2) - 2e-3)).toBeLessThan(1e-17);
    expect(Math.abs(Q.get(1, 3) - 2e-3)).toBeLessThan(1e-17);
    expect(Math.abs(Q.get(2, 2) - 4e-2)).toBeLessThan(1e-16);
    expect(Math.abs(Q.get(3, 3) - 4e-2)).toBeLessThan(1e-16);
    // No coupling between the E and N axes.
    expect(Q.get(0, 1)).toBe(0);
    expect(Q.get(0, 3)).toBe(0);
    expect(Q.get(2, 1)).toBe(0);
    expect(Q.get(2, 3)).toBe(0);
    expect(maxAsymmetry(Q)).toBe(0);
    expect(minDiagonal(Q)).toBeGreaterThanOrEqual(0);
  });

  it('Q is positive semi-definite and scales with sigmaAccel²', () => {
    const { Q } = constantVelocity2D(0.1, 2);
    const rng = new Rng(99);
    let minForm = Infinity;
    for (let i = 0; i < 100; i++) {
      const y = Mat.col([rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)]);
      minForm = Math.min(minForm, Q.quadForm(y));
    }
    // Each axis block is rank 1 (det = 0) so rounding can produce −1e-17-ish; −1e-12 is a safe floor.
    expect(minForm).toBeGreaterThan(-1e-12);
    const { Q: Q4 } = constantVelocity2D(0.1, 4);
    let worst = 0;
    for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs((Q4.data[i] as number) - 4 * (Q.data[i] as number)));
    expect(worst).toBeLessThan(1e-16);
  });

  it('returns fresh matrices on every call', () => {
    const a = constantVelocity2D(0.1, 1);
    const b = constantVelocity2D(0.1, 1);
    expect(a.F).not.toBe(b.F);
    expect(a.Q).not.toBe(b.Q);
  });
});

describe('H_POSITION_2D / H_VELOCITY_2D', () => {
  it('select the position and velocity components of [pE, pN, vE, vN]', () => {
    const x = Mat.col([1, 2, 3, 4]);
    expect(H_POSITION_2D.rows).toBe(2);
    expect(H_POSITION_2D.cols).toBe(4);
    expect(Array.from(H_POSITION_2D.mul(x).data)).toEqual([1, 2]);
    expect(H_VELOCITY_2D.rows).toBe(2);
    expect(H_VELOCITY_2D.cols).toBe(4);
    expect(Array.from(H_VELOCITY_2D.mul(x).data)).toEqual([3, 4]);
  });
});

describe('KalmanFilter predict variants and shape checks', () => {
  it('predictNonlinear with f(x) = F·x matches the linear predict', () => {
    const { F, Q } = constantVelocity2D(0.5, 3);
    const x0 = Mat.col([10, -20, 5, 2]);
    const P0 = Mat.diag([4, 4, 1, 1]);
    const lin = new KalmanFilter(x0, P0);
    const nonlin = new KalmanFilter(x0, P0);
    lin.predict(F, Q);
    nonlin.predictNonlinear((x) => F.mul(x), F, Q);
    expect(Array.from(nonlin.x.data)).toEqual(Array.from(lin.x.data));
    expect(Array.from(nonlin.P.data)).toEqual(Array.from(lin.P.data));
    expect(Array.from(lin.x.data)).toEqual([12.5, -19, 5, 2]);
  });

  it('predict propagates P as F P Fᵀ + Q (hand-checked 1-D case)', () => {
    // [p, v] with F = [[1, dt], [0, 1]], P = diag(1, 1), Q = 0, dt = 2:
    // F P Fᵀ = [[1 + dt², dt], [dt, 1]] = [[5, 2], [2, 1]].
    const F = Mat.fromRows([
      [1, 2],
      [0, 1],
    ]);
    const kf = new KalmanFilter(Mat.col([0, 1]), Mat.identity(2));
    kf.predict(F, Mat.zeros(2, 2));
    expect(kf.P.toRows()).toEqual([
      [5, 2],
      [2, 1],
    ]);
    expect(Array.from(kf.x.data)).toEqual([2, 1]);
  });

  it('constructor copies x0 and P0', () => {
    const x0 = Mat.col([1, 2]);
    const P0 = Mat.identity(2);
    const kf = new KalmanFilter(x0, P0);
    x0.set(0, 0, 99);
    P0.set(0, 0, 99);
    expect(kf.x.get(0, 0)).toBe(1);
    expect(kf.P.get(0, 0)).toBe(1);
    expect(kf.n).toBe(2);
  });

  it('rejects malformed constructor and update shapes', () => {
    expect(() => new KalmanFilter(new Mat(1, 2, [1, 2]), Mat.identity(2))).toThrow(/column vector/);
    expect(() => new KalmanFilter(Mat.col([1, 2]), Mat.identity(3))).toThrow(/P0 shape/);
    expect(() => new KalmanFilter(Mat.col([1, 2]), Mat.zeros(2, 3))).toThrow(/P0 shape/);

    const kf = new KalmanFilter(Mat.col([0, 0, 0, 0]), Mat.identity(4));
    const R2 = Mat.identity(2);
    expect(() => kf.update(Mat.col([1, 2, 3]), H_POSITION_2D, R2)).toThrow(/z shape/);
    expect(() => kf.update(new Mat(1, 2, [1, 2]), H_POSITION_2D, R2)).toThrow(/z shape/);
    // On the linear path H·x is formed before the shape guard runs, so a bad H surfaces as Mat.mul's error.
    expect(() => kf.update(Mat.col([1, 2]), Mat.identity(2), R2)).toThrow(/H shape|Mat\.mul/);
    expect(() => kf.update(Mat.col([1, 2]), H_POSITION_2D, Mat.identity(3))).toThrow(/R shape/);
    expect(() => kf.updateNonlinear(Mat.col([1, 2]), (x) => H_POSITION_2D.mul(x), Mat.identity(2), R2)).toThrow(/H shape/);
  });
});
