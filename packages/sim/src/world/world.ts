/**
 * World: ground-truth platform kinematics and scenario contacts.
 *
 * The platform flies a heading/speed model driven by a commanded turn rate and
 * an along-track acceleration; contacts fly constant velocity plus an optional
 * per-axis random-walk jitter. `step()` advances everything by one tick; every
 * random draw comes from the injected `Rng` (`Rng.fromLabel(seed, 'world')`)
 * in a fixed order (contacts in insertion order, east then north), so a run is
 * reproducible from its seed.
 *
 * Conventions follow core/types: positions are [east, north] metres, heading
 * and bearing are radians clockwise from north.
 */
import type { IWorld, WorldContact } from '../core/interfaces';
import type { Rng } from '../core/rng';
import type {
  ContactSnapshot,
  ContactSpec,
  EventLevel,
  PlatformTruth,
  Scenario,
  SimEvent,
  Vec2,
} from '../core/types';
import { DEG, DT, RAD, secondsToTick, wrapAngle } from '../core/constants';

/** First decoy id; each decoy spawned by `spawnDecoys` takes the next id. */
export const DECOY_ID_BASE = 9000;
/** Decoy position random-walk sigma, m/√s. */
export const DECOY_JITTER = 60;
/** Decoy per-scan detection probability. */
export const DECOY_PD = 0.65;
/** Decoys spawn on a ring this far from their reference, metres. */
export const DECOY_RING_MIN_M = 300;
export const DECOY_RING_MAX_M = 800;
/** Per-axis velocity noise added to the reference velocity, m/s. */
export const DECOY_VEL_SIGMA = 15;
/** Decoys despawn this long after spawning, seconds. */
export const DECOY_LIFETIME_MIN_S = 20;
export const DECOY_LIFETIME_MAX_S = 40;

const SQRT_DT = Math.sqrt(DT);
const TWO_PI = 2 * Math.PI;

/** Internal contact record: the public `WorldContact` plus its lifetime in ticks. */
interface ContactState extends WorldContact {
  spawnTick: number;
  despawnTick: number;
}

/**
 * Platform truth and contact ground truth for one simulation run.
 *
 * Construct with the scenario and a world-labelled `Rng`; the initial platform
 * state is derived from `scenario.platform` (heading = atan2(vE, vN),
 * speed = |vel|) and every `scenario.contacts` entry is registered with its
 * spawn window.
 */
export class World implements IWorld {
  private _platform: PlatformTruth;
  private readonly _contacts: ContactState[] = [];
  private readonly rng: Rng;
  private turnUntilTick = Infinity;
  private accelUntilTick = Infinity;
  private decoyCounter = 0;
  private events: SimEvent[] = [];

  constructor(scenario: Scenario, rng: Rng) {
    this.rng = rng;
    const [pE, pN] = scenario.platform.pos;
    const [vE, vN] = scenario.platform.vel;
    this._platform = {
      pos: [pE, pN],
      vel: [vE, vN],
      heading: Math.atan2(vE, vN),
      speed: Math.sqrt(vE * vE + vN * vN),
      alt: scenario.platform.alt,
      turnRate: 0,
      accel: 0,
    };
    for (const spec of scenario.contacts) this.register(spec, 0);
  }

  /**
   * Platform truth for the most recent tick. A fresh object is produced by
   * every `step()` (and by `setTurn`/`setAccel`), so a reference taken for a
   * snapshot is never mutated afterwards.
   */
  get platform(): PlatformTruth {
    return this._platform;
  }

  /**
   * Every contact registered so far, alive or not, in registration order.
   * These are live working records: `pos`/`vel` are updated in place each
   * tick. Use `contactSnapshots()` for data to retain or send elsewhere.
   */
  get contacts(): readonly WorldContact[] {
    return this._contacts;
  }

  /** Advance the platform and every alive contact to `tick`. */
  step(tick: number): void {
    this.stepPlatform(tick);
    this.stepContacts(tick);
  }

