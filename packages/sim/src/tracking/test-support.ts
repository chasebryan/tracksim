/**
 * Fixtures shared by the tracking tests: a minimal stand-in for the world
 * module (a straight-flying platform plus contacts with the contract's
 * random-walk jitter) advanced one radar scan at a time, and hand-built
 * detections. Not exported from the package.
 */
import type { WorldContact } from '../core/interfaces';
import type { Rng } from '../core/rng';
import type { ContactSpec, Detection, PlatformTruth, Vec2 } from '../core/types';
import type { Radar } from './radar';
import type { Tracker } from './tracker';

export const TICKS_PER_SCAN = 10;
export const DT_SCAN = 0.1;

/** A contact spec with sensible defaults; `pos`/`vel` are absolute (world) frame. */
export function contactSpec(over: Partial<ContactSpec> & { id: number }): ContactSpec {
  return {
    kind: 'vehicle',
    label: 'unknown',
    declared: false,
    pos: [0, 10_000],
    vel: [0, 0],
    elevationDeg: 0,
    jitter: 0,
    ...over,
  };
}

/** A hand-built detection with an isotropic 30 m covariance unless overridden. */
export function detection(pos: Vec2, over: Partial<Detection> = {}): Detection {
  return { pos, cov: [900, 0, 0, 900], elevation: 0, contactId: null, declaredLabel: null, ...over };
}

/** Straight-line platform plus contacts stepped per scan with the world module's jitter model. */
export class TestWorld {
  readonly platform: PlatformTruth;
  readonly contacts: WorldContact[];
  time = 0;

  constructor(specs: ContactSpec[], private readonly rng: Rng, platform: { pos: Vec2; vel: Vec2 } = { pos: [0, 0], vel: [0, 100] }) {
    const [vE, vN] = platform.vel;
    this.platform = {
      pos: [platform.pos[0], platform.pos[1]],
      vel: [vE, vN],
      heading: Math.atan2(vE, vN),
      speed: Math.hypot(vE, vN),
      alt: 3000,
      turnRate: 0,
      accel: 0,
    };
    this.contacts = specs.map((spec) => ({
      spec,
      pos: [spec.pos[0], spec.pos[1]],
      vel: [spec.vel[0], spec.vel[1]],
      alive: isAlive(spec, 0),
    }));
  }

  /** Advance by `dt` seconds: platform straight and level, contacts with `pos += vel·dt + jitter·√dt·N(0,1)`. */
  advance(dt: number): void {
    this.time += dt;
    this.platform.pos[0] += this.platform.vel[0] * dt;
    this.platform.pos[1] += this.platform.vel[1] * dt;
    const sq = Math.sqrt(dt);
    for (const c of this.contacts) {
      c.alive = isAlive(c.spec, this.time);
      if (!c.alive) continue;
      c.pos[0] += c.vel[0] * dt + c.spec.jitter * sq * this.rng.normal();
      c.pos[1] += c.vel[1] * dt + c.spec.jitter * sq * this.rng.normal();
    }
  }

  contact(id: number): WorldContact {
    const c = this.contacts.find((x) => x.spec.id === id);
    if (!c) throw new Error(`no contact ${id}`);
    return c;
  }

  /** Contact position relative to the platform (what the tracker estimates). */
  relPos(id: number): Vec2 {
    const c = this.contact(id);
    return [c.pos[0] - this.platform.pos[0], c.pos[1] - this.platform.pos[1]];
  }

  /** Contact velocity relative to the platform. */
  relVel(id: number): Vec2 {
    const c = this.contact(id);
    return [c.vel[0] - this.platform.vel[0], c.vel[1] - this.platform.vel[1]];
  }
}

function isAlive(spec: ContactSpec, time: number): boolean {
  return (spec.spawnAt ?? 0) <= time && time < (spec.despawnAt ?? Infinity);
}

/**
 * Run `scans` radar scans through the tracker, advancing the world by one
 * scan interval before each. Scan s happens on tick s·TICKS_PER_SCAN.
 */
export function runScans(
  scans: number,
  world: TestWorld,
  radar: Radar,
  tracker: Tracker,
  onScan?: (scan: number, tick: number, detections: Detection[]) => void,
  firstScan = 1,
): void {
  for (let s = firstScan; s < firstScan + scans; s++) {
    const tick = s * TICKS_PER_SCAN;
    world.advance(DT_SCAN);
    const detections = radar.scan(tick, world.platform, world.contacts);
    tracker.update(tick, detections, DT_SCAN);
    onScan?.(s, tick, detections);
  }
}
