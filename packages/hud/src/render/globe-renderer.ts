/**
 * Globe renderer: the centre canvas of the HUD.
 *
 * Two layers. The static layer (an OffscreenCanvas, or a detached canvas
 * where OffscreenCanvas is unavailable) holds the sphere wireframe, the
 * 15/30/45/60 km range rings and the azimuth ticks; it is repainted only by
 * `resize()` or when the rotation changes. `render()` blits it and draws the
 * dynamic layer on top: the radar sweep, the scan pulse, the optional truth
 * overlay, tracks as label-coloured brackets with callsign and range, the
 * selection diamond, the centre boresight and the navigation-uncertainty
 * gauge. Every animated quantity derives from `snapshot.tick`, never from the
 * wall clock, so a frame is a pure function of (snapshot, options, rotation,
 * size) and screenshot tests are reproducible.
 *
 * The backing store is sized once per `resize()` from the parent's CSS box and
 * `devicePixelRatio`; the DPR is installed with an absolute `setTransform`, so
 * repeated resizes never accumulate scale. Drag-to-rotate uses pointer events
 * with pointer capture; pitch is clamped to ±MAX_PITCH.
 */
import { DEG, RAD, TICK_HZ, type ContactSnapshot, type NavEstimate, type Snapshot, type TrackSnapshot, type TrackStatus } from '@tracksim/sim';
import type { GlobeRenderOptions, IGlobeRenderer } from '../contracts';
import { FONT, FONT_SMALL, fitCanvas, type Ctx2D } from './canvas-utils';
import { PALETTE, labelColor, withAlpha } from './colors';
import {
  clampPitch,
  projectPoint,
  projectSpherical,
  screenDistance,
  sphericalToPoint,
  wrapYaw,
  type ScreenPoint,
  type View,
} from './projection';

/** The globe's radius in metres: the outermost range ring. */
export const SPHERE_RANGE_M = 60_000;
/** Range rings drawn on the ground plane, metres. */
export const RANGE_RINGS_M: readonly number[] = [15_000, 30_000, 45_000, 60_000];
/** Sweep period in sim seconds. */
export const SWEEP_PERIOD_S = 2;
/** Hit-test radius, CSS px. */
export const HIT_RADIUS_PX = 14;
/** Uncertainty gauge: full-scale radius, CSS px. */
export const GAUGE_RADIUS_PX = 40;
/** Default pitch: tilted enough to read as a globe, flat enough to read ranges. */
export const DEFAULT_PITCH = 0.55;

const TICKS_PER_SWEEP = SWEEP_PERIOD_S * TICK_HZ;
/** Scan pulse fades over this many ticks after a scan (half a 10 Hz scan interval). */
const PULSE_TICKS = 5;
const LATITUDES_DEG: readonly number[] = [-60, -30, 30, 60];
const MERIDIAN_STEP_DEG = 30;
const AZIMUTH_TICK_DEG = 30;
const RING_SEGMENTS = 96;
const MERIDIAN_SEGMENTS = 48;
const SWEEP_TRAIL_RAD = 0.7;
const SWEEP_TRAIL_SLICES = 14;
const DRAG_RAD_PER_PX = 0.008;
const BRACKET_HALF_PX = 9;
const SELECTED_HALF_PX = 12;
const DIAMOND_RADIUS_PX = 18;
/** Velocity leader length, sim seconds of relative motion. */
const LEADER_S = 10;
const ORIGIN = { x: 0, y: 0, z: 0 };

type Layer = OffscreenCanvas | HTMLCanvasElement;

interface DragState {
  pointerId: number;
  x: number;
  y: number;
}

/**
 * Layered globe view of the tracker picture around the platform.
 *
 * Construct with the visible canvas; call `resize()` whenever its parent's box
 * changes and `render()` once per frame. `hitTest()` maps a click in CSS
 * pixels to the nearest live track.
 */
