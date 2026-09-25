/**
 * Small DOM-side helpers shared by the globe and scope renderers: backing-store
 * sizing with a single absolute DPR transform, the monospace font stack, and
 * text fitting.
 */

/** A 2-D context on either the visible canvas or an offscreen layer. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const FONT = '11px ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';
export const FONT_SMALL = '10px ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

export interface CanvasSize {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
}

/**
 * Read the parent's CSS box (falling back to the canvas's own box when it is
 * detached) and `devicePixelRatio`, size the backing store once, and install
 * the DPR as an absolute transform so repeated calls never accumulate scale.
 */
export function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): CanvasSize {
  const host = canvas.parentElement ?? canvas;
  const rect = host.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const raw = globalThis.devicePixelRatio;
  const dpr = typeof raw === 'number' && raw > 0 ? raw : 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height, dpr };
}

/** Shorten `text` with an ellipsis until it fits `maxWidth` in the context's current font. */
export function truncateText(ctx: Ctx2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1) {
    s = s.slice(0, -1);
    if (ctx.measureText(`${s}…`).width <= maxWidth) return `${s}…`;
  }
  return '';
}
