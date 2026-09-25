/**
 * Scope renderer: the filter-integrity strip chart in the right column.
 *
 * Top: `posError` and `posSigma` as two lines on one auto-scaled axis (its
 * maximum is labelled), with `traceP` behind them as a faint filled area on its
 * own scale. Bottom: five mini sparklines of `<ID>_nis`, each with the χ² gate
 * at 9.21 drawn as a line and the trace coloured red wherever it exceeds the
 * gate. Sensor identity comes from the `sensors` argument, so a disabled or
 * isolated sensor is badged. Missing or empty series draw as "no data" rather
 * than throwing, and NaN samples (no measurement yet) break the line.
 *
 * Nothing here reads the wall clock: the picture is a pure function of the
 * series handed in, so a paused HUD renders identically frame after frame.
 */
import { SENSOR_IDS, chi2Critical, type SensorStatus } from '@tracksim/sim';
import type { IScopeRenderer } from '../contracts';
import { FONT, FONT_SMALL, fitCanvas, truncateText } from './canvas-utils';
import { PALETTE, withAlpha } from './colors';
import { finiteLast, finiteMax, formatMetres, niceCeil, nisScaleMax } from './scale';

/** χ²(2, 0.99): the innovation gate every navigation sensor is tested against. */
export const NIS_GATE = chi2Critical(2, 0.99);

const PAD_X = 6;
const MAIN_TOP = 16;
const STRIP_GAP = 4;
const EMPTY: ArrayLike<number> = [];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SensorLine {
  id: string;
  name: string;
  enabled: boolean;
  isolated: boolean;
}

/**
 * Strip-chart view of the navigation filter's health. Construct with the
 * visible canvas; `resize()` on layout changes, `render()` per frame.
 */
export class ScopeRenderer implements IScopeRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private lastSeries: Record<string, Float32Array> | null = null;
  private lastSensors: SensorStatus[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ScopeRenderer: 2D canvas context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const size = fitCanvas(this.canvas, this.ctx);
    this.width = size.width;
    this.height = size.height;
    if (this.lastSeries) this.render(this.lastSeries, this.lastSensors);
  }

  render(series: Record<string, Float32Array>, sensors: SensorStatus[]): void {
    this.lastSeries = series;
    this.lastSensors = sensors;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const mainBottom = Math.round(h * 0.56);
    const main: Rect = { x: PAD_X, y: MAIN_TOP, w: Math.max(1, w - 2 * PAD_X), h: Math.max(1, mainBottom - MAIN_TOP) };
    const strip: Rect = { x: PAD_X, y: mainBottom + 10, w: Math.max(1, w - 2 * PAD_X), h: Math.max(1, h - mainBottom - 16) };

    drawMain(ctx, main, series);
    drawNisStrip(ctx, strip, series, sensorLines(sensors));
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seriesOf(series: Record<string, Float32Array> | null | undefined, key: string): ArrayLike<number> {
  const s = series ? series[key] : undefined;
  return s && typeof s.length === 'number' ? s : EMPTY;
}

function sensorLines(sensors: SensorStatus[] | null | undefined): SensorLine[] {
  if (sensors && sensors.length > 0) {
    return sensors.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, isolated: s.isolated }));
  }
  return SENSOR_IDS.map((id) => ({ id, name: id, enabled: true, isolated: false }));
}

/** x of sample `i` of a series of length `len`, newest sample flush right. */
function xAt(rect: Rect, i: number, len: number, span: number): number {
  return rect.x + rect.w - (len - 1 - i) * (rect.w / (span - 1));
}