export class GlobeRenderer implements IGlobeRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private layer: Layer | null = null;
  private layerCtx: Ctx2D | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private rotX = DEFAULT_PITCH;
  private rotY = 0;
  private lastSnapshot: Snapshot | null = null;
  private lastOpts: GlobeRenderOptions | null = null;
  private drag: DragState | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('GlobeRenderer: 2D canvas context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerEnd);
    canvas.addEventListener('pointercancel', this.onPointerEnd);
    this.resize();
  }

  /** Remove the pointer listeners; the canvas itself is left to its owner. */
  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerEnd);
    this.canvas.removeEventListener('pointercancel', this.onPointerEnd);
    this.drag = null;
  }

  /** Current view rotation, radians. */
  getRotation(): { rotX: number; rotY: number } {
    return { rotX: this.rotX, rotY: this.rotY };
  }

  /** Set the view rotation (pitch clamped, yaw wrapped) and repaint. */
  setRotation(rotX: number, rotY: number): void {
    const px = clampPitch(rotX);
    const py = wrapYaw(rotY);
    if (px === this.rotX && py === this.rotY) return;
    this.rotX = px;
    this.rotY = py;
    this.rotationChanged();
  }

  resize(): void {
    const size = fitCanvas(this.canvas, this.ctx);
    this.width = size.width;
    this.height = size.height;
    this.dpr = size.dpr;
    this.rebuildStatic();
    this.repaintLast();
  }

  render(snapshot: Snapshot, opts: GlobeRenderOptions): void {
    this.lastSnapshot = snapshot;
    this.lastOpts = opts;
    if (!this.layer) this.rebuildStatic();
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    if (this.layer) ctx.drawImage(this.layer, 0, 0, w, h);

    const view = this.view();
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    drawSweep(ctx, view, snapshot.tick);
    drawScanPulse(ctx, view, snapshot.radar.ticksSinceScan);
    if (opts.showTruth) drawTruth(ctx, view, snapshot.contacts);
    for (const track of snapshot.tracks) drawTrack(ctx, view, track, opts, snapshot.tick);
    drawBoresight(ctx, view, snapshot.truth.heading);
    drawGauge(ctx, h, snapshot.nav);
    ctx.globalAlpha = 1;
  }

  hitTest(x: number, y: number, snapshot: Snapshot): number | null {
    const view = this.view();
    const at = { x, y };
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const track of snapshot.tracks) {
      if (track.status === 'dropped') continue;
      const p = projectSpherical(clampRange(track.range), track.bearing, track.elevation, view);
      const d = screenDistance(p, at);
      if (d <= HIT_RADIUS_PX && d < bestDistance) {
        bestDistance = d;
        best = track.id;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // View and static layer
  // -------------------------------------------------------------------------

  private view(): View {
    // Leave room outside the horizon ring for the azimuth labels (drawn at 1.13 R).
    const radius = Math.max(10, (Math.min(this.width, this.height) / 2 - 8) / 1.16);
    return {
      rotX: this.rotX,
      rotY: this.rotY,
      cx: this.width / 2,
      cy: this.height / 2,
      scale: radius / SPHERE_RANGE_M,
    };
  }

  private rotationChanged(): void {
    this.rebuildStatic();
    this.repaintLast();
  }

  private repaintLast(): void {
    if (this.lastSnapshot && this.lastOpts) this.render(this.lastSnapshot, this.lastOpts);
  }

  private rebuildStatic(): void {
    const devW = Math.max(1, Math.round(this.width * this.dpr));
    const devH = Math.max(1, Math.round(this.height * this.dpr));
    if (!this.layer || !this.layerCtx || this.layer.width !== devW || this.layer.height !== devH) {
      const created = createLayer(devW, devH);
      this.layer = created.layer;
      this.layerCtx = created.ctx;
    }
    const ctx = this.layerCtx;
    const w = this.width;
    const h = this.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT_SMALL;
    ctx.textBaseline = 'middle';
    ctx.lineCap = 'butt';

    const view = this.view();
    drawWireframe(ctx, view);
    drawRangeRings(ctx, view);
    drawAzimuthTicks(ctx, view);

    // Corner readouts: what the picture is, and how it is turned.
    ctx.globalAlpha = 1;
    ctx.fillStyle = withAlpha(PALETTE.text, 0.55);
    ctx.textAlign = 'left';
    ctx.fillText(`PPI ${SPHERE_RANGE_M / 1000} km · rings ${(RANGE_RINGS_M[0] as number) / 1000} km`, 8, 10);
    ctx.textAlign = 'right';
    ctx.fillText(`PITCH ${Math.round(this.rotX * RAD)}° YAW ${Math.round(this.rotY * RAD)}°`, w - 8, 10);
    ctx.fillText('DRAG TO ROTATE', w - 8, h - 10);
  }

  // -------------------------------------------------------------------------
  // Drag to rotate
  // -------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.drag) return;
    this.drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience; dragging still works while the pointer stays over the canvas.
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (dx === 0 && dy === 0) return;
    // Dragging right turns the near side of the globe to the right; dragging
    // down brings the camera up toward top-down.
    this.rotY = wrapYaw(this.rotY + dx * DRAG_RAD_PER_PX);
    this.rotX = clampPitch(this.rotX - dy * DRAG_RAD_PER_PX);
    this.rotationChanged();
  };

  private readonly onPointerEnd = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Already released (e.g. pointercancel after the element was detached).
    }
  };
}

