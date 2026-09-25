import { describe, expect, it } from 'vitest';
import { Rng } from './rng';

/** Draw `n` raw uint32 values. */
function draws(rng: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.next());
  return out;
}

/** Draw a fixed mix of every generator so state round-trips exercise all of them. */
function mixedDraws(rng: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    switch (i % 7) {
      case 0:
        out.push(rng.next());
        break;
      case 1:
        out.push(rng.float());
        break;
      case 2:
        out.push(rng.normal());
        break;
      case 3:
        out.push(rng.gaussian(3, 2));
        break;
      case 4:
        out.push(rng.poisson(4));
        break;
      case 5:
        out.push(rng.int(-10, 10));
        break;
      default:
        out.push(rng.bool(0.3) ? 1 : 0);
    }
  }
  return out;
}

describe('Rng determinism', () => {
  it('same seed produces identical uint32 sequences', () => {
    expect(draws(new Rng(42), 1000)).toEqual(draws(new Rng(42), 1000));
  });

  it('same seed produces identical mixed-type sequences', () => {
    expect(mixedDraws(new Rng(42), 700)).toEqual(mixedDraws(new Rng(42), 700));
  });

  it('different seeds produce different sequences', () => {
    expect(draws(new Rng(42), 16)).not.toEqual(draws(new Rng(43), 16));
    expect(draws(new Rng(0), 16)).not.toEqual(draws(new Rng(1), 16));
  });

  it('next() yields integers in [0, 2^32)', () => {
    const rng = new Rng(7);
    let ok = true;
    for (let i = 0; i < 20_000; i++) {
      const v = rng.next();
      if (!Number.isInteger(v) || v < 0 || v >= 4294967296) ok = false;
    }
    expect(ok).toBe(true);
  });
});

describe('Rng.fromLabel', () => {
  it('is stable for the same (seed, label)', () => {
    expect(draws(Rng.fromLabel(1, 'nav'), 100)).toEqual(draws(Rng.fromLabel(1, 'nav'), 100));
    expect(draws(Rng.fromLabel(123456, 'tracker'), 100)).toEqual(draws(Rng.fromLabel(123456, 'tracker'), 100));
  });

  it('depends on the label', () => {
    const nav = draws(Rng.fromLabel(1, 'nav'), 16);
    expect(nav).not.toEqual(draws(Rng.fromLabel(1, 'world'), 16));
    expect(nav).not.toEqual(draws(Rng.fromLabel(1, 'radar'), 16));
    expect(nav).not.toEqual(draws(Rng.fromLabel(1, 'nav2'), 16));
  });

  it('depends on the seed', () => {
    expect(draws(Rng.fromLabel(1, 'nav'), 16)).not.toEqual(draws(Rng.fromLabel(2, 'nav'), 16));
  });

  it('differs from the raw seed stream', () => {
    expect(draws(Rng.fromLabel(1, 'nav'), 16)).not.toEqual(draws(new Rng(1), 16));
  });
});

describe('Rng.fork', () => {
  it('fork streams differ from the parent and from each other', () => {
    const parent = new Rng(99);
    const f1 = parent.fork('a');
    const f2 = parent.fork('a');
    const f3 = parent.fork('b');
    const p = draws(parent, 32);
    const s1 = draws(f1, 32);
    const s2 = draws(f2, 32);
    const s3 = draws(f3, 32);
    expect(s1).not.toEqual(p);
    expect(s2).not.toEqual(p);
    expect(s3).not.toEqual(p);
    expect(s1).not.toEqual(s2);
    expect(s1).not.toEqual(s3);
    expect(s2).not.toEqual(s3);
  });

  it('is deterministic in (parent state, label)', () => {
    const a = new Rng(5);
    const b = new Rng(5);
    expect(draws(a.fork('x'), 64)).toEqual(draws(b.fork('x'), 64));
    // Same parent state, different label → different child.
    const c = new Rng(5);
    const d = new Rng(5);
    expect(draws(c.fork('x'), 16)).not.toEqual(draws(d.fork('y'), 16));
  });

  it('advances the parent by exactly one draw', () => {
    const forked = new Rng(5);
    forked.fork('x');
    const plain = new Rng(5);
    plain.next();
    expect(draws(forked, 64)).toEqual(draws(plain, 64));
  });
});