  /** Command a turn rate (rad/s, clockwise positive) applied on every step with `tick < untilTick`. */
  setTurn(rateRadS: number, untilTick: number): void {
    this.turnUntilTick = untilTick;
    this._platform = { ...this._platform, turnRate: rateRadS };
  }

  /** Command an along-track acceleration (m/s²) applied on every step with `tick < untilTick`. */
  setAccel(mps2: number, untilTick: number): void {
    this.accelUntilTick = untilTick;
    this._platform = { ...this._platform, accel: mps2 };
  }

  /**
   * Register a contact at `tick`. `spawnAt`/`despawnAt` are absolute scenario
   * seconds; a contact can never be alive before the tick it was registered on.
   */
  spawn(spec: ContactSpec, tick: number): void {
    const c = this.register(spec, tick);
    if (c.alive) this.emit(tick, 'info', `${this.describe(c)} spawned ${this.whereIs(c)}`);
  }

  /** Remove the alive contact with this id from play now. No-op if none is alive. */
  despawn(id: number, tick: number): void {
    const c = this.findAlive(id);
    if (!c) return;
    c.despawnTick = Math.min(c.despawnTick, tick);
    c.alive = false;
    this.emit(tick, 'info', `${this.describe(c)} despawned`);
  }

  /**
   * Spawn `count` decoys on a 300–800 m ring around a reference: the alive
   * contact `nearContactId`, else the first alive non-decoy contact, else the
   * platform. Each decoy inherits the reference velocity plus N(0, 15 m/s) per
   * axis and despawns 20–40 s later. Returns the new ids (9000 upwards).
   */
  spawnDecoys(count: number, tick: number, nearContactId?: number): number[] {
    const ids: number[] = [];
    const n = Math.floor(count);
    if (!(n > 0)) return ids;

    let ref: ContactState | undefined;
    if (nearContactId !== undefined) ref = this.findAlive(nearContactId);
    if (!ref) ref = this._contacts.find((c) => c.alive && c.spec.kind !== 'decoy');
    const refPos: Vec2 = ref ? ref.pos : this._platform.pos;
    const refVel: Vec2 = ref ? ref.vel : this._platform.vel;
    const refElevationDeg = ref ? ref.spec.elevationDeg : 0;
    const time = tick * DT;

    for (let i = 0; i < n; i++) {
      const id = DECOY_ID_BASE + this.decoyCounter++;
      const theta = this.rng.uniform(0, TWO_PI);
      const radius = this.rng.uniform(DECOY_RING_MIN_M, DECOY_RING_MAX_M);
      const spec: ContactSpec = {
        id,
        kind: 'decoy',
        label: 'decoy',
        declared: false,
        pos: [refPos[0] + radius * Math.sin(theta), refPos[1] + radius * Math.cos(theta)],
        vel: [
          refVel[0] + this.rng.gaussian(0, DECOY_VEL_SIGMA),
          refVel[1] + this.rng.gaussian(0, DECOY_VEL_SIGMA),
        ],
        elevationDeg: refElevationDeg,
        jitter: DECOY_JITTER,
        pd: DECOY_PD,
        spawnAt: time,
        despawnAt: time + this.rng.uniform(DECOY_LIFETIME_MIN_S, DECOY_LIFETIME_MAX_S),
      };
      this.register(spec, tick);
      ids.push(id);
    }

    const near = ref ? `contact ${ref.spec.id}` : 'platform';
    const first = ids[0] as number;
    const last = ids[ids.length - 1] as number;
    const range = n === 1 ? `id ${first}` : `ids ${first}-${last}`;
    this.emit(tick, 'info', `spawned ${n} decoy${n === 1 ? '' : 's'} near ${near} (${range})`);
    return ids;
  }

