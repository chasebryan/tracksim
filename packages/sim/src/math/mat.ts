/**
 * Minimal dense matrix type for the small (≤ 6×6) systems used by the filters.
 * Row-major Float64Array storage. Methods allocate new matrices unless named
 * `*Into`; sizes here are tiny so clarity wins over allocation micro-tuning.
 */
export class Mat {
  readonly rows: number;
  readonly cols: number;
  readonly data: Float64Array;

  constructor(rows: number, cols: number, data?: Float64Array | ArrayLike<number>) {
    this.rows = rows;
    this.cols = cols;
    if (data) {
      if (data.length !== rows * cols) throw new Error(`Mat: data length ${data.length} != ${rows}x${cols}`);
      this.data = data instanceof Float64Array ? data : Float64Array.from(data);
    } else {
      this.data = new Float64Array(rows * cols);
    }
  }

  static zeros(rows: number, cols: number): Mat {
    return new Mat(rows, cols);
  }

  static identity(n: number): Mat {
    const m = new Mat(n, n);
    for (let i = 0; i < n; i++) m.data[i * n + i] = 1;
    return m;
  }

  static diag(values: ArrayLike<number>): Mat {
    const n = values.length;
    const m = new Mat(n, n);
    for (let i = 0; i < n; i++) m.data[i * n + i] = values[i] as number;
    return m;
  }

  static fromRows(rows: ArrayLike<number>[]): Mat {
    const r = rows.length;
    const c = r > 0 ? (rows[0] as ArrayLike<number>).length : 0;
    const m = new Mat(r, c);
    for (let i = 0; i < r; i++) {
      const row = rows[i] as ArrayLike<number>;
      if (row.length !== c) throw new Error('Mat.fromRows: ragged rows');
      for (let j = 0; j < c; j++) m.data[i * c + j] = row[j] as number;
    }
    return m;
  }

  static col(values: ArrayLike<number>): Mat {
    return new Mat(values.length, 1, Float64Array.from(values as ArrayLike<number>));
  }

  get(i: number, j: number): number {
    return this.data[i * this.cols + j] as number;
  }

  set(i: number, j: number, v: number): void {
    this.data[i * this.cols + j] = v;
  }

  clone(): Mat {
    return new Mat(this.rows, this.cols, new Float64Array(this.data));
  }

  transpose(): Mat {
    const out = new Mat(this.cols, this.rows);
    for (let i = 0; i < this.rows; i++)
      for (let j = 0; j < this.cols; j++) out.data[j * this.rows + i] = this.data[i * this.cols + j] as number;
    return out;
  }

  mul(b: Mat): Mat {
    if (this.cols !== b.rows) throw new Error(`Mat.mul: ${this.rows}x${this.cols} * ${b.rows}x${b.cols}`);
    const out = new Mat(this.rows, b.cols);
    for (let i = 0; i < this.rows; i++) {
      for (let k = 0; k < this.cols; k++) {
        const a = this.data[i * this.cols + k] as number;
        if (a === 0) continue;
        for (let j = 0; j < b.cols; j++) {
          const idx = i * b.cols + j;
          out.data[idx] = (out.data[idx] as number) + a * (b.data[k * b.cols + j] as number);
        }
      }
    }
    return out;
  }

  add(b: Mat): Mat {
    this.assertSameShape(b, 'add');
    const out = this.clone();
    for (let i = 0; i < out.data.length; i++) out.data[i] = (out.data[i] as number) + (b.data[i] as number);
    return out;
  }

  sub(b: Mat): Mat {
    this.assertSameShape(b, 'sub');
    const out = this.clone();
    for (let i = 0; i < out.data.length; i++) out.data[i] = (out.data[i] as number) - (b.data[i] as number);
    return out;
  }

  scale(s: number): Mat {
    const out = this.clone();
    for (let i = 0; i < out.data.length; i++) out.data[i] = (out.data[i] as number) * s;
    return out;
  }

  trace(): number {
    const n = Math.min(this.rows, this.cols);
    let t = 0;
    for (let i = 0; i < n; i++) t += this.data[i * this.cols + i] as number;
    return t;
  }

  /** Force exact symmetry: (A + Aᵀ)/2. Use after covariance updates. */
  symmetrize(): Mat {
    if (this.rows !== this.cols) throw new Error('Mat.symmetrize: not square');
    const out = this.clone();
    const n = this.rows;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const v = 0.5 * ((this.data[i * n + j] as number) + (this.data[j * n + i] as number));
        out.data[i * n + j] = v;
        out.data[j * n + i] = v;
      }
    return out;
  }

  isFinite(): boolean {
    for (let i = 0; i < this.data.length; i++) if (!Number.isFinite(this.data[i] as number)) return false;
    return true;
  }

  /** Gauss–Jordan inverse with partial pivoting. Throws on (near-)singular input. */
  inverse(): Mat {
    if (this.rows !== this.cols) throw new Error('Mat.inverse: not square');
    const n = this.rows;
    const a = new Float64Array(this.data);
    const inv = Mat.identity(n).data;
    for (let col = 0; col < n; col++) {
      let pivot = col;
      let best = Math.abs(a[col * n + col] as number);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(a[r * n + col] as number);
        if (v > best) {
          best = v;
          pivot = r;
        }
      }
      if (best < 1e-300) throw new Error('Mat.inverse: singular matrix');
      if (pivot !== col) {
        swapRows(a, n, col, pivot);
        swapRows(inv, n, col, pivot);
      }
      const p = a[col * n + col] as number;
      for (let j = 0; j < n; j++) {
        a[col * n + j] = (a[col * n + j] as number) / p;
        inv[col * n + j] = (inv[col * n + j] as number) / p;
      }
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = a[r * n + col] as number;
        if (f === 0) continue;
        for (let j = 0; j < n; j++) {
          a[r * n + j] = (a[r * n + j] as number) - f * (a[col * n + j] as number);
          inv[r * n + j] = (inv[r * n + j] as number) - f * (inv[col * n + j] as number);
        }
      }
    }
    return new Mat(n, n, inv);
  }

  /** yᵀ A y for column vector y. */
  quadForm(y: Mat): number {
    if (y.cols !== 1 || y.rows !== this.rows || this.rows !== this.cols) throw new Error('Mat.quadForm: shape');
    let s = 0;
    const n = this.rows;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += (this.data[i * n + j] as number) * (y.data[j] as number);
      s += (y.data[i] as number) * row;
    }
    return s;
  }

  toRows(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.rows; i++) out.push(Array.from(this.data.subarray(i * this.cols, (i + 1) * this.cols)));
    return out;
  }

  private assertSameShape(b: Mat, op: string): void {
    if (this.rows !== b.rows || this.cols !== b.cols)
      throw new Error(`Mat.${op}: ${this.rows}x${this.cols} vs ${b.rows}x${b.cols}`);
  }
}

function swapRows(a: Float64Array, n: number, r1: number, r2: number): void {
  for (let j = 0; j < n; j++) {
    const t = a[r1 * n + j] as number;
    a[r1 * n + j] = a[r2 * n + j] as number;
    a[r2 * n + j] = t;
  }
}
