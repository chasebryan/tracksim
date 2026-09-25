import { describe, expect, it } from 'vitest';
import { finiteLast, finiteMax, formatMetres, niceCeil, nisScaleMax } from './scale';

// Exact comparisons throughout: these helpers do integer-ish arithmetic on
// small inputs; niceCeil's 10 ** exp is exact for the exponents used here.

describe('finiteMax / finiteLast', () => {
  it('ignore NaN and infinities', () => {
    const s = new Float32Array([NaN, 3, Infinity, 7.5, NaN]);
    expect(finiteMax(s)).toBe(7.5);
    expect(finiteLast(s)).toBe(7.5);
  });

  it('report 0 / null for empty or all-NaN series', () => {
    expect(finiteMax(new Float32Array(0))).toBe(0);
    expect(finiteMax([NaN, NaN])).toBe(0);
    expect(finiteLast(new Float32Array(0))).toBeNull();
    expect(finiteLast([NaN])).toBeNull();
  });

  it('accept plain arrays', () => {
    expect(finiteMax([1, -5, 2])).toBe(2);
    expect(finiteLast([1, -5, 2])).toBe(2);
  });
});

describe('niceCeil', () => {
  it('rounds up to a 1-2-5 progression', () => {
    expect(niceCeil(0.7)).toBe(1);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(5)).toBe(5);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(123)).toBe(200);
    expect(niceCeil(480)).toBe(500);
    expect(niceCeil(4200)).toBe(5000);
  });

  it('falls back to 1 for degenerate input', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-3)).toBe(1);
    expect(niceCeil(NaN)).toBe(1);
    expect(niceCeil(Infinity)).toBe(1);
  });
});

describe('nisScaleMax', () => {
  const gate = 9.21;
  it('never drops below twice the gate so the gate line stays mid-plot', () => {
    expect(nisScaleMax(0, gate)).toBe(2 * gate);
    expect(nisScaleMax(5, gate)).toBe(2 * gate);
    expect(nisScaleMax(NaN, gate)).toBe(2 * gate);
  });
  it('tracks the data with 5% headroom and caps at six gates', () => {
    expect(nisScaleMax(30, gate)).toBeCloseTo(31.5, 12);
    expect(nisScaleMax(1e6, gate)).toBe(6 * gate);
  });
});

describe('formatMetres', () => {
  it('uses one decimal below 10 m and whole metres above', () => {
    expect(formatMetres(3.14159)).toBe('3.1');
    expect(formatMetres(9.99)).toBe('10.0');
    expect(formatMetres(42.6)).toBe('43');
    expect(formatMetres(NaN)).toBe('—');
  });
});
