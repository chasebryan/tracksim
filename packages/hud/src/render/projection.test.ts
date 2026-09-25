import { describe, expect, it } from 'vitest';
import {
  MAX_PITCH,
  clampPitch,
  projectPoint,
  projectSpherical,
  rotatePoint,
  screenDistance,
  sphericalToPoint,
  wrapYaw,
  type Point3,
  type View,
} from './projection';

// Tolerances: inputs are O(1e4) metres, so sin/cos rounding (a few ulp of 1)
// propagates to ~1e-11 m. 1e-6 absolute leaves four orders of headroom while
// still catching any sign or axis mix-up, which would be O(range).
const TOL = 1e-6;

const HALF_PI = Math.PI / 2;

function expectPoint(p: Point3, x: number, y: number, z: number): void {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
  expect(p.z).toBeCloseTo(z, 6);
}

function norm(p: Point3): number {
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}

const topDown: View = { rotX: 0, rotY: 0, cx: 200, cy: 150, scale: 0.01 };

describe('sphericalToPoint', () => {
  it('maps the cardinal bearings onto the east/north axes', () => {
    expectPoint(sphericalToPoint(1000, 0, 0), 0, 1000, 0);
    expectPoint(sphericalToPoint(1000, HALF_PI, 0), 1000, 0, 0);
    expectPoint(sphericalToPoint(1000, Math.PI, 0), 0, -1000, 0);
    expectPoint(sphericalToPoint(1000, -HALF_PI, 0), -1000, 0, 0);
  });

  it('puts elevation on the up axis', () => {
    expectPoint(sphericalToPoint(500, 0, HALF_PI), 0, 0, 500);
    const p = sphericalToPoint(1000, 0, Math.PI / 6);
    expect(p.z).toBeCloseTo(500, 6);
    expect(p.y).toBeCloseTo(1000 * Math.cos(Math.PI / 6), 6);
  });

  it('preserves range as the vector length for a grid of angles', () => {
    for (let b = -3; b <= 3; b += 0.7)
      for (let e = -1.5; e <= 1.5; e += 0.5) expect(Math.abs(norm(sphericalToPoint(12345, b, e)) - 12345)).toBeLessThan(TOL);
  });
});

describe('rotatePoint', () => {
  const east: Point3 = { x: 1, y: 0, z: 0 };
  const north: Point3 = { x: 0, y: 1, z: 0 };
  const up: Point3 = { x: 0, y: 0, z: 1 };

  it('is the identity with no rotation', () => {
    expectPoint(rotatePoint({ x: 3, y: -4, z: 5 }, 0, 0), 3, -4, 5);
  });

  it('yaw turns the compass anticlockwise about the up axis', () => {
    expectPoint(rotatePoint(east, 0, HALF_PI), 0, 1, 0);
    expectPoint(rotatePoint(north, 0, HALF_PI), -1, 0, 0);
    expectPoint(rotatePoint(up, 0, HALF_PI), 0, 0, 1);
  });

  it('positive pitch tilts north away from the viewer and lifts the zenith', () => {
    const n = rotatePoint(north, 0.6, 0);
    expect(n.y).toBeCloseTo(Math.cos(0.6), 9);
    expect(n.z).toBeCloseTo(-Math.sin(0.6), 9);
    const z = rotatePoint(up, 0.6, 0);
    expect(z.y).toBeCloseTo(Math.sin(0.6), 9);
    expect(z.z).toBeCloseTo(Math.cos(0.6), 9);
    expectPoint(rotatePoint(north, HALF_PI, 0), 0, 0, -1);
    expectPoint(rotatePoint(up, HALF_PI, 0), 0, 1, 0);
  });

  it('is a rigid rotation: lengths are preserved for arbitrary angles', () => {
    const p: Point3 = { x: 1200, y: -340, z: 87 };
    const len = norm(p);
    for (const rx of [-1.1, -0.3, 0, 0.45, 1.1])
      for (const ry of [-3, -1, 0, 0.5, 2.9]) expect(Math.abs(norm(rotatePoint(p, rx, ry)) - len)).toBeLessThan(TOL);
  });

  it('yaw is applied before pitch', () => {
    // Yawing east onto north, then pitching by 90°, must send it away from the viewer.
    expectPoint(rotatePoint(east, HALF_PI, HALF_PI), 0, 0, -1);
  });
});

describe('projectPoint / projectSpherical', () => {
  it('top-down view puts north up and east right about the centre', () => {
    const n = projectSpherical(10_000, 0, 0, topDown);
    expect(n.x).toBeCloseTo(200, 6);
    expect(n.y).toBeCloseTo(50, 6);
    const e = projectSpherical(10_000, HALF_PI, 0, topDown);
    expect(e.x).toBeCloseTo(300, 6);
    expect(e.y).toBeCloseTo(150, 6);
    const s = projectSpherical(10_000, Math.PI, 0, topDown);
    expect(s.y).toBeCloseTo(250, 6);
  });

  it('the origin always projects to the centre', () => {
    for (const rx of [-1.1, 0, 0.7])
      for (const ry of [-2, 0, 1.3]) {
        const p = projectPoint({ x: 0, y: 0, z: 0 }, { ...topDown, rotX: rx, rotY: ry });
        expect(p.x).toBeCloseTo(topDown.cx, 9);
        expect(p.y).toBeCloseTo(topDown.cy, 9);
      }
  });

  it('depth is positive toward the viewer: the zenith faces us top-down, north recedes when pitched', () => {
    expect(projectSpherical(1, 0, HALF_PI, topDown).depth).toBeCloseTo(1, 9);
    expect(projectSpherical(1, 0, 0, topDown).depth).toBeCloseTo(0, 9);
    const pitched: View = { ...topDown, rotX: 0.8 };
    const n = projectSpherical(1000, 0, 0, pitched);
    expect(n.depth).toBeCloseTo(-1000 * Math.sin(0.8), 6);
    // and its screen height is foreshortened by cos(pitch)
    expect(topDown.cy - n.y).toBeCloseTo(1000 * Math.cos(0.8) * topDown.scale, 6);
    const s = projectSpherical(1000, Math.PI, 0, pitched);
    expect(s.depth).toBeGreaterThan(0);
  });

  it('projectSpherical equals projectPoint(sphericalToPoint())', () => {
    const view: View = { rotX: -0.4, rotY: 2.2, cx: 33, cy: 44, scale: 0.002 };
    const a = projectSpherical(42_000, 1.1, 0.05, view);
    const b = projectPoint(sphericalToPoint(42_000, 1.1, 0.05), view);
    expect(a).toEqual(b);
  });
});

describe('clampPitch / wrapYaw / screenDistance', () => {
  it('clamps pitch to ±MAX_PITCH', () => {
    expect(MAX_PITCH).toBe(1.1);
    expect(clampPitch(5)).toBe(MAX_PITCH);
    expect(clampPitch(-5)).toBe(-MAX_PITCH);
    expect(clampPitch(0.3)).toBe(0.3);
  });

  it('wraps yaw into (-π, π]', () => {
    expect(wrapYaw(0)).toBe(0);
    expect(wrapYaw(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapYaw(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapYaw(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapYaw(2 * Math.PI + 0.5)).toBeCloseTo(0.5, 12);
    expect(wrapYaw(-2 * Math.PI - 0.5)).toBeCloseTo(-0.5, 12);
  });

  it('measures Euclidean screen distance', () => {
    expect(screenDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(screenDistance({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
  });
});
