import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { Mat } from '../math/mat';
import { KalmanFilter, constantVelocity2D, H_POSITION_2D } from '../math/kalman';
import { NavEkf } from './ekf';

/**
 * NavEkf is a performance re-implementation of the foundation KalmanFilter.
 * These tests pin it to the reference: same state, covariance, NIS, gate
 * decision and influence on a long random predict/update sequence.
 */

const GATE = 9.21;

function expectRelativelyClose(actual: number, expected: number, rel = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(expected)));
}

function randomSpd(rng: Rng, n: number, scale: number): Mat {
  // A Aᵀ + ε I is symmetric positive definite.
  const a = new Mat(n, n);
  for (let i = 0; i < n * n; i++) a.data[i] = rng.gaussian(0, scale);
  return a.mul(a.transpose()).add(Mat.identity(n).scale(1e-3 * scale * scale));
}

describe('NavEkf', () => {
  it('matches KalmanFilter on a random 4-state sequence with the CV model and position measurements', () => {
    const rng = new Rng(1234);
    const x0 = Mat.col([100, -50, 30, 20]);
    const P0 = Mat.diag([100, 100, 25, 25]);
    const ref = new KalmanFilter(x0, P0);
    const ekf = new NavEkf(x0.data, P0.data);
    const { F, Q } = constantVelocity2D(0.01, 5);
    const R = Mat.diag([64, 64]);
    let accepted = 0;
    let rejected = 0;
    for (let k = 0; k < 500; k++) {
      ref.predict(F, Q);
      ekf.predict(F.data, Q.data);
      // Innovations are drawn wide enough that a fair share fail the gate.
      const y0 = rng.gaussian(0, 12);
      const y1 = rng.gaussian(0, 12);
      const z = Mat.col([ref.x.get(0, 0) + y0, ref.x.get(1, 0) + y1]);
      const r1 = ref.update(z, H_POSITION_2D, R, { gateChi2: GATE });
      const r2 = ekf.update([y0, y1], H_POSITION_2D.data, R.data, GATE);
      expect(r2.accepted).toBe(r1.accepted);
      // The two implementations differ only in floating-point summation order,
      // so 1e-9 relative agreement (toBeCloseTo with 9 digits on O(1..100) values) is the bar.
      expect(r2.nis).toBeCloseTo(r1.nis, 9);
      expect(r2.influence).toBeCloseTo(r1.influence, 9);
      for (let i = 0; i < 4; i++) expect(ekf.x[i]).toBeCloseTo(ref.x.data[i] as number, 9);
      for (let i = 0; i < 16; i++) expect(ekf.P[i]).toBeCloseTo(ref.P.data[i] as number, 9);
      if (r1.accepted) accepted++;
      else rejected++;
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(20);
  });

  it('matches KalmanFilter for a 6-state model with dense H, full R and no gate', () => {
    const rng = new Rng(99);
    const n = 6;
    const x0 = Mat.col([1, 2, 3, 4, 5, 6]);
    const P0 = randomSpd(rng, n, 3);
    const ref = new KalmanFilter(x0, P0);
    const ekf = new NavEkf(x0.data, P0.data);
    const F = Mat.identity(n);
    for (let i = 0; i < n * n; i++) F.data[i] = (F.data[i] as number) + rng.gaussian(0, 0.05);
    const Q = randomSpd(rng, n, 0.2);
    for (let k = 0; k < 200; k++) {
      ref.predict(F, Q);
      ekf.predict(F.data, Q.data);
      const H = new Mat(2, n);
      for (let i = 0; i < 2 * n; i++) H.data[i] = rng.gaussian(0, 1);
      const R = randomSpd(rng, 2, 2);
      const hx = H.mul(ref.x);
      const y = [rng.gaussian(0, 3), rng.gaussian(0, 3)];
      const z = Mat.col([hx.get(0, 0) + (y[0] as number), hx.get(1, 0) + (y[1] as number)]);
      const r1 = ref.update(z, H, R);
      const r2 = ekf.update(y, H.data, R.data, Infinity);
      expect(r2.accepted).toBe(true);
      expect(r1.accepted).toBe(true);
      // The random F is mildly unstable, so the state grows to ~1e6 over the run and only a
      // relative comparison is meaningful: 1e-9 relative is ~1e4 ulps of accumulated rounding.
      expectRelativelyClose(r2.nis, r1.nis);
      expectRelativelyClose(r2.influence, r1.influence);
      for (let i = 0; i < n; i++) expectRelativelyClose(ekf.x[i] as number, ref.x.data[i] as number);
      for (let i = 0; i < n * n; i++) expectRelativelyClose(ekf.P[i] as number, ref.P.data[i] as number);
    }
  });

  it('leaves x and P untouched on a rejected update and reports influence 0', () => {
    const ekf = new NavEkf([0, 0, 10, 10], Mat.diag([1, 1, 1, 1]).data);
    const xBefore = Float64Array.from(ekf.x);
    const pBefore = Float64Array.from(ekf.P);
    const r = ekf.update([100, 100], H_POSITION_2D.data, Mat.diag([1, 1]).data, GATE);
    expect(r.accepted).toBe(false);
    expect(r.influence).toBe(0);
    // NIS = 100²/2 + 100²/2 = 10 000 exactly with S = P + R = 2 I.
    expect(r.nis).toBeCloseTo(10000, 6);
    expect(Array.from(ekf.x)).toEqual(Array.from(xBefore));
    expect(Array.from(ekf.P)).toEqual(Array.from(pBefore));
  });

  it('rejects a NaN innovation like the foundation gate does', () => {
    const ekf = new NavEkf([0, 0, 10, 10], Mat.diag([1, 1, 1, 1]).data);
    const r = ekf.update([NaN, 0], H_POSITION_2D.data, Mat.diag([1, 1]).data, GATE);
    expect(r.accepted).toBe(false);
    expect(Number.isNaN(r.nis)).toBe(true);
  });
});