/** Stroke a series as a polyline, lifting the pen over non-finite samples. */
function strokeSeries(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  values: ArrayLike<number>,
  span: number,
  yMax: number,
  color: string,
  alpha: number,
  lineWidth: number,
): void {
  const n = values.length;
  if (n === 0) return;
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = values[i] as number;
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = xAt(rect, i, n, span);
    const y = yOf(rect, v, yMax);
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
  const last = finiteLast(values);
  if (last !== null) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(rect.x + rect.w, yOf(rect, last, yMax), 2, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function yOf(rect: Rect, v: number, yMax: number): number {
  const t = yMax > 0 ? Math.min(1, Math.max(0, v / yMax)) : 0;
  return rect.y + rect.h - t * rect.h;
}

function noData(ctx: CanvasRenderingContext2D, rect: Rect, text: string): void {
  ctx.fillStyle = withAlpha(PALETTE.text, 0.4);
  ctx.textAlign = 'center';
  ctx.font = FONT_SMALL;
  ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.font = FONT;
}

// ---------------------------------------------------------------------------
// Main plot: posError, posSigma, traceP
// ---------------------------------------------------------------------------

function drawMain(ctx: CanvasRenderingContext2D, rect: Rect, series: Record<string, Float32Array>): void {
  const err = seriesOf(series, 'posError');
  const sig = seriesOf(series, 'posSigma');
  const tr = seriesOf(series, 'traceP');
  const span = Math.max(2, err.length, sig.length, tr.length);

  // Frame and gridlines.
  ctx.strokeStyle = PALETTE.grid;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  ctx.globalAlpha = 0.35;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  for (const f of [0.25, 0.5, 0.75]) {
    const y = Math.round(rect.y + rect.h * (1 - f)) + 0.5;
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.w, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const errMax = finiteMax(err);
  const sigMax = finiteMax(sig);
  if (err.length === 0 && sig.length === 0 && tr.length === 0) {
    noData(ctx, rect, 'NO DATA');
    return;
  }
  const yMax = niceCeil(Math.max(errMax, sigMax));

  // trace(P): faint area on its own scale, behind the lines.
  const trMax = finiteMax(tr);
  if (tr.length > 0 && trMax > 0) {
    ctx.fillStyle = withAlpha(PALETTE.grid, 0.35);
    ctx.beginPath();
    let started = false;
    let lastX = rect.x;
    for (let i = 0; i < tr.length; i++) {
      const v = tr[i] as number;
      if (!Number.isFinite(v)) continue;
      const x = xAt(rect, i, tr.length, span);
      const y = yOf(rect, v, trMax);
      if (!started) {
        ctx.moveTo(x, rect.y + rect.h);
        started = true;
      }
      ctx.lineTo(x, y);
      lastX = x;
    }
    if (started) {
      ctx.lineTo(lastX, rect.y + rect.h);
      ctx.closePath();
      ctx.fill();
    }
  }

  strokeSeries(ctx, rect, err, span, yMax, PALETTE.unknown, 0.95, 1.2);
  strokeSeries(ctx, rect, sig, span, yMax, PALETTE.sweep, 0.95, 1.2);

  // Axis label (the shared maximum) and the legend with the latest values.
  ctx.textAlign = 'left';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(`max ${formatMetres(yMax)} m`, rect.x + 4, rect.y - 8);
  ctx.textAlign = 'right';
  let x = rect.x + rect.w - 2;
  const legend: Array<[string, string]> = [
    [`tr P ${formatMetres(trMax)}`, withAlpha(PALETTE.text, 0.5)],
    [`σ ${formatMetres(finiteLast(sig) ?? NaN)} m`, PALETTE.sweep],
    [`err ${formatMetres(finiteLast(err) ?? NaN)} m`, PALETTE.unknown],
  ];
  for (const [text, color] of legend) {
    ctx.fillStyle = color;
    ctx.fillText(text, x, rect.y - 8);
    x -= ctx.measureText(text).width + 10;
  }
}

// ---------------------------------------------------------------------------
// NIS strip: one mini sparkline per sensor
// ---------------------------------------------------------------------------

function drawNisStrip(ctx: CanvasRenderingContext2D, rect: Rect, series: Record<string, Float32Array>, sensors: SensorLine[]): void {
  const k = sensors.length;
  if (k === 0) return;
  const cellW = (rect.w - STRIP_GAP * (k - 1)) / k;
  for (let i = 0; i < k; i++) {
    const sensor = sensors[i] as SensorLine;
    const cell: Rect = { x: rect.x + i * (cellW + STRIP_GAP), y: rect.y, w: cellW, h: rect.h };
    drawNisCell(ctx, cell, seriesOf(series, `${sensor.id}_nis`), sensor);
  }
}

function drawNisCell(ctx: CanvasRenderingContext2D, cell: Rect, values: ArrayLike<number>, sensor: SensorLine): void {
  const dim = !sensor.enabled;
  ctx.strokeStyle = PALETTE.grid;
  ctx.globalAlpha = dim ? 0.3 : 0.6;
  ctx.lineWidth = 1;
  ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
  ctx.globalAlpha = 1;

  // Header: id left, latest NIS or badge right; the human name on a second row when it fits.
  ctx.font = FONT_SMALL;
  ctx.textAlign = 'left';
  ctx.fillStyle = dim ? withAlpha(PALETTE.text, 0.4) : PALETTE.text;
  ctx.fillText(sensor.id, cell.x + 3, cell.y + 8);
  const last = finiteLast(values);
  ctx.textAlign = 'right';
  if (dim) {
    ctx.fillStyle = withAlpha(PALETTE.text, 0.4);
    ctx.fillText('OFF', cell.x + cell.w - 3, cell.y + 8);
  } else if (sensor.isolated) {
    ctx.fillStyle = PALETTE.hostile;
    ctx.fillText('ISO', cell.x + cell.w - 3, cell.y + 8);
  } else if (last !== null) {
    ctx.fillStyle = last > NIS_GATE ? PALETTE.hostile : withAlpha(PALETTE.text, 0.75);
    ctx.fillText(last.toFixed(1), cell.x + cell.w - 3, cell.y + 8);
  }
  let plotTop = cell.y + 15;
  if (cell.h - 15 >= 40 && sensor.name !== sensor.id) {
    ctx.textAlign = 'left';
    ctx.fillStyle = withAlpha(PALETTE.text, dim ? 0.3 : 0.5);
    ctx.fillText(truncateText(ctx, sensor.name, cell.w - 6), cell.x + 3, cell.y + 19);
    plotTop = cell.y + 26;
  }
  ctx.font = FONT;

  const plot: Rect = { x: cell.x + 3, y: plotTop, w: Math.max(1, cell.w - 6), h: Math.max(1, cell.y + cell.h - 4 - plotTop) };
  if (values.length === 0) {
    noData(ctx, plot, dim ? '' : 'no data');
    return;
  }
  const yMax = nisScaleMax(finiteMax(values), NIS_GATE);
  const gateY = yOf(plot, NIS_GATE, yMax);

  // Gate line.
  ctx.strokeStyle = PALETTE.hostile;
  ctx.globalAlpha = dim ? 0.25 : 0.55;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(plot.x, gateY);
  ctx.lineTo(plot.x + plot.w, gateY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Trace in two passes: segments touching a sample above the gate go red.
  const n = values.length;
  const span = Math.max(2, n);
  ctx.lineWidth = 1;
  for (const above of [false, true]) {
    ctx.strokeStyle = above ? PALETTE.hostile : PALETTE.sweep;
    ctx.globalAlpha = dim ? 0.3 : 0.9;
    ctx.beginPath();
    let any = false;
    for (let i = 1; i < n; i++) {
      const a = values[i - 1] as number;
      const b = values[i] as number;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if ((a > NIS_GATE || b > NIS_GATE) !== above) continue;
      ctx.moveTo(xAt(plot, i - 1, n, span), yOf(plot, a, yMax));
      ctx.lineTo(xAt(plot, i, n, span), yOf(plot, b, yMax));
      any = true;
    }
    if (any) ctx.stroke();
  }
  if (last !== null) {
    ctx.fillStyle = last > NIS_GATE ? PALETTE.hostile : PALETTE.sweep;
    ctx.globalAlpha = dim ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(plot.x + plot.w, yOf(plot, last, yMax), 1.8, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
