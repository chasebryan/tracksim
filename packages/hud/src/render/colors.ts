/**
 * HUD palette: dark cyan aesthetic shared by the globe and scope renderers.
 * Every colour the renderers use is named here so the two canvases and the
 * DOM panels read as one instrument.
 */
import type { TrackLabel } from '@tracksim/sim';

export interface Palette {
  /** Canvas ground. */
  background: string;
  /** Wireframe, range rings, axes and gridlines. */
  grid: string;
  /** Track label colours. */
  friendly: string;
  unknown: string;
  hostile: string;
  decoy: string;
  /** Ground-truth overlay (contacts the tracker does not know about). */
  truth: string;
  /** Labels and readouts. */
  text: string;
  /** Radar sweep, boresight and the "σ" series on the scope. */
  sweep: string;
}

export const PALETTE: Palette = {
  background: '#050b10',
  grid: '#155563',
  friendly: '#3ddc84',
  unknown: '#f5b83d',
  hostile: '#ff4d4f',
  decoy: '#e04bff',
  truth: '#b8f4ff',
  text: '#c7f3ff',
  sweep: '#2ee6d6',
};

/** Colour a track is drawn in, by its label. */
export function labelColor(label: TrackLabel, palette: Palette = PALETTE): string {
  switch (label) {
    case 'friendly':
      return palette.friendly;
    case 'hostile':
      return palette.hostile;
    case 'decoy':
      return palette.decoy;
    default:
      return palette.unknown;
  }
}

/**
 * `#rrggbb` → `rgba(r, g, b, alpha)`. Used for fills and fades so the palette
 * stays a single list of opaque hex colours. Alpha is clamped to [0, 1].
 */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1] as string, 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
