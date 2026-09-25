import { describe, expect, it } from 'vitest';
import { chi2Critical, type Chi2Level } from './chi2';

const LEVELS: Chi2Level[] = [0.9, 0.95, 0.99, 0.999];
const DOFS = [1, 2, 3, 4, 5, 6];

/** Γ(z) for z a positive multiple of 1/2, by the recurrence from Γ(1/2) = √π and Γ(1) = 1. */
function gammaHalfInteger(z: number): number {
  if (z === 0.5) return Math.sqrt(Math.PI);
  if (z === 1) return 1;
  return (z - 1) * gammaHalfInteger(z - 1);
}

/**
 * Regularized lower incomplete gamma P(a, x) = e⁻ˣ xᵃ Σₙ xⁿ / Γ(a+n+1).
 * The series converges for all x; for the x ≤ 12 used here a few hundred terms
 * take it below double precision.
 */
function lowerGammaP(a: number, x: number): number {
  let term = Math.exp(-x + a * Math.log(x)) / gammaHalfInteger(a + 1);
  let sum = term;
  for (let n = 1; n < 1000; n++) {
    term *= x / (a + n);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** CDF of the chi-square distribution with `dof` degrees of freedom. */
function chi2Cdf(dof: number, x: number): number {
  return lowerGammaP(dof / 2, x / 2);
}

describe('chi2Critical', () => {
  it('returns the standard table for dof 2 at every level', () => {
    expect(chi2Critical(2, 0.9)).toBe(4.605);
    expect(chi2Critical(2, 0.95)).toBe(5.991);
    expect(chi2Critical(2, 0.99)).toBe(9.21);
    expect(chi2Critical(2, 0.999)).toBe(13.816);
  });

  it('dof 2 agrees with the closed form −2·ln(1 − level)', () => {
    // χ²(2) is exponential with mean 2, so the quantile is exactly −2·ln(1 − level).
    // The table carries three decimals, so agreement is within half a unit in the last place (5e-4).
    for (const level of LEVELS) {
      const exact = -2 * Math.log(1 - level);
      expect(Math.abs(chi2Critical(2, level) - exact)).toBeLessThan(5e-4 + 1e-12);
    }
  });

  it('every tabulated value satisfies CDF(value) ≈ level', () => {
    // A 5e-4 rounding of the tabulated x moves the CDF by at most pdf·5e-4 ≤ 0.07·5e-4 = 3.5e-5
    // (the pdf at these quantiles never exceeds 0.07), so 1e-4 catches any error in the third decimal.
    for (const dof of DOFS) {
      for (const level of LEVELS) {
        const cdf = chi2Cdf(dof, chi2Critical(dof, level));
        expect(Math.abs(cdf - level)).toBeLessThan(1e-4);
      }
    }
  });

  it('the helper CDF itself is sane (dof 2 closed form, dof 4 closed form)', () => {
    // χ²(2): CDF = 1 − e^(−x/2). χ²(4): CDF = 1 − e^(−x/2)·(1 + x/2).
    for (const x of [0.5, 2, 5, 9.21, 13.816]) {
      expect(Math.abs(chi2Cdf(2, x) - (1 - Math.exp(-x / 2)))).toBeLessThan(1e-12);
      expect(Math.abs(chi2Cdf(4, x) - (1 - Math.exp(-x / 2) * (1 + x / 2)))).toBeLessThan(1e-12);
    }
  });

  it('is strictly increasing in level for every dof', () => {
    for (const dof of DOFS) {
      for (let i = 1; i < LEVELS.length; i++) {
        expect(chi2Critical(dof, LEVELS[i] as Chi2Level)).toBeGreaterThan(chi2Critical(dof, LEVELS[i - 1] as Chi2Level));
      }
    }
  });

  it('is strictly increasing in dof for every level', () => {
    for (const level of LEVELS) {
      for (let i = 1; i < DOFS.length; i++) {
        expect(chi2Critical(DOFS[i] as number, level)).toBeGreaterThan(chi2Critical(DOFS[i - 1] as number, level));
      }
    }
  });

  it('matches the gate values named in CONTRACTS.md', () => {
    expect(chi2Critical(2, 0.999)).toBe(13.816);
    expect(chi2Critical(2, 0.99)).toBe(9.21);
    expect(chi2Critical(2, 0.95)).toBe(5.991);
  });

  it('throws for an unsupported dof', () => {
    expect(() => chi2Critical(0, 0.99)).toThrow(/unsupported dof 0/);
    expect(() => chi2Critical(7, 0.99)).toThrow(/unsupported dof 7/);
    expect(() => chi2Critical(-1, 0.95)).toThrow(/unsupported dof/);
    expect(() => chi2Critical(2.5, 0.95)).toThrow(/unsupported dof/);
    expect(() => chi2Critical(NaN, 0.95)).toThrow(/unsupported dof/);
  });
});
