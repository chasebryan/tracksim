/**
 * Simulated surveillance radar. On each scan tick it reports every alive
 * contact within range with probability pd as a range/bearing measurement
 * (noise σ_range, σ_bearing) expressed as a world-aligned relative position
 * with the matching rotated covariance, then adds Poisson clutter uniformly
 * over the coverage disc.
 *
 * Determinism: all randomness comes from the injected Rng; draws happen in a
 * fixed order (contacts in array order — pd test, range, bearing, elevation —
 * then the clutter count and, per clutter point, range, bearing, elevation).
 */
import { DEG, DT, TICK_HZ } from '../core/constants';
import type { IRadar, WorldContact } from '../core/interfaces';
import type { Rng } from '../core/rng';
import type {
  ContactKind,
  Detection,
  GateSetting,
  PlatformTruth,
  RadarStatus,
  SimEvent,
  TrackLabel,
} from '../core/types';

export interface RadarConfig {
  /** Scans per second; must divide TICK_HZ. */
  scanHz: number;
  /** Detection range, metres. */
  maxRange: number;
  /** Range measurement noise, metres (1σ). */
  sigmaRange: number;
  /** Bearing measurement noise, radians (1σ). */
  sigmaBearing: number;
  /** Elevation measurement noise, radians (1σ). */
  sigmaElevation: number;
  /** Nominal false alarms per scan (Poisson mean). */
  clutterRate: number;
  /** Clutter elevation is uniform in ±clutterElevation radians. */
  clutterElevation: number;
  /** Per-scan detection probability by contact kind (overridden by `spec.pd`). */
  pdByKind: Record<ContactKind, number>;
}

export const DEFAULT_RADAR_CONFIG: Readonly<RadarConfig> = {
  scanHz: 10,
  maxRange: 60_000,
  sigmaRange: 30,
  sigmaBearing: 0.3 * DEG,
  sigmaElevation: 0.2 * DEG,
  clutterRate: 2,
  clutterElevation: 5 * DEG,
  pdByKind: { vehicle: 0.95, beacon: 0.98, decoy: 0.7 },
};

interface TimedOverride {
  value: number;
  untilTick: number;
}

/** Simulated radar producing noisy detections plus clutter each scan. */
export class Radar implements IRadar {
  readonly config: Readonly<RadarConfig>;
  private readonly rng: Rng;
  private readonly ticksPerScan: number;
  private clutterOverride: TimedOverride | null = null;
  private pdOverride: TimedOverride | null = null;
  private lastScanTick = 0;
  private detectionsLastScan = 0;
  private clutterLastScan = 0;
  private events: SimEvent[] = [];
  /** Messages from setters, stamped with the next tick the radar sees. */
  private readonly pending: string[] = [];

  constructor(rng: Rng, config: Partial<RadarConfig> = {}) {
    this.rng = rng;
    this.config = { ...DEFAULT_RADAR_CONFIG, ...config };
    const ticks = TICK_HZ / this.config.scanHz;
    if (!Number.isInteger(ticks) || ticks < 1) {
      throw new Error(`Radar: scanHz ${this.config.scanHz} must divide TICK_HZ ${TICK_HZ}`);
    }
    this.ticksPerScan = ticks;
  }

  /** Effective false-alarm rate per scan (override if active, else nominal). */
  get clutterRate(): number {
    return this.clutterOverride ? this.clutterOverride.value : this.config.clutterRate;
  }

  /** Global multiplier applied to every contact's pd (1 when no override is active). */
  get pdMultiplier(): number {
    return this.pdOverride ? this.pdOverride.value : 1;
  }

  isScanTick(tick: number): boolean {
    this.touch(tick);
    return tick > 0 && tick % this.ticksPerScan === 0;
  }