// ---------------------------------------------------------------------------
// Layer creation
// ---------------------------------------------------------------------------

function createLayer(devW: number, devH: number): { layer: Layer; ctx: Ctx2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(devW, devH);
    const ctx = off.getContext('2d');
    if (ctx) return { layer: off, ctx };
  }
  const el = document.createElement('canvas');
  el.width = devW;
  el.height = devH;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('GlobeRenderer: 2D context unavailable for the static layer');
  return { layer: el, ctx };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Keep far-out contacts on the rim rather than off the canvas. */
function clampRange(range: number): number {
  if (!Number.isFinite(range) || range < 0) return 0;
  return Math.min(range, SPHERE_RANGE_M * 1.02);
}

/** Points around a circle of constant elevation, `segments` per revolution. */
function ringPoints(range: number, elevation: number, view: View, segments: number): ScreenPoint[] {
  const pts: ScreenPoint[] = new Array<ScreenPoint>(segments);
  for (let i = 0; i < segments; i++) pts[i] = projectSpherical(range, (i / segments) * 2 * Math.PI, elevation, view);
  return pts;
}

/** Points along a half meridian from the nadir to the zenith at one bearing. */
function meridianPoints(bearing: number, view: View, segments: number): ScreenPoint[] {
  const pts: ScreenPoint[] = new Array<ScreenPoint>(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const elevation = -Math.PI / 2 + (i / segments) * Math.PI;
    pts[i] = projectSpherical(SPHERE_RANGE_M, bearing, elevation, view);
  }
  return pts;
}

/**
 * Stroke a polyline in two passes so segments on the far side of the sphere
 * (negative depth) draw fainter than the near side.
 */
