import { describe, expect, it } from 'vitest';
import { chi2Critical, type Chi2Level } from '../math/chi2';
import { DT, TICK_HZ, secondsToTick, tickToSeconds, wrapAngle } from './constants';
import { Rng } from './rng';

// ---------------------------------------------------------------------------
// Rng: pin the stream against an independent reference implementation.
// rng.test.ts checks determinism and statistics, which any decent PRNG passes;
// recordings (`Recording.seed`) only replay if the exact algorithm never drifts.
// ---------------------------------------------------------------------------

const M32 = 0xffffffffn;

function rotl32(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (32n - k))) & M32;
}

/** splitmix32 in BigInt arithmetic (no Math.imul, no `>>>`), as published. */
function splitmix32(seed: number): () => bigint {
  let x = BigInt(seed >>> 0);
  return () => {
    x = (x + 0x9e3779b9n) & M32;
    let z = x;
    z = ((z ^ (z >> 16n)) * 0x21f0aaadn) & M32;
    z = ((z ^ (z >> 15n)) * 0x735a2d97n) & M32;
    return (z ^ (z >> 15n)) & M32;
  };
}

/** xoshiro128** (Blackman & Vigna) seeded by four splitmix32 words. */
function referenceXoshiro128ss(seed: number): () => number {
  const sm = splitmix32(seed);
  let s0 = sm();
  let s1 = sm();
  let s2 = sm();
  let s3 = sm();
  if ((s0 | s1 | s2 | s3) === 0n) s0 = 1n;
  return () => {
    const result = (rotl32((s1 * 5n) & M32, 7n) * 9n) & M32;
    const t = (s1 << 9n) & M32;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl32(s3, 11n);
    return Number(result);
  };
}

describe('Rng matches the reference xoshiro128** / splitmix32 bit-for-bit', () => {
  it.each([0, 1, 42, 2024, 123456789, 0xffffffff])('seed %s: first 2000 outputs agree', (seed: number) => {
    const rng = new Rng(seed);
    const ref = referenceXoshiro128ss(seed);
    for (let i = 0; i < 2000; i++) expect(rng.next()).toBe(ref());
  });

  it('golden values pin the stream for recordings', () => {
    // Values captured from the scaffold's implementation; a change here breaks every saved Recording.
    const r = new Rng(42);
    expect([r.next(), r.next(), r.next(), r.next()]).toEqual([660444221, 3652823732, 77672526, 910233633]);
    const f = Rng.fromLabel(42, 'nav');
    expect([f.next(), f.next(), f.next(), f.next()]).toEqual([1351239251, 3737063818, 3305703104, 1998580328]);
  });

  it('seeds are truncated to uint32: 2^32 + 42 is the same stream as 42, and −1 is 0xffffffff', () => {
    expect(new Rng(2 ** 32 + 42).next()).toBe(new Rng(42).next());
    expect(new Rng(-1).next()).toBe(new Rng(0xffffffff).next());
    expect(new Rng(-1).next()).not.toBe(new Rng(1).next());
  });
});

// ---------------------------------------------------------------------------
// chi2: check the table as quantiles, not through the CDF.
// chi2.test.ts asserts |CDF(x) − level| < 1e-4, but the χ² density at the
// 0.999 quantiles is only ≈ 4–5e-4, so that bound admits an error of ≈ 0.2 in x.
// Inverting the CDF and comparing x directly is what pins the third decimal.
// ---------------------------------------------------------------------------

function gammaHalfInteger(z: number): number {
  if (z === 0.5) return Math.sqrt(Math.PI);
  if (z === 1) return 1;
  return (z - 1) * gammaHalfInteger(z - 1);
}