  /** Every contact (alive or not) expressed relative to the platform, world-aligned. */
  contactSnapshots(): ContactSnapshot[] {
    const p = this._platform;
    return this._contacts.map((c) => {
      const relE = c.pos[0] - p.pos[0];
      const relN = c.pos[1] - p.pos[1];
      return {
        id: c.spec.id,
        kind: c.spec.kind,
        label: c.spec.label,
        pos: [relE, relN],
        vel: [c.vel[0] - p.vel[0], c.vel[1] - p.vel[1]],
        range: Math.sqrt(relE * relE + relN * relN),
        bearing: Math.atan2(relE, relN),
        elevation: c.spec.elevationDeg * DEG,
        alive: c.alive,
      };
    });
  }

  /** Events produced since the previous drain; clears the buffer. */
  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // -------------------------------------------------------------------------

  private stepPlatform(tick: number): void {
    const p = this._platform;
    let turnRate = p.turnRate;
    let accel = p.accel;
    if (tick >= this.turnUntilTick) {
      turnRate = 0;
      this.turnUntilTick = Infinity;
    }
    if (tick >= this.accelUntilTick) {
      accel = 0;
      this.accelUntilTick = Infinity;
    }
    const heading = wrapAngle(p.heading + turnRate * DT);
    const speed = Math.max(0, p.speed + accel * DT);
    const vE = speed * Math.sin(heading);
    const vN = speed * Math.cos(heading);
    this._platform = {
      pos: [p.pos[0] + vE * DT, p.pos[1] + vN * DT],
      vel: [vE, vN],
      heading,
      speed,
      alt: p.alt,
      turnRate,
      accel,
    };
  }

  private stepContacts(tick: number): void {
    for (const c of this._contacts) {
      const alive = c.spawnTick <= tick && tick < c.despawnTick;
      if (alive !== c.alive) {
        c.alive = alive;
        this.emit(
          tick,
          'info',
          alive ? `${this.describe(c)} spawned ${this.whereIs(c)}` : `${this.describe(c)} despawned`,
        );
      }
      if (!alive) continue;
      const jitter = c.spec.jitter;
      if (jitter > 0) {
        const s = jitter * SQRT_DT;
        c.pos[0] += c.vel[0] * DT + s * this.rng.normal();
        c.pos[1] += c.vel[1] * DT + s * this.rng.normal();
      } else {
        c.pos[0] += c.vel[0] * DT;
        c.pos[1] += c.vel[1] * DT;
      }
    }
  }

  private register(spec: ContactSpec, tick: number): ContactState {
    const spawnTick = Math.max(tick, secondsToTick(spec.spawnAt ?? 0));
    const despawnTick = spec.despawnAt === undefined ? Infinity : secondsToTick(spec.despawnAt);
    const c: ContactState = {
      spec: { ...spec, pos: [spec.pos[0], spec.pos[1]], vel: [spec.vel[0], spec.vel[1]] },
      pos: [spec.pos[0], spec.pos[1]],
      vel: [spec.vel[0], spec.vel[1]],
      alive: spawnTick <= tick && tick < despawnTick,
      spawnTick,
      despawnTick,
    };
    this._contacts.push(c);
    return c;
  }

  private findAlive(id: number): ContactState | undefined {
    return this._contacts.find((c) => c.alive && c.spec.id === id);
  }

  private describe(c: ContactState): string {
    return `contact ${c.spec.id} (${c.spec.kind})`;
  }

  private whereIs(c: ContactState): string {
    const relE = c.pos[0] - this._platform.pos[0];
    const relN = c.pos[1] - this._platform.pos[1];
    const rangeKm = (Math.sqrt(relE * relE + relN * relN) / 1000).toFixed(1);
    const bearingDeg = (((Math.atan2(relE, relN) * RAD) % 360) + 360) % 360;
    return `at ${rangeKm} km brg ${bearingDeg.toFixed(0).padStart(3, '0')}°`;
  }

  private emit(tick: number, level: EventLevel, message: string): void {
    this.events.push({ tick, time: tick * DT, source: 'scenario', level, message });
  }
}