function strokePolyline(
  ctx: Ctx2D,
  pts: ScreenPoint[],
  closed: boolean,
  color: string,
  frontAlpha: number,
  backAlpha: number,
  lineWidth: number,
): void {
  const count = closed ? pts.length : pts.length - 1;
  if (count < 1) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  for (const front of [true, false]) {
    ctx.globalAlpha = front ? frontAlpha : backAlpha;
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < count; i++) {
      const a = pts[i] as ScreenPoint;
      const b = pts[(i + 1) % pts.length] as ScreenPoint;
      const isFront = a.depth + b.depth >= 0;
      if (isFront !== front) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      any = true;
    }
    if (any) ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function depthAlpha(depth: number, front: number, back: number): number {
  return depth >= 0 ? front : back;
}

// ---------------------------------------------------------------------------
// Static layer
// ---------------------------------------------------------------------------

function drawWireframe(ctx: Ctx2D, view: View): void {
  // Latitude rings sit on the sphere at their elevation; the equator is the 60 km range ring.
  for (const latDeg of LATITUDES_DEG) {
    strokePolyline(ctx, ringPoints(SPHERE_RANGE_M, latDeg * DEG, view, RING_SEGMENTS), true, PALETTE.grid, 0.5, 0.18, 0.8);
  }
  for (let deg = 0; deg < 360; deg += MERIDIAN_STEP_DEG) {
    strokePolyline(ctx, meridianPoints(deg * DEG, view, MERIDIAN_SEGMENTS), false, PALETTE.grid, 0.5, 0.18, 0.8);
  }
}

function drawRangeRings(ctx: Ctx2D, view: View): void {
  ctx.textAlign = 'left';
  for (const range of RANGE_RINGS_M) {
    const outer = range === SPHERE_RANGE_M;
    strokePolyline(ctx, ringPoints(range, 0, view, RING_SEGMENTS), true, PALETTE.grid, outer ? 1 : 0.85, outer ? 0.45 : 0.3, outer ? 1.3 : 0.9);
    // Label on the south-east of each ring, where the tilt keeps it near the viewer.
    const p = projectSpherical(range, (3 * Math.PI) / 4, 0, view);
    ctx.globalAlpha = depthAlpha(p.depth, 0.9, 0.4);
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(`${range / 1000} km`, p.x + 4, p.y - 4);
  }
  ctx.globalAlpha = 1;
}

const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

function drawAzimuthTicks(ctx: Ctx2D, view: View): void {
  ctx.textAlign = 'center';
  ctx.strokeStyle = PALETTE.grid;
  for (let deg = 0; deg < 360; deg += AZIMUTH_TICK_DEG) {
    const bearing = deg * DEG;
    const cardinal = CARDINALS[deg];
    const inner = projectSpherical(SPHERE_RANGE_M, bearing, 0, view);
    const outer = projectSpherical(SPHERE_RANGE_M * (cardinal ? 1.07 : 1.04), bearing, 0, view);
    const label = projectSpherical(SPHERE_RANGE_M * 1.13, bearing, 0, view);
    ctx.globalAlpha = depthAlpha(inner.depth, 1, 0.45);
    ctx.lineWidth = cardinal ? 1.4 : 0.9;
    ctx.beginPath();
    ctx.moveTo(inner.x, inner.y);
    ctx.lineTo(outer.x, outer.y);
    ctx.stroke();
    ctx.fillStyle = cardinal ? PALETTE.text : withAlpha(PALETTE.text, 0.6);
    ctx.fillText(cardinal ?? deg.toString().padStart(3, '0'), label.x, label.y);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Dynamic layer
// ---------------------------------------------------------------------------

function drawSweep(ctx: CanvasRenderingContext2D, view: View, tick: number): void {
  const phase = (((tick % TICKS_PER_SWEEP) + TICKS_PER_SWEEP) % TICKS_PER_SWEEP) / TICKS_PER_SWEEP;
  const angle = phase * 2 * Math.PI;
  const centre = projectPoint(ORIGIN, view);
  const step = SWEEP_TRAIL_RAD / SWEEP_TRAIL_SLICES;
  let lead = projectSpherical(SPHERE_RANGE_M, angle, 0, view);
  for (let i = 0; i < SWEEP_TRAIL_SLICES; i++) {
    const trail = projectSpherical(SPHERE_RANGE_M, angle - (i + 1) * step, 0, view);
    ctx.fillStyle = withAlpha(PALETTE.sweep, 0.26 * (1 - i / SWEEP_TRAIL_SLICES));
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y);
    ctx.lineTo(lead.x, lead.y);
    ctx.lineTo(trail.x, trail.y);
    ctx.closePath();
    ctx.fill();
    lead = trail;
  }
  const tip = projectSpherical(SPHERE_RANGE_M, angle, 0, view);
  ctx.strokeStyle = PALETTE.sweep;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(centre.x, centre.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawScanPulse(ctx: CanvasRenderingContext2D, view: View, ticksSinceScan: number): void {
  if (!(ticksSinceScan >= 0 && ticksSinceScan < PULSE_TICKS)) return;
  const t = ticksSinceScan / PULSE_TICKS;
  const fade = 1 - t;
  // Flash the horizon ring on the scan tick, then send a ripple outward.
  strokePolyline(ctx, ringPoints(SPHERE_RANGE_M, 0, view, RING_SEGMENTS), true, PALETTE.sweep, 0.75 * fade, 0.35 * fade, 1.6);
  strokePolyline(ctx, ringPoints(SPHERE_RANGE_M * (0.08 + 0.92 * t), 0, view, 72), true, PALETTE.sweep, 0.55 * fade, 0.25 * fade, 1);
}

function drawTruth(ctx: CanvasRenderingContext2D, view: View, contacts: ContactSnapshot[]): void {
  ctx.fillStyle = withAlpha(PALETTE.truth, 0.5);
  for (const c of contacts) {
    if (!c.alive) continue;
    const p = projectSpherical(clampRange(c.range), c.bearing, c.elevation, view);
    const r = c.kind === 'decoy' ? 1.5 : 2.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function dashFor(status: TrackStatus): number[] {
  switch (status) {
    case 'tentative':
      return [3, 2];
    case 'coasting':
      return [1, 2.5];
    default:
      return [];
  }
}

function drawBracket(ctx: CanvasRenderingContext2D, x: number, y: number, half: number): void {
  const arm = half * 0.55;
  ctx.beginPath();
  ctx.moveTo(x - half, y - half + arm);
  ctx.lineTo(x - half, y - half);
  ctx.lineTo(x - half + arm, y - half);
  ctx.moveTo(x + half - arm, y - half);
  ctx.lineTo(x + half, y - half);
  ctx.lineTo(x + half, y - half + arm);
  ctx.moveTo(x + half, y + half - arm);
  ctx.lineTo(x + half, y + half);
  ctx.lineTo(x + half - arm, y + half);
  ctx.moveTo(x - half + arm, y + half);
  ctx.lineTo(x - half, y + half);
  ctx.lineTo(x - half, y + half - arm);
  ctx.stroke();
}

function drawTrack(ctx: CanvasRenderingContext2D, view: View, track: TrackSnapshot, opts: GlobeRenderOptions, tick: number): void {
  const world = sphericalToPoint(clampRange(track.range), track.bearing, track.elevation);
  const p = projectPoint(world, view);
  const color = labelColor(track.label);
  const selected = opts.selectedTrackId === track.id;
  let alpha = 1;
  if (track.status === 'dropped') alpha = 0.35;
  else if (track.status === 'tentative') alpha = 0.6;
  if (opts.labelFilter !== 'all' && track.label !== opts.labelFilter) alpha *= 0.3;
  const half = selected ? SELECTED_HALF_PX : BRACKET_HALF_PX;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = selected ? 1.6 : 1.2;
  ctx.setLineDash(dashFor(track.status));
  drawBracket(ctx, p.x, p.y, half);
  ctx.setLineDash([]);

  if (track.status !== 'dropped' && track.speed > 1) {
    const tip = projectPoint({ x: world.x + track.vel[0] * LEADER_S, y: world.y + track.vel[1] * LEADER_S, z: world.z }, view);
    ctx.globalAlpha = alpha * 0.8;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`T${track.id}`, p.x + half + 4, p.y - half + 2);
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(`${(track.range / 1000).toFixed(1)} km`, p.x + half + 4, p.y + half - 2);

  if (selected) {
    // One revolution per sim second, phase-locked to the tick so replays match.
    const rot = (((tick % TICK_HZ) + TICK_HZ) % TICK_HZ) / TICK_HZ * 2 * Math.PI;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = rot + (k * Math.PI) / 2;
      const x = p.x + DIAMOND_RADIUS_PX * Math.cos(a);
      const y = p.y + DIAMOND_RADIUS_PX * Math.sin(a);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function drawBoresight(ctx: CanvasRenderingContext2D, view: View, heading: number): void {
  const c = projectPoint(ORIGIN, view);
  ctx.strokeStyle = PALETTE.sweep;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 5, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    ctx.moveTo(c.x + dx * 8, c.y + dy * 8);
    ctx.lineTo(c.x + dx * 14, c.y + dy * 14);
  }
  ctx.stroke();
  // Platform heading, drawn in the ground plane so it turns with the view.
  if (Number.isFinite(heading)) {
    const tip = projectSpherical(SPHERE_RANGE_M * 0.1, heading, 0, view);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawGauge(ctx: CanvasRenderingContext2D, height: number, nav: NavEstimate): void {
  const sigma = Number.isFinite(nav.posSigma) && nav.posSigma > 0 ? nav.posSigma : 0;
  const radius = Math.min(1, Math.max(0.05, sigma / 100)) * GAUGE_RADIUS_PX;
  const gx = GAUGE_RADIUS_PX + 18;
  const gy = height - GAUGE_RADIUS_PX - 26;
  ctx.strokeStyle = PALETTE.grid;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(gx, gy, GAUGE_RADIUS_PX, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = withAlpha(PALETTE.sweep, 0.18);
  ctx.strokeStyle = PALETTE.sweep;
  ctx.beginPath();
  ctx.arc(gx, gy, radius, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PALETTE.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`σ ${Math.round(sigma)} m`, gx, gy + GAUGE_RADIUS_PX + 12);
  ctx.font = FONT_SMALL;
  ctx.fillStyle = withAlpha(PALETTE.text, 0.55);
  ctx.fillText('NAV', gx, gy - GAUGE_RADIUS_PX - 10);
  ctx.font = FONT;
}