/** Regularized lower incomplete gamma via its power series (converges for all x). */
function lowerGammaP(a: number, x: number): number {
  let term = Math.exp(-x + a * Math.log(x)) / gammaHalfInteger(a + 1);
  let sum = term;
  for (let n = 1; n < 2000; n++) {
    term *= x / (a + n);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

function chi2Cdf(dof: number, x: number): number {
  return lowerGammaP(dof / 2, x / 2);
}

/** Quantile by bisection: the CDF is monotone, and 100 halvings of [0, 64] leave ≈ 5e-29 of interval. */
function chi2Quantile(dof: number, level: number): number {
  let lo = 0;
  let hi = 64;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (chi2Cdf(dof, mid) < level) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

describe('chi2Critical table entries are the true quantiles rounded to three decimals', () => {
  const LEVELS: Chi2Level[] = [0.9, 0.95, 0.99, 0.999];

  it('dof 2 quantile helper reproduces the closed form −2·ln(1 − level) to 1e-9', () => {
    // The series CDF is accurate to ~1e-12; dividing by the density (≥ 5e-4 here) bounds the x error by ~2e-9.
    for (const level of LEVELS) expect(Math.abs(chi2Quantile(2, level) - -2 * Math.log(1 - level))).toBeLessThan(1e-9);
  });

  it.each([1, 2, 3, 4, 5, 6])('dof %s: every level within 5e-4 of the exact quantile', (dof: number) => {
    // A correctly rounded three-decimal table differs from the exact quantile by at most 5e-4;
    // 1e-8 covers the quantile helper's own error. This bound is ~400× tighter than the CDF test at 0.999.
    for (const level of LEVELS) {
      expect(Math.abs(chi2Critical(dof, level) - chi2Quantile(dof, level))).toBeLessThanOrEqual(5e-4 + 1e-8);
    }
  });
});

// ---------------------------------------------------------------------------
// constants: wrapAngle and the tick clock have no tests of their own, yet every
// heading residual, bearing and scenario time goes through them.
// ---------------------------------------------------------------------------

describe('wrapAngle maps into (−π, π]', () => {
  it('leaves angles already in range untouched', () => {
    for (const a of [0, 0.5, -0.5, 3, -3, Math.PI - 1e-9, -Math.PI + 1e-9]) expect(wrapAngle(a)).toBe(a);
  });

  it('maps both ±π to +π (the interval is closed at +π, open at −π)', () => {
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
  });

  it('removes whole turns exactly and keeps the (−π, π] convention across them', () => {
    expect(wrapAngle(2 * Math.PI)).toBe(0);
    // −2π % 2π is IEEE −0, which is arithmetically zero; compare its magnitude rather than via Object.is.
    expect(Math.abs(wrapAngle(-2 * Math.PI))).toBe(0);
    // % is exact in IEEE arithmetic, so 4π + 0.25 wraps to 0.25 up to the rounding of 4π + 0.25 itself (≈ 2e-15).
    expect(Math.abs(wrapAngle(4 * Math.PI + 0.25) - 0.25)).toBeLessThan(1e-14);
    expect(Math.abs(wrapAngle(-4 * Math.PI - 0.25) + 0.25)).toBeLessThan(1e-14);
    expect(Math.abs(wrapAngle(3 * Math.PI + 0.1) - (-Math.PI + 0.1))).toBeLessThan(1e-14);
  });

  it('turns the INS heading innovation across the seam into a small residual', () => {
    // z = −π + 0.05, h(x) = π − 0.05: the raw difference is −2π + 0.1, the wrapped one is 0.1.
    const raw = -Math.PI + 0.05 - (Math.PI - 0.05);
    expect(raw).toBeLessThan(-6);
    expect(Math.abs(wrapAngle(raw) - 0.1)).toBeLessThan(1e-14);
  });

  it('is idempotent and odd on a deterministic sweep', () => {
    const rng = new Rng(17);
    for (let i = 0; i < 1000; i++) {
      const a = rng.uniform(-100, 100);
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(wrapAngle(w)).toBe(w);
      // cos/sin of the wrapped angle equal those of the original to rounding (|a| ≤ 100 → ≈ 1e-14).
      expect(Math.abs(Math.cos(w) - Math.cos(a))).toBeLessThan(1e-13);
      expect(Math.abs(Math.sin(w) - Math.sin(a))).toBeLessThan(1e-13);
    }
  });
});

describe('tick clock', () => {
  it('TICK_HZ and DT are consistent', () => {
    expect(TICK_HZ).toBe(100);
    expect(DT * TICK_HZ).toBe(1);
  });

  it('secondsToTick rounds to the nearest tick and round-trips whole ticks', () => {
    expect(secondsToTick(0)).toBe(0);
    expect(secondsToTick(1)).toBe(100);
    expect(secondsToTick(40)).toBe(4000);
    expect(secondsToTick(0.004)).toBe(0);
    expect(secondsToTick(0.006)).toBe(1);
    // Scenario times like 0.29 are not exactly representable; rounding must still land on tick 29.
    expect(secondsToTick(0.29)).toBe(29);
    expect(secondsToTick(0.57)).toBe(57);
    for (let tick = 0; tick <= 30_000; tick += 7) expect(secondsToTick(tickToSeconds(tick))).toBe(tick);
  });
});
