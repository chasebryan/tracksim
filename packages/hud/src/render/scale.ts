/**
 * Pure axis-scaling helpers for the scope renderer. No DOM; unit-tested in Node.
 * Series arrive as Float32Array with NaN for "no measurement yet", so every
 * reduction here ignores non-finite samples.
 */

/** Largest finite value, or 0 when the series has none. */
export function finiteMax(values: ArrayLike<number>): number {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max === -Infinity ? 0 : max;
}

/** Most recent finite sample, or null when there is none. */
export function finiteLast(values: ArrayLike<number>): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i] as number;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Round `v` up to the next 1-2-5 × 10^k step so an auto-scaled axis holds
 * still between frames. Non-positive or non-finite input yields 1.
 */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const m = v / base;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * base;
}

/**
 * Y-axis maximum for a NIS sparkline: always shows the gate line with room
 * above it (≥ 2 × gate), grows with the data, and caps at 6 × gate so an
 * isolated sensor's huge residuals clip at the top instead of flattening the
 * trace.
 */
export function nisScaleMax(max: number, gate: number): number {
  const wanted = Number.isFinite(max) ? max * 1.05 : 0;
  return Math.min(6 * gate, Math.max(2 * gate, wanted));
}

/** Metres for a readout: whole metres, one decimal below 10 m. */
export function formatMetres(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
}
