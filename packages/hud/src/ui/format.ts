/**
 * Number formatting for HUD readouts. Every helper returns a short string
 * that is safe to assign to `textContent`; non-finite inputs render as `--`
 * so a measurement that does not exist yet never shows as "NaN".
 *
 * Angles follow the sim convention: radians, 0 = north, clockwise positive.
 */

const DASH = '--';
const RAD_TO_DEG = 180 / Math.PI;

/** Fixed-decimal number; `--` when not finite; never renders "-0.0". */
export function fixed(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return DASH;
  const s = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** Rounded integer; `--` when not finite. */
export function integer(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : DASH;
}

/** Metres with a unit suffix, e.g. `12.3 m`. */
export function metres(value: number, decimals = 1): string {
  return `${fixed(value, decimals)} m`;
}

/** Metres rendered in kilometres, e.g. `12.3 km`. */
export function km(valueMetres: number, decimals = 1): string {
  return `${fixed(valueMetres / 1000, decimals)} km`;
}

/** Speed in metres per second, e.g. `231.0 m/s`. */
export function speed(mps: number, decimals = 1): string {
  return `${fixed(mps, decimals)} m/s`;
}

/** Compass degrees in [0, 360) from radians with 0 = north, clockwise positive. */
export function toDegrees(rad: number): number {
  if (!Number.isFinite(rad)) return NaN;
  let d = (rad * RAD_TO_DEG) % 360;
  if (d < 0) d += 360;
  if (d >= 360) d -= 360;
  return d;
}

/** Compass heading/bearing string, e.g. `045.0°` (zero-padded to three integer digits). */
export function degrees(rad: number, decimals = 1): string {
  const d = toDegrees(rad);
  if (!Number.isFinite(d)) return `${DASH}°`;
  const s = d.toFixed(decimals);
  const dot = s.indexOf('.');
  const intLen = dot < 0 ? s.length : dot;
  return `${'0'.repeat(Math.max(0, 3 - intLen))}${s}°`;
}

/** Signed angle in (-180, 180] degrees, e.g. `-1.25°`; for errors and deltas. */
export function signedDegrees(rad: number, decimals = 2): string {
  if (!Number.isFinite(rad)) return `${DASH}°`;
  let d = (rad * RAD_TO_DEG) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return `${fixed(d, decimals)}°`;
}

/** Fraction rendered as a percentage, e.g. `42%`. */
export function percent(fraction: number, decimals = 0): string {
  if (!Number.isFinite(fraction)) return `${DASH}%`;
  return `${fixed(fraction * 100, decimals)}%`;
}

/** Microseconds, e.g. `142 µs`. */
export function micros(value: number, decimals = 0): string {
  return `${fixed(value, decimals)} µs`;
}

/** Byte count with a binary unit, e.g. `1.2 MB`. */
export function bytes(value: number): string {
  if (!Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  if (abs < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = value / 1024;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${fixed(v, 1)} ${units[i]}`;
}

/** Sim time as `T+MM:SS.ss` (centiseconds, rounded); `T+--:--.--` when not finite. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'T+--:--.--';
  const cs = Math.max(0, Math.round(seconds * 100));
  const mm = Math.floor(cs / 6000);
  const rest = cs - mm * 6000;
  const ss = Math.floor(rest / 100);
  const cc = rest - ss * 100;
  return `T+${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

/** Clamp a fraction into [0, 1], mapping NaN to 0. */
export function clamp01(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}
