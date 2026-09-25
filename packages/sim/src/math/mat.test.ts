import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { Mat } from './mat';

/** Largest |a_ij − b_ij| over two same-shaped matrices. */
function maxAbsDiff(a: Mat, b: Mat): number {
  expect(a.rows).toBe(b.rows);
  expect(a.cols).toBe(b.cols);
  let m = 0;
  for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs((a.data[i] as number) - (b.data[i] as number)));
  return m;
}

describe('Mat construction and accessors', () => {
  it('stores row-major data and rejects a length mismatch', () => {
    const m = new Mat(2, 3, [1, 2, 3, 4, 5, 6]);
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(3);
    expect(m.get(0, 0)).toBe(1);
    expect(m.get(0, 2)).toBe(3);
    expect(m.get(1, 0)).toBe(4);
    expect(m.get(1, 2)).toBe(6);
    expect(m.data).toBeInstanceOf(Float64Array);
    expect(() => new Mat(2, 3, [1, 2, 3])).toThrow(/length/);
  });

  it('zeros() is all zero with the requested shape', () => {
    const z = Mat.zeros(3, 2);
    expect(z.rows).toBe(3);
    expect(z.cols).toBe(2);
    expect(Array.from(z.data)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('identity(n) has ones on the diagonal only', () => {
    expect(Mat.identity(3).toRows()).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  it('diag(values) places values on the diagonal', () => {
    expect(Mat.diag([1, 2, 3]).toRows()).toEqual([
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 3],
    ]);
    expect(Mat.diag(new Float64Array([4, 5])).toRows()).toEqual([
      [4, 0],
      [0, 5],
    ]);
  });

  it('fromRows builds the matrix and rejects ragged input', () => {
    const m = Mat.fromRows([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(3);
    expect(Array.from(m.data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(() => Mat.fromRows([[1, 2], [3]])).toThrow(/ragged/);
    expect(Mat.fromRows([]).rows).toBe(0);
  });

  it('col builds an n×1 column and copies its input', () => {
    const src = [1, 2, 3];
    const c = Mat.col(src);
    expect(c.rows).toBe(3);
    expect(c.cols).toBe(1);
    expect(c.get(2, 0)).toBe(3);
    src[0] = 99;
    expect(c.get(0, 0)).toBe(1);
  });

  it('set/get address the right cell and clone is independent', () => {
    const m = Mat.zeros(2, 2);
    m.set(1, 0, 7);
    expect(m.get(1, 0)).toBe(7);
    expect(m.get(0, 1)).toBe(0);
    const c = m.clone();
    c.set(1, 0, -1);
    expect(m.get(1, 0)).toBe(7);
    expect(c.get(1, 0)).toBe(-1);
  });

  it('toRows round-trips fromRows', () => {
    const rows = [
      [1.5, -2],
      [0, 3.25],
      [7, 8],
    ];
    expect(Mat.fromRows(rows).toRows()).toEqual(rows);
  });

  it('isFinite detects NaN and Infinity', () => {
    expect(Mat.identity(2).isFinite()).toBe(true);
    expect(new Mat(1, 2, [1, NaN]).isFinite()).toBe(false);
    expect(new Mat(1, 2, [Infinity, 1]).isFinite()).toBe(false);
  });
});

describe('Mat arithmetic', () => {
  it('mul matches a hand-computed 2×3 · 3×2 product', () => {
    const a = Mat.fromRows([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const b = Mat.fromRows([
      [7, 8],
      [9, 10],
      [11, 12],
    ]);
    // [1·7+2·9+3·11, 1·8+2·10+3·12] = [58, 64]; [4·7+5·9+6·11, 4·8+5·10+6·12] = [139, 154]
    const c = a.mul(b);
    expect(c.rows).toBe(2);
    expect(c.cols).toBe(2);
    expect(c.toRows()).toEqual([
      [58, 64],
      [139, 154],
    ]);
    // 3×2 · 2×3 gives the 3×3 product.
    expect(b.mul(a).toRows()).toEqual([
      [39, 54, 69],
      [49, 68, 87],
      [59, 82, 105],
    ]);
  });

  it('mul by the identity and by a column vector', () => {
    const a = Mat.fromRows([
      [1, 2],
      [3, 4],
    ]);
    expect(a.mul(Mat.identity(2)).toRows()).toEqual(a.toRows());
    expect(Mat.identity(2).mul(a).toRows()).toEqual(a.toRows());
    const y = a.mul(Mat.col([5, 6]));
    expect(y.rows).toBe(2);
    expect(y.cols).toBe(1);
    expect(Array.from(y.data)).toEqual([17, 39]);
  });

  it('mul handles zero entries (skip path) correctly', () => {
    const a = Mat.fromRows([
      [0, 2],
      [0, 0],
    ]);
    const b = Mat.fromRows([
      [1, 1],
      [3, 4],
    ]);
    expect(a.mul(b).toRows()).toEqual([
      [6, 8],
      [0, 0],
    ]);
  });

  it('mul throws on an inner-dimension mismatch', () => {
    expect(() => Mat.zeros(2, 3).mul(Mat.zeros(2, 3))).toThrow(/Mat\.mul/);
    expect(() => Mat.zeros(2, 2).mul(Mat.col([1, 2, 3]))).toThrow(/Mat\.mul/);
  });

  it('transpose swaps rows and columns', () => {
    const a = Mat.fromRows([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const t = a.transpose();
    expect(t.rows).toBe(3);
    expect(t.cols).toBe(2);
    expect(t.toRows()).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    expect(t.transpose().toRows()).toEqual(a.toRows());
    expect(Mat.col([1, 2]).transpose().toRows()).toEqual([[1, 2]]);
  });

  it('add, sub and scale are element-wise and leave operands untouched', () => {
    const a = Mat.fromRows([
      [1, 2],
      [3, 4],
    ]);
    const b = Mat.fromRows([
      [10, 20],
      [30, 40],
    ]);
    expect(a.add(b).toRows()).toEqual([
      [11, 22],
      [33, 44],
    ]);
    expect(b.sub(a).toRows()).toEqual([
      [9, 18],
      [27, 36],
    ]);
    expect(a.scale(-2.5).toRows()).toEqual([
      [-2.5, -5],
      [-7.5, -10],
    ]);
    expect(a.toRows()).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(b.toRows()).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it('add and sub throw on a shape mismatch', () => {
    expect(() => Mat.zeros(2, 2).add(Mat.zeros(2, 3))).toThrow(/Mat\.add/);
    expect(() => Mat.zeros(2, 2).sub(Mat.zeros(3, 2))).toThrow(/Mat\.sub/);
  });

  it('trace sums the main diagonal (min dimension for non-square)', () => {
    expect(
      Mat.fromRows([
        [1, 2],
        [3, 4],
      ]).trace(),
    ).toBe(5);
    expect(Mat.diag([2.5, -1, 4]).trace()).toBe(5.5);
    expect(
      Mat.fromRows([
        [1, 2, 3],
        [4, 5, 6],
      ]).trace(),
    ).toBe(6);
    expect(Mat.identity(6).trace()).toBe(6);
  });

  it('symmetrize averages each off-diagonal pair and keeps the diagonal', () => {
    const s = Mat.fromRows([
      [1, 2, 10],
      [4, 3, -6],
      [0, 8, 5],
    ]).symmetrize();
    expect(s.toRows()).toEqual([
      [1, 3, 5],
      [3, 3, 1],
      [5, 1, 5],
    ]);
    expect(maxAbsDiff(s, s.transpose())).toBe(0);
    expect(() => Mat.zeros(2, 3).symmetrize()).toThrow(/not square/);
  });

  it('quadForm equals yᵀ A y computed by hand', () => {
    const a = Mat.fromRows([
      [2, 1],
      [1, 3],
    ]);
    // A y = [2·1+1·2, 1·1+3·2] = [4, 7]; yᵀ(A y) = 1·4 + 2·7 = 18
    expect(a.quadForm(Mat.col([1, 2]))).toBe(18);
    const b = Mat.fromRows([
      [1, 0, 2],
      [0, 3, 0],
      [2, 0, 1],
    ]);
    // B y for y = [1, -1, 2]: [1+4, -3, 2+2] = [5, -3, 4]; yᵀ(B y) = 5 + 3 + 8 = 16
    expect(b.quadForm(Mat.col([1, -1, 2]))).toBe(16);
    // Identity gives |y|².
    expect(Mat.identity(3).quadForm(Mat.col([3, 4, 12]))).toBe(169);
  });

  it('quadForm throws on shape errors', () => {
    const a = Mat.identity(2);
    expect(() => a.quadForm(Mat.col([1, 2, 3]))).toThrow(/shape/);
    expect(() => a.quadForm(new Mat(1, 2, [1, 2]))).toThrow(/shape/);
    expect(() => Mat.zeros(2, 3).quadForm(Mat.col([1, 2]))).toThrow(/shape/);
  });
});

describe('Mat.inverse', () => {
  it('matches a hand-computed 2×2 inverse', () => {
    // det = 4·6 − 7·2 = 10 → inverse = (1/10)·[[6, −7], [−2, 4]]
    const inv = Mat.fromRows([
      [4, 7],
      [2, 6],
    ]).inverse();
    const expected = Mat.fromRows([
      [0.6, -0.7],
      [-0.2, 0.4],
    ]);
    // Exact arithmetic yields these decimals; allow double rounding only.
    expect(maxAbsDiff(inv, expected)).toBeLessThan(1e-15);
  });

  it('pivots rows when the leading entry is zero', () => {
    const p = Mat.fromRows([
      [0, 1],
      [1, 0],
    ]);
    expect(p.inverse().toRows()).toEqual([
      [0, 1],
      [1, 0],
    ]);
    const m = Mat.fromRows([
      [0, 2, 0],
      [0, 0, 4],
      [8, 0, 0],
    ]);
    expect(m.inverse().toRows()).toEqual([
      [0, 0, 0.125],
      [0.5, 0, 0],
      [0, 0.25, 0],
    ]);
  });

  it('inverse(A)·A ≈ I and A·inverse(A) ≈ I for random well-conditioned 4×4 matrices', () => {
    const rng = new Rng(4242);
    const I = Mat.identity(4);
    let worst = 0;
    for (let trial = 0; trial < 25; trial++) {
      // Entries U(−1, 1) plus 4 on the diagonal → strictly diagonally dominant, condition number ≲ 5,
      // so Gauss–Jordan in doubles should be accurate to ~1e-15; 1e-9 leaves ample slack.
      const a = Mat.zeros(4, 4);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) a.set(i, j, rng.uniform(-1, 1) + (i === j ? 4 : 0));
      const inv = a.inverse();
      worst = Math.max(worst, maxAbsDiff(inv.mul(a), I), maxAbsDiff(a.mul(inv), I));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('inverse of a symmetric positive-definite matrix is symmetric to rounding', () => {
    const s = Mat.fromRows([
      [4, 1, 0.5],
      [1, 3, 0.2],
      [0.5, 0.2, 2],
    ]);
    const inv = s.inverse();
    expect(maxAbsDiff(inv, inv.transpose())).toBeLessThan(1e-15);
  });

  it('inverse does not modify the source matrix', () => {
    const a = Mat.fromRows([
      [2, 1],
      [1, 2],
    ]);
    a.inverse();
    expect(a.toRows()).toEqual([
      [2, 1],
      [1, 2],
    ]);
  });

  it('throws on a singular matrix', () => {
    expect(() =>
      Mat.fromRows([
        [1, 2],
        [2, 4],
      ]).inverse(),
    ).toThrow(/singular/);
    expect(() => Mat.zeros(3, 3).inverse()).toThrow(/singular/);
    expect(() =>
      Mat.fromRows([
        [1, 2, 3],
        [1, 2, 3],
        [0, 0, 1],
      ]).inverse(),
    ).toThrow(/singular/);
    expect(() =>
      Mat.fromRows([
        [1, 0],
        [3, 0],
      ]).inverse(),
    ).toThrow(/singular/);
  });

  it('throws for a non-square matrix', () => {
    expect(() => Mat.zeros(2, 3).inverse()).toThrow(/not square/);
  });
});
