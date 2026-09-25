import { Mat } from './mat';

export interface KalmanUpdateResult {
  /** False if the measurement failed the innovation gate and was not applied. */
  accepted: boolean;
  /** Normalized innovation squared, yᵀ S⁻¹ y. */
  nis: number;
  /** Fractional reduction of trace(P) produced by this update, in [0, 1]. 0 if rejected. */
  influence: number;
  /** Innovation y = z − h(x). */
  innovation: Float64Array;
}

export interface KalmanUpdateOptions {
  /** Reject the measurement when NIS exceeds this (chi-square critical value). Omit to never gate. */
  gateChi2?: number;
  /**
   * Custom residual for measurements with wrap-around components (e.g. angles).
   * Receives z and h(x) as column matrices; must return z ⊖ h(x).
   */
  residual?: (z: Mat, hx: Mat) => Mat;
}

/**
 * Generic (extended) Kalman filter over a column state vector `x` and
 * covariance `P`. Linear predict/update take matrices; the nonlinear variants
 * take functions plus the Jacobian evaluated at the current state.
 *
 * Update uses the Joseph-form covariance update, which stays symmetric and
 * positive semi-definite under rounding and under a suboptimal gain.
 */
export class KalmanFilter {
  x: Mat;
  P: Mat;

  constructor(x0: Mat, P0: Mat) {
    if (x0.cols !== 1) throw new Error('KalmanFilter: x0 must be a column vector');
    if (P0.rows !== x0.rows || P0.cols !== x0.rows) throw new Error('KalmanFilter: P0 shape');
    this.x = x0.clone();
    this.P = P0.clone();
  }

  get n(): number {
    return this.x.rows;
  }

  /** Linear predict: x ← F x, P ← F P Fᵀ + Q. */
  predict(F: Mat, Q: Mat): void {
    this.x = F.mul(this.x);
    this.P = F.mul(this.P).mul(F.transpose()).add(Q).symmetrize();
  }

  /** Nonlinear predict: x ← f(x), P ← F P Fᵀ + Q with F = ∂f/∂x at x. */
  predictNonlinear(f: (x: Mat) => Mat, F: Mat, Q: Mat): void {
    this.x = f(this.x);
    this.P = F.mul(this.P).mul(F.transpose()).add(Q).symmetrize();
  }

  /** Linear update with measurement z, model H, noise R. */
  update(z: Mat, H: Mat, R: Mat, opts: KalmanUpdateOptions = {}): KalmanUpdateResult {
    return this.applyUpdate(z, H.mul(this.x), H, R, opts);
  }

  /** Nonlinear update with measurement function h and its Jacobian H at the current x. */
  updateNonlinear(z: Mat, h: (x: Mat) => Mat, H: Mat, R: Mat, opts: KalmanUpdateOptions = {}): KalmanUpdateResult {
    return this.applyUpdate(z, h(this.x), H, R, opts);
  }

  private applyUpdate(z: Mat, hx: Mat, H: Mat, R: Mat, opts: KalmanUpdateOptions): KalmanUpdateResult {
    if (z.cols !== 1 || z.rows !== H.rows) throw new Error('KalmanFilter.update: z shape');
    if (H.cols !== this.n) throw new Error('KalmanFilter.update: H shape');
    if (R.rows !== z.rows || R.cols !== z.rows) throw new Error('KalmanFilter.update: R shape');

    const y = opts.residual ? opts.residual(z, hx) : z.sub(hx);
    const Ht = H.transpose();
    const S = H.mul(this.P).mul(Ht).add(R).symmetrize();
    const Sinv = S.inverse();
    const nis = Sinv.quadForm(y);

    if (opts.gateChi2 !== undefined && !(nis <= opts.gateChi2)) {
      return { accepted: false, nis, influence: 0, innovation: new Float64Array(y.data) };
    }

    const tracePrior = this.P.trace();
    const K = this.P.mul(Ht).mul(Sinv);
    this.x = this.x.add(K.mul(y));
    const IKH = Mat.identity(this.n).sub(K.mul(H));
    this.P = IKH.mul(this.P).mul(IKH.transpose()).add(K.mul(R).mul(K.transpose())).symmetrize();

    const tracePost = this.P.trace();
    const influence = tracePrior > 0 ? Math.min(1, Math.max(0, 1 - tracePost / tracePrior)) : 0;
    return { accepted: true, nis, influence, innovation: new Float64Array(y.data) };
  }
}

/**
 * Constant-velocity model matrices for a 2-D [pE, pN, vE, vN] state.
 * Q is the discrete white-noise-acceleration model with acceleration
 * standard deviation `sigmaAccel` (m/s²).
 */
export function constantVelocity2D(dt: number, sigmaAccel: number): { F: Mat; Q: Mat } {
  const F = Mat.fromRows([
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ]);
  const q = sigmaAccel * sigmaAccel;
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt3 * dt;
  const Q = Mat.fromRows([
    [(dt4 / 4) * q, 0, (dt3 / 2) * q, 0],
    [0, (dt4 / 4) * q, 0, (dt3 / 2) * q],
    [(dt3 / 2) * q, 0, dt2 * q, 0],
    [0, (dt3 / 2) * q, 0, dt2 * q],
  ]);
  return { F, Q };
}

/** H selecting position [pE, pN] from a [pE, pN, vE, vN] state. */
export const H_POSITION_2D: Mat = Mat.fromRows([
  [1, 0, 0, 0],
  [0, 1, 0, 0],
]);

/** H selecting velocity [vE, vN] from a [pE, pN, vE, vN] state. */
export const H_VELOCITY_2D: Mat = Mat.fromRows([
  [0, 0, 1, 0],
  [0, 0, 0, 1],
]);
