/**
 * Allocation-free extended Kalman filter core for a fixed-size state and
 * two-component measurements.
 *
 * Computes exactly what `KalmanFilter` in math/kalman.ts computes — the same
 * predict, the same Joseph-form covariance update, the same NIS gate and
 * influence definition — but in place on preallocated Float64Array buffers,
 * skipping the zeros of sparse F and H, and with the Joseph form evaluated in
 * its expanded O(n²·m) shape
 *     P⁺ = P − K(HP) − (HP)ᵀKᵀ + K S Kᵀ
 * (identical to (I−KH)P(I−KH)ᵀ + KRKᵀ for any K). The navigation filter runs
 * about three gated updates per tick at 100 Hz, and the generic Mat path costs
 * ~80 µs per tick in allocations alone; equivalence to the reference is
 * asserted in ekf.test.ts.
 */

export interface EkfUpdateResult {
  /** False if the innovation failed the gate and the state was left untouched. */
  accepted: boolean;
  /** Normalized innovation squared, yᵀ S⁻¹ y. */
  nis: number;
  /** Fractional reduction of trace(P) by this update, in [0, 1]; 0 when rejected. */
  influence: number;
}

/** Kalman filter over an n-state column vector, updated by 2-D measurements. */
export class NavEkf {
  readonly n: number;
  /** State vector, length n. */
  readonly x: Float64Array;
  /** Covariance, n×n row-major. */
  readonly P: Float64Array;

  private readonly xNext: Float64Array;
  private readonly tmp: Float64Array;
  private readonly PHt: Float64Array;
  private readonly K: Float64Array;
  private readonly KS: Float64Array;
  private readonly nz0: Int32Array;
  private readonly nz1: Int32Array;
  private readonly result: EkfUpdateResult = { accepted: false, nis: NaN, influence: 0 };

  constructor(x0: ArrayLike<number>, P0: ArrayLike<number>) {
    const n = x0.length;
    if (P0.length !== n * n) throw new Error(`NavEkf: P0 length ${P0.length} != ${n}x${n}`);
    this.n = n;
    this.x = Float64Array.from(x0);
    this.P = Float64Array.from(P0);
    this.xNext = new Float64Array(n);
    this.tmp = new Float64Array(n * n);
    this.PHt = new Float64Array(n * 2);
    this.K = new Float64Array(n * 2);
    this.KS = new Float64Array(n * 2);
    this.nz0 = new Int32Array(n);
    this.nz1 = new Int32Array(n);
  }

  /** trace(P). */
  trace(): number {
    const n = this.n;
    let t = 0;
    for (let i = 0; i < n; i++) t += this.P[i * n + i] as number;
    return t;
  }

