/**
 * Seeded, forkable PRNG (xoshiro128** seeded by splitmix32).
 *
 * Every source of randomness in the simulation draws from an Rng derived from
 * the run seed, so the same (seed, scenario, command log) reproduces a run
 * bit-for-bit. Subsystems take a `fork(label)` so adding a random draw in one
 * subsystem cannot perturb another's stream.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    // splitmix32 to expand the seed into four non-zero state words
    let x = seed >>> 0;
    const next = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Derive a stream for a labelled subsystem; deterministic in (seed, label). */
  static fromLabel(seed: number, label: string): Rng {
    return new Rng(fnv1a(label, seed >>> 0));
  }

  fork(label: string): Rng {
    return new Rng(fnv1a(label, this.next()));
  }

  /** Next uint32. */
  next(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9)) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  int(loInclusive: number, hiExclusive: number): number {
    return loInclusive + Math.floor(this.float() * (hiExclusive - loInclusive));
  }

  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  /** Standard normal via Box–Muller (caches the spare deviate). */
  normal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    let u1 = this.float();
    if (u1 < 1e-12) u1 = 1e-12;
    const u2 = this.float();
    const r = Math.sqrt(-2 * Math.log(u1));
    const th = 2 * Math.PI * u2;
    this.spareNormal = r * Math.sin(th);
    return r * Math.cos(th);
  }

  gaussian(mean: number, sigma: number): number {
    return mean + sigma * this.normal();
  }

  /** Poisson-distributed count (Knuth for small λ, normal approximation above 50). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 50) return Math.max(0, Math.round(this.gaussian(lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.float();
    } while (p > L);
    return k - 1;
  }

  /** Serializable state for checkpoint/restore. */
  getState(): [number, number, number, number, number | null] {
    return [this.s0, this.s1, this.s2, this.s3, this.spareNormal];
  }

  setState(s: [number, number, number, number, number | null]): void {
    [this.s0, this.s1, this.s2, this.s3, this.spareNormal] = s;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function fnv1a(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
