/**
 * Pure projection maths for the globe view. No DOM, no imports — this file is
 * unit-tested in Node.
 *
 * Frames:
 *  - World: [east, north, up] metres with the platform at the origin. Bearing
 *    is radians clockwise from north; elevation is radians above the
 *    horizontal plane (the sim's conventions).
 *  - View: x = screen right, y = screen up, z = toward the viewer. The world is
 *    first yawed about its up axis by `rotY`, then pitched about the screen
 *    x-axis by `rotX`. With rotX = rotY = 0 the view is top-down with north
 *    up. Positive rotX tilts the north edge away from the viewer and lifts the
 *    zenith above the centre; positive rotY turns the compass anticlockwise.
 *  - Screen: canvas CSS pixels, y down, origin top-left.
 *
 * The projection is orthographic: a point's screen position is its view x/y
 * scaled about the canvas centre, and `depth` (view z) tells the caller
 * whether it sits on the near (> 0) or far (< 0) side of the sphere.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** View-space z; positive faces the viewer. */
  depth: number;
}

/** Camera parameters shared by every projection in one frame. */
export interface View {
  /** Pitch, radians; 0 = top-down. Clamped to ±MAX_PITCH by the renderer. */
  rotX: number;
  /** Yaw, radians. */
  rotY: number;
  /** Screen centre, CSS px. */
  cx: number;
  cy: number;
  /** Screen pixels per world unit (metre). */
  scale: number;
}

/** Pitch limit: keeps the globe from flipping over while dragging. */
export const MAX_PITCH = 1.1;

export function clampPitch(rotX: number): number {
  return Math.min(MAX_PITCH, Math.max(-MAX_PITCH, rotX));
}

/** Wrap an angle to (-π, π]. */
export function wrapYaw(rotY: number): number {
  let a = rotY % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  else if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/** Range/bearing/elevation from the platform → world point [east, north, up]. */
export function sphericalToPoint(range: number, bearing: number, elevation: number): Point3 {
  const horizontal = range * Math.cos(elevation);
  return {
    x: horizontal * Math.sin(bearing),
    y: horizontal * Math.cos(bearing),
    z: range * Math.sin(elevation),
  };
}

/** Apply the view rotation (yaw about up, then pitch about screen x) to a world point. */
export function rotatePoint(p: Point3, rotX: number, rotY: number): Point3 {
  const cy = Math.cos(rotY);
  const sy = Math.sin(rotY);
  const x1 = p.x * cy - p.y * sy;
  const y1 = p.x * sy + p.y * cy;
  const z1 = p.z;
  const cx = Math.cos(rotX);
  const sx = Math.sin(rotX);
  return {
    x: x1,
    y: y1 * cx + z1 * sx,
    z: -y1 * sx + z1 * cx,
  };
}

/** Rotate a world point by the view and place it on screen. */
export function projectPoint(p: Point3, view: View): ScreenPoint {
  const r = rotatePoint(p, view.rotX, view.rotY);
  return {
    x: view.cx + r.x * view.scale,
    y: view.cy - r.y * view.scale,
    depth: r.z,
  };
}

/** Range/bearing/elevation → screen, in one call. */
export function projectSpherical(range: number, bearing: number, elevation: number, view: View): ScreenPoint {
  return projectPoint(sphericalToPoint(range, bearing, elevation), view);
}

/** Euclidean distance between two screen points (CSS px). */
export function screenDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