  /** x ← F x, P ← F P Fᵀ + Q (then symmetrized). `F` and `Q` are n×n row-major. */
  predict(F: Float64Array, Q: Float64Array): void {
    const { n, x, P, xNext, tmp } = this;
    tmp.fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) {
        const f = F[i * n + k] as number;
        if (f === 0) continue;
        s += f * (x[k] as number);
        // tmp = F P, accumulated row by row over the nonzeros of F.
        for (let j = 0; j < n; j++) tmp[i * n + j] = (tmp[i * n + j] as number) + f * (P[k * n + j] as number);
      }
      xNext[i] = s;
    }
    x.set(xNext);
    // P = tmp Fᵀ + Q, again over the nonzeros of F.
    P.set(Q);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        const f = F[j * n + k] as number;
        if (f === 0) continue;
        for (let i = 0; i < n; i++) P[i * n + j] = (P[i * n + j] as number) + (tmp[i * n + k] as number) * f;
      }
    }
    this.symmetrize();
  }

  /**
   * Gated update with innovation `y` (length 2, already z ⊖ h(x)), Jacobian `H`
   * (2×n row-major) and measurement covariance `R` (2×2 row-major).
   * Rejects (and leaves x, P untouched) when NIS is not ≤ `gateChi2`.
   * The returned object is reused between calls; copy what you need.
   */
  update(y: ArrayLike<number>, H: Float64Array, R: ArrayLike<number>, gateChi2: number): EkfUpdateResult {
    const { n, x, P, PHt, K, KS, nz0, nz1, result } = this;
    let c0 = 0;
    let c1 = 0;
    for (let k = 0; k < n; k++) {
      if ((H[k] as number) !== 0) nz0[c0++] = k;
      if ((H[n + k] as number) !== 0) nz1[c1++] = k;
    }
    // PHt = P Hᵀ (n×2) over the nonzeros of each row of H.
    for (let i = 0; i < n; i++) {
      let s0 = 0;
      let s1 = 0;
      for (let a = 0; a < c0; a++) {
        const k = nz0[a] as number;
        s0 += (P[i * n + k] as number) * (H[k] as number);
      }
      for (let a = 0; a < c1; a++) {
        const k = nz1[a] as number;
        s1 += (P[i * n + k] as number) * (H[n + k] as number);
      }
      PHt[i * 2] = s0;
      PHt[i * 2 + 1] = s1;
    }
    // S = H PHt + R (2×2), symmetrized like KalmanFilter does.
    let s00 = R[0] as number;
    let s01 = R[1] as number;
    let s10 = R[2] as number;
    let s11 = R[3] as number;
    for (let a = 0; a < c0; a++) {
      const k = nz0[a] as number;
      const h = H[k] as number;
      s00 += h * (PHt[k * 2] as number);
      s01 += h * (PHt[k * 2 + 1] as number);
    }
    for (let a = 0; a < c1; a++) {
      const k = nz1[a] as number;
      const h = H[n + k] as number;
      s10 += h * (PHt[k * 2] as number);
      s11 += h * (PHt[k * 2 + 1] as number);
    }
    const sOff = 0.5 * (s01 + s10);
    const det = s00 * s11 - sOff * sOff;
    const i00 = s11 / det;
    const i01 = -sOff / det;
    const i11 = s00 / det;
    const y0 = y[0] as number;
    const y1 = y[1] as number;
    const nis = y0 * (i00 * y0 + i01 * y1) + y1 * (i01 * y0 + i11 * y1);
    result.nis = nis;
    if (!(nis <= gateChi2)) {
      result.accepted = false;
      result.influence = 0;
      return result;
    }
    const tracePrior = this.trace();
    // K = PHt S⁻¹ and KS = K S (both n×2).
    for (let i = 0; i < n; i++) {
      const a = PHt[i * 2] as number;
      const b = PHt[i * 2 + 1] as number;
      const k0 = a * i00 + b * i01;
      const k1 = a * i01 + b * i11;
      K[i * 2] = k0;
      K[i * 2 + 1] = k1;
      KS[i * 2] = k0 * s00 + k1 * sOff;
      KS[i * 2 + 1] = k0 * sOff + k1 * s11;
      x[i] = (x[i] as number) + k0 * y0 + k1 * y1;
    }
    // P ← P − K(HP) − (HP)ᵀKᵀ + K S Kᵀ, where (HP)ᵀ = PHt by symmetry of the prior P.
    for (let i = 0; i < n; i++) {
      const ki0 = K[i * 2] as number;
      const ki1 = K[i * 2 + 1] as number;
      const ksi0 = KS[i * 2] as number;
      const ksi1 = KS[i * 2 + 1] as number;
      const phi0 = PHt[i * 2] as number;
      const phi1 = PHt[i * 2 + 1] as number;
      for (let j = i; j < n; j++) {
        const kj0 = K[j * 2] as number;
        const kj1 = K[j * 2 + 1] as number;
        const v =
          (P[i * n + j] as number) -
          (ki0 * (PHt[j * 2] as number) + ki1 * (PHt[j * 2 + 1] as number)) -
          (kj0 * phi0 + kj1 * phi1) +
          (ksi0 * kj0 + ksi1 * kj1);
        P[i * n + j] = v;
        P[j * n + i] = v;
      }
    }
    const tracePost = this.trace();
    result.accepted = true;
    result.influence = tracePrior > 0 ? Math.min(1, Math.max(0, 1 - tracePost / tracePrior)) : 0;
    return result;
  }

  private symmetrize(): void {
    const { n, P } = this;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = 0.5 * ((P[i * n + j] as number) + (P[j * n + i] as number));
        P[i * n + j] = v;
        P[j * n + i] = v;
      }
    }
  }
}