describe('Rng.float / uniform', () => {
  it('float() lies in [0, 1) and is roughly uniform over 1e5 draws', () => {
    const rng = new Rng(2024);
    const N = 100_000;
    const bins = new Array<number>(10).fill(0);
    let sum = 0;
    let inRange = true;
    for (let i = 0; i < N; i++) {
      const u = rng.float();
      if (!(u >= 0 && u < 1)) inRange = false;
      sum += u;
      const b = Math.floor(u * 10);
      bins[b] = (bins[b] as number) + 1;
    }
    expect(inRange).toBe(true);
    // Mean of U(0,1) is 0.5 with sd 1/√12; the standard error over 1e5 draws is 9.1e-4, so ±0.005 is ≈ 5.5σ.
    expect(Math.abs(sum / N - 0.5)).toBeLessThan(0.005);
    // Each decile holds N/10 = 10 000 ± √(N·0.1·0.9) ≈ 95 (1σ); ±500 is ≈ 5σ.
    for (const count of bins) expect(Math.abs(count - N / 10)).toBeLessThan(500);
  });

  it('uniform(lo, hi) stays within [lo, hi) with mean ≈ (lo + hi) / 2', () => {
    const rng = new Rng(77);
    const N = 50_000;
    let sum = 0;
    let inRange = true;
    for (let i = 0; i < N; i++) {
      const v = rng.uniform(-4, 6);
      if (!(v >= -4 && v < 6)) inRange = false;
      sum += v;
    }
    expect(inRange).toBe(true);
    // sd of U(-4, 6) is 10/√12 = 2.89; standard error over 5e4 draws is 0.013, so ±0.08 is ≈ 6σ.
    expect(Math.abs(sum / N - 1)).toBeLessThan(0.08);
  });
});

describe('Rng.normal / gaussian', () => {
  it('normal() has mean ≈ 0 and variance ≈ 1 over 2e5 draws', () => {
    const rng = new Rng(31337);
    const N = 200_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) {
      const v = rng.normal();
      s += v;
      s2 += v * v;
    }
    const mean = s / N;
    const variance = s2 / N - mean * mean;
    // SE(mean) = 1/√N = 0.0022 and SE(variance) = √(2/N) = 0.0032, so ±0.02 is ≥ 6σ for both.
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(variance - 1)).toBeLessThan(0.02);
  });

  it('normal() tail fractions match the standard normal', () => {
    const rng = new Rng(4711);
    const N = 200_000;
    let beyond196 = 0;
    let beyond3 = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.abs(rng.normal());
      if (a > 1.96) beyond196++;
      if (a > 3) beyond3++;
    }
    // P(|Z| > 1.96) = 0.05, SE = √(0.05·0.95/N) = 4.9e-4 → ±0.005 is ≈ 10σ.
    expect(Math.abs(beyond196 / N - 0.05)).toBeLessThan(0.005);
    // P(|Z| > 3) = 0.0027, SE = 1.2e-4 → ±0.001 is ≈ 8σ.
    expect(Math.abs(beyond3 / N - 0.0027)).toBeLessThan(0.001);
  });

  it('gaussian(m, s) has mean ≈ m and sd ≈ s', () => {
    const rng = new Rng(9001);
    const N = 200_000;
    const m = 5;
    const sd = 3;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) {
      const v = rng.gaussian(m, sd);
      s += v;
      s2 += v * v;
    }
    const mean = s / N;
    const variance = s2 / N - mean * mean;
    // SE(mean) = sd/√N = 0.0067 → ±0.02·sd = 0.06 is ≈ 9σ; SE(variance) = sd²·√(2/N) = 0.028 → ±0.02·sd² = 0.18 is ≈ 6σ.
    expect(Math.abs(mean - m)).toBeLessThan(0.02 * sd);
    expect(Math.abs(variance - sd * sd)).toBeLessThan(0.02 * sd * sd);
  });

  it('gaussian(m, 0) returns exactly m', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 10; i++) expect(rng.gaussian(-2.5, 0)).toBe(-2.5);
  });
});