  scan(tick: number, platform: PlatformTruth, contacts: readonly WorldContact[]): Detection[] {
    this.touch(tick);
    const cfg = this.config;
    const pdScale = this.pdMultiplier;
    const out: Detection[] = [];

    for (const c of contacts) {
      if (!c.alive) continue;
      const dE = c.pos[0] - platform.pos[0];
      const dN = c.pos[1] - platform.pos[1];
      const r = Math.hypot(dE, dN);
      if (r > cfg.maxRange) continue;
      const pd = Math.min(1, (c.spec.pd ?? cfg.pdByKind[c.spec.kind]) * pdScale);
      if (!this.rng.bool(pd)) continue;
      const rMeas = Math.max(0, r + cfg.sigmaRange * this.rng.normal());
      const thetaMeas = Math.atan2(dE, dN) + cfg.sigmaBearing * this.rng.normal();
      const elevation = c.spec.elevationDeg * DEG + cfg.sigmaElevation * this.rng.normal();
      const declared: TrackLabel | null = c.spec.declared ? c.spec.label : null;
      out.push(this.detection(rMeas, thetaMeas, elevation, c.spec.id, declared));
    }

    const clutter = this.rng.poisson(this.clutterRate);
    for (let i = 0; i < clutter; i++) {
      const r = cfg.maxRange * Math.sqrt(this.rng.float());
      const theta = this.rng.uniform(-Math.PI, Math.PI);
      const elevation = this.rng.uniform(-cfg.clutterElevation, cfg.clutterElevation);
      out.push(this.detection(r, theta, elevation, null, null));
    }

    this.lastScanTick = tick;
    this.detectionsLastScan = out.length;
    this.clutterLastScan = clutter;
    return out;
  }

  setClutterRate(rate: number, untilTick: number): void {
    const value = Math.max(0, rate);
    this.clutterOverride = { value, untilTick };
    this.pending.push(`clutter rate set to ${formatRate(value)}/scan${untilSuffix(untilTick)}`);
  }

  setPd(pd: number, untilTick: number): void {
    const value = Math.max(0, pd);
    this.pdOverride = { value, untilTick };
    this.pending.push(`pd multiplier set to ${value.toFixed(2)}${untilSuffix(untilTick)}`);
  }

  status(tick: number, gate: GateSetting, gateChi2: number): RadarStatus {
    this.touch(tick);
    return {
      scanHz: this.config.scanHz,
      maxRange: this.config.maxRange,
      clutterRate: this.clutterRate,
      pd: this.pdMultiplier,
      detectionsLastScan: this.detectionsLastScan,
      clutterLastScan: this.clutterLastScan,
      ticksSinceScan: Math.max(0, tick - this.lastScanTick),
      gate,
      gateChi2,
    };
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Build a detection at measured polar coordinates with the rotated covariance. */
  private detection(
    r: number,
    theta: number,
    elevation: number,
    contactId: number | null,
    declaredLabel: TrackLabel | null,
  ): Detection {
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    const vr = this.config.sigmaRange * this.config.sigmaRange;
    const cross = r * this.config.sigmaBearing;
    const vc = cross * cross;
    // cov = vr·u uᵀ + vc·v vᵀ with u = [sinθ, cosθ] (along range), v = [cosθ, −sinθ] (cross range)
    const c00 = vr * s * s + vc * c * c;
    const c01 = (vr - vc) * s * c;
    const c11 = vr * c * c + vc * s * s;
    return { pos: [r * s, r * c], cov: [c00, c01, c01, c11], elevation, contactId, declaredLabel };
  }

  /** Stamp pending setter messages with `tick` and expire timed overrides. */
  private touch(tick: number): void {
    for (const m of this.pending) this.emit(tick, m);
    this.pending.length = 0;
    if (this.clutterOverride && tick >= this.clutterOverride.untilTick) {
      this.clutterOverride = null;
      this.emit(tick, `clutter rate restored to ${formatRate(this.config.clutterRate)}/scan`);
    }
    if (this.pdOverride && tick >= this.pdOverride.untilTick) {
      this.pdOverride = null;
      this.emit(tick, 'pd multiplier restored to 1.00');
    }
  }

  private emit(tick: number, message: string): void {
    this.events.push({ tick, time: tick * DT, source: 'radar', level: 'info', message });
  }
}

function formatRate(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
}

function untilSuffix(untilTick: number): string {
  return Number.isFinite(untilTick) ? ` until T+${(untilTick * DT).toFixed(1)}s` : '';
}