describe('Rng.poisson', () => {
  it.each([0.5, 3, 20, 80])('poisson(%s) has sample mean and variance within 5% of λ', (lambda: number) => {
    const rng = new Rng(1000 + Math.round(lambda * 10));
    const N = 50_000;
    let s = 0;
    let s2 = 0;
    let wellFormed = true;
    for (let i = 0; i < N; i++) {
      const k = rng.poisson(lambda);
      if (!Number.isInteger(k) || k < 0) wellFormed = false;
      s += k;
      s2 += k * k;
    }
    const mean = s / N;
    const variance = s2 / N - mean * mean;
    expect(wellFormed).toBe(true);
    // SE(mean) = √(λ/N): 0.0032 (λ=0.5) … 0.04 (λ=80); 5% of λ is 0.025 … 4, i.e. ≥ 7σ.
    expect(Math.abs(mean - lambda)).toBeLessThan(0.05 * lambda);
    // Poisson variance is λ. Var(s²) ≈ (μ₄ − λ²)/N = (2λ² + λ)/N → SE 0.0045 (λ=0.5) … 0.51 (λ=80);
    // 5% of λ is ≥ 5σ at every λ. The λ>50 normal-approximation path adds only the 1/12 rounding variance.
    expect(Math.abs(variance - lambda)).toBeLessThan(0.05 * lambda);
  });

  it('returns 0 for λ ≤ 0 without consuming randomness', () => {
    const rng = new Rng(3);
    const before = rng.getState();
    expect(rng.poisson(0)).toBe(0);
    expect(rng.poisson(-2)).toBe(0);
    expect(rng.getState()).toEqual(before);
  });
});

describe('Rng.int / bool', () => {
  it('int(lo, hi) stays within [lo, hi) and covers every value about equally', () => {
    const rng = new Rng(11);
    const lo = -3;
    const hi = 5;
    const N = 100_000;
    const counts = new Array<number>(hi - lo).fill(0);
    let ok = true;
    for (let i = 0; i < N; i++) {
      const v = rng.int(lo, hi);
      if (!Number.isInteger(v) || v < lo || v >= hi) ok = false;
      else counts[v - lo] = (counts[v - lo] as number) + 1;
    }
    expect(ok).toBe(true);
    // Each of the 8 values expects N/8 = 12 500 ± √(N·(1/8)·(7/8)) ≈ 105 (1σ); ±625 is ≈ 6σ.
    for (const c of counts) expect(Math.abs(c - N / 8)).toBeLessThan(625);
  });

  it('int(lo, lo + 1) always returns lo', () => {
    const rng = new Rng(12);
    for (let i = 0; i < 1000; i++) expect(rng.int(7, 8)).toBe(7);
  });

  it.each([0.1, 0.5, 0.9])('bool(%s) is true with frequency ≈ p', (p: number) => {
    const rng = new Rng(500 + Math.round(p * 100));
    const N = 100_000;
    let trues = 0;
    for (let i = 0; i < N; i++) if (rng.bool(p)) trues++;
    // SE = √(p(1−p)/N) ≤ 0.0016, so ±0.01 is ≥ 6σ.
    expect(Math.abs(trues / N - p)).toBeLessThan(0.01);
  });

  it('bool() defaults to p = 0.5', () => {
    const a = new Rng(21);
    const b = new Rng(21);
    for (let i = 0; i < 1000; i++) expect(a.bool()).toBe(b.bool(0.5));
  });

  it('bool(0) is never true and bool(1) is always true', () => {
    const rng = new Rng(22);
    let anyTrue = false;
    let anyFalse = false;
    for (let i = 0; i < 10_000; i++) {
      if (rng.bool(0)) anyTrue = true;
      if (!rng.bool(1)) anyFalse = true;
    }
    expect(anyTrue).toBe(false);
    expect(anyFalse).toBe(false);
  });
});

describe('Rng state checkpoint/restore', () => {
  it('getState/setState reproduces the continuation exactly', () => {
    const rng = new Rng(77);
    mixedDraws(rng, 33);
    const state = rng.getState();
    const first = mixedDraws(rng, 350);
    rng.setState(state);
    expect(mixedDraws(rng, 350)).toEqual(first);
  });

  it('a state applied to a different instance reproduces the same continuation', () => {
    const source = new Rng(77);
    mixedDraws(source, 33);
    const state = source.getState();
    const expected = mixedDraws(source, 350);
    const other = new Rng(1);
    mixedDraws(other, 5);
    other.setState(state);
    expect(mixedDraws(other, 350)).toEqual(expected);
  });

  it('getState returns a snapshot that later draws do not mutate', () => {
    const rng = new Rng(8);
    const state = rng.getState();
    const copy = [...state];
    draws(rng, 10);
    expect(state).toEqual(copy);
    expect(rng.getState()).not.toEqual(copy);
  });

  it('the cached Box–Muller spare survives the round trip', () => {
    const rng = new Rng(3);
    rng.normal();
    const state = rng.getState();
    expect(state[4]).not.toBeNull();
    const spare = rng.normal();
    expect(spare).toBe(state[4]);
    const other = new Rng(0);
    other.setState(state);
    expect(other.normal()).toBe(spare);
    expect(other.getState()[4]).toBeNull();
  });
});
