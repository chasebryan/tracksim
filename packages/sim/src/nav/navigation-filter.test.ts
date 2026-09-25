import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { DEG, DT, TICK_HZ, secondsToTick, wrapAngle } from '../core/constants';
import { SENSOR_IDS } from '../core/types';
import type { PlatformTruth, SensorId, SensorStatus, SimEvent } from '../core/types';
import { NavigationFilter } from './navigation-filter';
import { NAV_GATE_CHI2, SENSOR_CONFIGS } from './sensors';

// ---------------------------------------------------------------------------
// Synthetic truth: the world's kinematics (CONTRACTS.md "world/") at 100 Hz.
// ---------------------------------------------------------------------------

function truthAt(heading: number, speed: number, pos: [number, number] = [1000, 2000]): PlatformTruth {
  return {
    pos,
    vel: [speed * Math.sin(heading), speed * Math.cos(heading)],
    heading,
    speed,
    alt: 3000,
    turnRate: 0,
    accel: 0,
  };
}

function advance(t: PlatformTruth, turnRate: number, accel: number): PlatformTruth {
  const heading = wrapAngle(t.heading + turnRate * DT);
  const speed = Math.max(0, t.speed + accel * DT);
  const vel: [number, number] = [speed * Math.sin(heading), speed * Math.cos(heading)];
  return {
    pos: [t.pos[0] + vel[0] * DT, t.pos[1] + vel[1] * DT],
    vel,
    heading,
    speed,
    alt: t.alt,
    turnRate,
    accel,
  };
}

interface RunOptions {
  seed: number;
  seconds: number;
  heading?: number;
  /** Turn rate (rad/s) applied while `from <= time < to`. */
  turn?: { from: number; to: number; rate: number };
  /** Called before `step(tick)`; lets a test inject commands at a tick. */
  before?: (tick: number, nav: NavigationFilter) => void;
  /** Called after `step(tick)` with the truth of that tick. */
  after?: (tick: number, nav: NavigationFilter, truth: PlatformTruth) => void;
  /** Override the truth for a tick (used by the heading-wrap test). */
  truthFor?: (tick: number, previous: PlatformTruth) => PlatformTruth;
}

function run(opts: RunOptions): { nav: NavigationFilter; truth: PlatformTruth; events: SimEvent[] } {
  let truth = truthAt(opts.heading ?? 0.3, 250);
  const nav = new NavigationFilter(truth, Rng.fromLabel(opts.seed, 'nav'));
  const events: SimEvent[] = [];
  const n = secondsToTick(opts.seconds);
  for (let tick = 1; tick <= n; tick++) {
    const time = tick * DT;
    const turning = opts.turn !== undefined && time >= opts.turn.from && time < opts.turn.to;
    truth = opts.truthFor ? opts.truthFor(tick, truth) : advance(truth, turning ? opts.turn!.rate : 0, 0);
    opts.before?.(tick, nav);
    nav.step(tick, truth);
    events.push(...nav.drainEvents());
    opts.after?.(tick, nav, truth);
  }
  return { nav, truth, events };
}

function status(nav: NavigationFilter, id: SensorId): SensorStatus {
  const s = nav.sensorStatuses().find((x) => x.id === id);
  if (!s) throw new Error(`no status for ${id}`);
  return s;
}

/** Per-sensor sample-mean NIS and rejection rate, collected from `lastNis` at each new measurement. */
class NisCollector {
  private readonly sum = new Map<SensorId, number>();
  private readonly count = new Map<SensorId, number>();
  private readonly seen = new Map<SensorId, number>();
  private readonly rejectedAtStart = new Map<SensorId, number>();
  private readonly acceptedAtStart = new Map<SensorId, number>();

  constructor(private readonly fromTick: number) {}

  observe(tick: number, nav: NavigationFilter): void {
    if (tick < this.fromTick) return;
    for (const s of nav.sensorStatuses()) {
      const total = s.accepted + s.rejected;
      if (!this.seen.has(s.id)) {
        this.seen.set(s.id, total);
        this.rejectedAtStart.set(s.id, s.rejected);
        this.acceptedAtStart.set(s.id, s.accepted);
        continue;
      }
      if (total !== this.seen.get(s.id)) {
        this.seen.set(s.id, total);
        this.sum.set(s.id, (this.sum.get(s.id) ?? 0) + s.lastNis);
        this.count.set(s.id, (this.count.get(s.id) ?? 0) + 1);
      }
    }
  }

  meanNis(id: SensorId): number {
    return (this.sum.get(id) ?? NaN) / (this.count.get(id) ?? 0);
  }

  samples(id: SensorId): number {
    return this.count.get(id) ?? 0;
  }

  rejectionRate(id: SensorId, final: SensorStatus): number {
    const rej = final.rejected - (this.rejectedAtStart.get(id) ?? 0);
    const acc = final.accepted - (this.acceptedAtStart.get(id) ?? 0);
    return rej / (rej + acc);
  }
}

/** Convergence statistics from `fromS` seconds onwards. */
class ErrorStats {
  ticks = 0;
  within3Sigma = 0;
  maxPosError = 0;
  maxHeadingError = 0;
  neesSum = 0;

  constructor(private readonly fromS: number) {}

  observe(tick: number, nav: NavigationFilter, truth: PlatformTruth): void {
    if (tick * DT < this.fromS) return;
    const e = nav.estimate(truth);
    this.ticks++;
    if (e.posError < 3 * e.posSigma) this.within3Sigma++;
    this.maxPosError = Math.max(this.maxPosError, e.posError);
    this.maxHeadingError = Math.max(this.maxHeadingError, e.headingError);
    this.neesSum += (e.posError * e.posError) / (e.posSigma * e.posSigma);
  }

  get within3SigmaFraction(): number {
    return this.within3Sigma / this.ticks;
  }

  /** Mean normalised estimation error squared of the 2-D position: 2 for a perfectly consistent filter. */
  get nees(): number {
    return this.neesSum / this.ticks;
  }
}

// ---------------------------------------------------------------------------

describe('NavigationFilter', () => {
  it('reports five sensor statuses in SENSOR_IDS order with the contract names, rates and gate', () => {
    const nav = new NavigationFilter(truthAt(0.3, 250), Rng.fromLabel(1, 'nav'));
    const statuses = nav.sensorStatuses();
    expect(statuses.map((s) => s.id)).toEqual([...SENSOR_IDS]);
    expect(statuses.map((s) => s.name)).toEqual([
      'Inertial (speed/heading)',
      'Star tracker (position fix)',
      'Magnetic/gravity map match',
      'Terrain-contour radar fix',
      'Swarm-relative mesh fix',
    ]);
    expect(statuses.map((s) => s.rateHz)).toEqual([100, 20, 50, 10, 100]);
    for (const s of statuses) {
      expect(s.gateChi2).toBe(NAV_GATE_CHI2);
      expect(s.enabled).toBe(true);
      expect(s.accepted).toBe(0);
      expect(s.rejected).toBe(0);
      expect(s.consecutiveRejects).toBe(0);
      expect(s.isolated).toBe(false);
      expect(Number.isNaN(s.lastNis)).toBe(true);
      expect(Number.isNaN(s.meanNis)).toBe(true);
      expect(s.influence).toBe(0);
      expect(s.meanInfluence).toBe(0);
      expect(s.noiseScale).toBe(1);
      expect(s.bias).toEqual([0, 0]);
      expect(Number.isNaN(s.disturbanceUntilTick)).toBe(true);
    }
  });

  it('starts near the truth with the contract P0 and fills every NavEstimate field', () => {
    const truth = truthAt(0.3, 250);
    const nav = new NavigationFilter(truth, Rng.fromLabel(7, 'nav'));
    const e = nav.estimate(truth);
    // Initial state is truth + N(0, [20, 20, 2, 2]); 5σ bounds never trip for a fixed seed.
    expect(e.posError).toBeLessThan(5 * 20 * Math.SQRT2);
    expect(e.velError).toBeLessThan(5 * 2 * Math.SQRT2);
    expect(e.cov.length).toBe(16);
    expect(e.cov[0]).toBe(100 * 100);
    expect(e.cov[5]).toBe(100 * 100);
    expect(e.cov[10]).toBe(10 * 10);
    expect(e.cov[15]).toBe(10 * 10);
    expect(e.posSigma).toBe(100);
    expect(e.velSigma).toBe(10);
    expect(e.heading).toBeCloseTo(Math.atan2(e.vel[0], e.vel[1]), 12);
    expect(e.speed).toBeCloseTo(Math.hypot(e.vel[0], e.vel[1]), 12);
    expect(e.headingError).toBeCloseTo(Math.abs(wrapAngle(e.heading - truth.heading)), 12);
  });

  it('converges straight and level: error inside 3·posSigma, tight final error and heading', () => {
    const stats = new ErrorStats(10);
    const { nav, truth } = run({ seed: 1, seconds: 40, after: (t, n, tr) => stats.observe(t, n, tr) });
    const final = nav.estimate(truth);
    // Contract acceptance: after 10 s the error is inside 3·posSigma on ≥ 99% of ticks. For a
    // consistent 2-D Gaussian error P(|e| > 3σ) = e^{-4.5} ≈ 1.1% per tick, so this bound sits
    // at the consistency limit; it holds for this seed because the process model is conservative.
    expect(stats.within3SigmaFraction).toBeGreaterThanOrEqual(0.99);
    // NEES of a consistent 2-D estimate averages 2; the 30 s window has only a handful of
    // independent samples (the bias-estimation error is correlated over ~10 s), so we bound
    // it loosely: < 4 rules out overconfidence, > 0.3 rules out a P inflated to meaninglessness.
    expect(stats.nees).toBeLessThan(4);
    expect(stats.nees).toBeGreaterThan(0.3);
    expect(final.posError).toBeLessThan(20);
    expect(final.posError).toBeLessThan(5);
    expect(final.headingError).toBeLessThan(0.01);
    expect(stats.maxHeadingError).toBeLessThan(0.01);
    expect(final.posSigma).toBeLessThan(3);
    expect(final.velSigma).toBeLessThan(1);
    for (const s of nav.sensorStatuses()) expect(s.isolated).toBe(false);
  });

  it('tracks a 3°/s turn (13 m/s² centripetal) without gating the INS or losing the estimate', () => {
    const stats = new ErrorStats(10);
    const nis = new NisCollector(secondsToTick(10));
    const { nav, truth, events } = run({
      seed: 1,
      seconds: 40,
      turn: { from: 10, to: 30, rate: 3 * DEG },
      after: (t, n, tr) => {
        stats.observe(t, n, tr);
        nis.observe(t, n);
      },
    });
    const final = nav.estimate(truth);
    expect(final.posError).toBeLessThan(20);
    expect(stats.maxPosError).toBeLessThan(6);
    expect(stats.maxHeadingError).toBeLessThan(0.01);
    // The turn is an unmodelled deterministic acceleration: the CV filter lags by ~1 m/s in
    // velocity and ~2 m in position during it, which is up to ~3.5·posSigma — the covariance
    // cannot know about a manoeuvre. So the 3σ fraction is only required to stay above 80%
    // (measured 85–100% over 12 seeds), while the absolute bounds above are strict.
    expect(stats.within3SigmaFraction).toBeGreaterThanOrEqual(0.8);
    expect(stats.nees).toBeLessThan(6);
    // Nothing isolates during a scripted manoeuvre, and the INS keeps being accepted.
    expect(events).toEqual([]);
    for (const s of nav.sensorStatuses()) expect(s.isolated).toBe(false);
    expect(nis.rejectionRate('INS', status(nav, 'INS'))).toBeLessThan(0.03);
    expect(nis.meanNis('INS')).toBeLessThan(2.8);
  });

  it('keeps every sensor NIS nominal: mean in [1.4, 2.8] and rejections below 3%', () => {
    const nis = new NisCollector(secondsToTick(5));
    const { nav } = run({ seed: 2, seconds: 40, after: (t, n) => nis.observe(t, n) });
    for (const s of nav.sensorStatuses()) {
      // A 2-dof NIS averages 2 when the filter is consistent; the filter's process model is
      // deliberately conservative (no true manoeuvre in this run) which pulls the INS mean a
      // little below 2. [1.4, 2.8] is the contract band.
      expect(nis.samples(s.id)).toBeGreaterThan(300);
      expect(nis.meanNis(s.id)).toBeGreaterThanOrEqual(1.4);
      expect(nis.meanNis(s.id)).toBeLessThanOrEqual(2.8);
      // At a 0.99 gate the nominal rejection rate is ~1%.
      expect(nis.rejectionRate(s.id, s)).toBeLessThan(0.03);
      // The EMA (α = 0.05, ~40-sample memory, σ ≈ 0.3) is a noisier readout of the same thing.
      expect(s.meanNis).toBeGreaterThan(1.0);
      expect(s.meanNis).toBeLessThan(3.5);
      expect(s.accepted + s.rejected).toBe(s.rateHz * 40);
      expect(s.isolated).toBe(false);
    }
  });

  it('isolates a TERRAIN fix degraded ×10, keeps the estimate, and readmits it after the disturbance clears', () => {
    const onset = secondsToTick(20);
    const clear = secondsToTick(40);
    let isolatedAt = -1;
    let clearedAt = -1;
    let maxErr = 0;
    let influenceBeforeOnset = 0;
    let maxInfluenceWhileIsolated = 0;
    let rejectedAtOnset = 0;
    let acceptedAtOnset = 0;
    let rejectedAtClear = 0;
    let acceptedAtClear = 0;
    const { nav, events } = run({
      seed: 3,
      seconds: 50,
      before: (tick, n) => {
        if (tick === onset) {
          const s = status(n, 'TERRAIN');
          influenceBeforeOnset = s.meanInfluence;
          rejectedAtOnset = s.rejected;
          acceptedAtOnset = s.accepted;
          n.setDisturbance('TERRAIN', { noiseScale: 10, bias: [0, 0], untilTick: Infinity }, tick);
        }
        if (tick === clear) {
          const s = status(n, 'TERRAIN');
          rejectedAtClear = s.rejected;
          acceptedAtClear = s.accepted;
          n.clearDisturbance('TERRAIN', tick);
        }
      },
      after: (tick, n, truth) => {
        const s = status(n, 'TERRAIN');
        if (tick >= onset) maxErr = Math.max(maxErr, n.estimate(truth).posError);
        if (s.isolated && isolatedAt < 0) isolatedAt = tick;
        if (isolatedAt > 0 && !s.isolated && clearedAt < 0 && tick > clear) clearedAt = tick;
        if (s.isolated && tick >= isolatedAt + secondsToTick(5)) {
          maxInfluenceWhileIsolated = Math.max(maxInfluenceWhileIsolated, s.meanInfluence);
        }
        if (tick === onset) expect(s.noiseScale).toBe(10);
      },
    });
    // Degraded σ is 80 m against an assumed 8 m: NIS is ~100× nominal, so ~95% of fixes fail the
    // gate and five consecutive rejects (0.5 s at 10 Hz) arrive well within a second.
    expect(isolatedAt).toBeGreaterThan(onset);
    expect(isolatedAt).toBeLessThanOrEqual(onset + secondsToTick(1));
    // While isolated the influence EMA decays toward 0 on every rejected fix; after 5 s it is
    // both under the contract's 0.02 and well below its nominal level.
    expect(maxInfluenceWhileIsolated).toBeLessThan(0.02);
    expect(maxInfluenceWhileIsolated).toBeLessThan(0.5 * influenceBeforeOnset);
    expect(influenceBeforeOnset).toBeGreaterThan(0);
    const rejectedDuring = rejectedAtClear - rejectedAtOnset;
    const acceptedDuring = acceptedAtClear - acceptedAtOnset;
    expect(rejectedDuring + acceptedDuring).toBe(200);
    expect(rejectedDuring / 200).toBeGreaterThan(0.85);
    // The other sensors carry the estimate: nothing blows up.
    expect(maxErr).toBeLessThan(25);
    expect(maxErr).toBeLessThan(5);
    // Readmission: nominal fixes are accepted again and the flag clears within 2 s.
    expect(clearedAt).toBeGreaterThan(clear);
    expect(clearedAt).toBeLessThanOrEqual(clear + secondsToTick(2));
    const finalStatus = status(nav, 'TERRAIN');
    expect(finalStatus.isolated).toBe(false);
    expect(finalStatus.noiseScale).toBe(1);
    expect(finalStatus.accepted - acceptedAtClear).toBeGreaterThan(90);
    // Exactly one warn on isolation and one info on readmission, both from nav.
    expect(events.map((e) => [e.source, e.level])).toEqual([
      ['nav', 'warn'],
      ['nav', 'info'],
    ]);
    expect(events[0]!.tick).toBe(isolatedAt);
    expect(events[0]!.time).toBeCloseTo(isolatedAt * DT, 12);
    expect(events[0]!.message).toContain('TERRAIN');
    expect(events[1]!.tick).toBe(clearedAt);
    expect(events[1]!.message).toContain('TERRAIN');
    for (const id of SENSOR_IDS) if (id !== 'TERRAIN') expect(status(nav, id).isolated).toBe(false);
  });

  it('isolates a biased SWARM fix within a second and does not let the bias leak into the estimate', () => {
    const onset = secondsToTick(20);
    let isolatedAt = -1;
    let maxErr = 0;
    let errSum = 0;
    let errCount = 0;
    let acceptedAtIsolation = -1;
    const { nav, events } = run({
      seed: 4,
      seconds: 40,
      before: (tick, n) => {
        if (tick === onset) n.setDisturbance('SWARM', { noiseScale: 1, bias: [400, -150], untilTick: Infinity }, tick);
      },
      after: (tick, n, truth) => {
        if (tick < onset) return;
        const e = n.estimate(truth);
        maxErr = Math.max(maxErr, e.posError);
        errSum += e.posError;
        errCount++;
        const s = status(n, 'SWARM');
        if (s.isolated && isolatedAt < 0) {
          isolatedAt = tick;
          acceptedAtIsolation = s.accepted;
        }
      },
    });
    // |bias| = 427 m against S ≈ 35² → NIS ≈ 150 ≫ 9.21: every fix is rejected, and 50
    // consecutive rejects (0.5 s at 100 Hz) isolate it by ~0.5 s after onset.
    expect(isolatedAt).toBeGreaterThan(onset);
    expect(isolatedAt).toBeLessThanOrEqual(onset + secondsToTick(1));
    expect(maxErr).toBeLessThan(25);
    expect(errSum / errCount).toBeLessThan(5);
    const s = status(nav, 'SWARM');
    expect(s.isolated).toBe(true);
    expect(s.accepted).toBe(acceptedAtIsolation);
    expect(s.consecutiveRejects).toBe(secondsToTick(40) - isolatedAt + 50);
    expect(s.bias).toEqual([400, -150]);
    expect(s.disturbanceUntilTick).toBe(Infinity);
    expect(events.filter((e) => e.level === 'warn')).toHaveLength(1);
    expect(events.filter((e) => e.level === 'info')).toHaveLength(0);
    // The estimate is carried by the four remaining sensors.
    for (const id of SENSOR_IDS) if (id !== 'SWARM') expect(status(nav, id).isolated).toBe(false);
  });

  it('disabling STAR freezes its counters, leaves the other sensors unaffected, and re-enabling resumes it', () => {
    const disableAt = secondsToTick(10);
    const enableAt = secondsToTick(20);
    let frozen: SensorStatus | null = null;
    let othersAtDisable: SensorStatus[] = [];
    let starAtEnable: SensorStatus | null = null;
    let othersAtEnable: SensorStatus[] = [];
    const { nav } = run({
      seed: 5,
      seconds: 30,
      before: (tick, n) => {
        if (tick === disableAt) {
          n.setSensorEnabled('STAR', false, tick);
          frozen = status(n, 'STAR');
          othersAtDisable = n.sensorStatuses().filter((s) => s.id !== 'STAR');
        }
        if (tick === enableAt) {
          starAtEnable = status(n, 'STAR');
          othersAtEnable = n.sensorStatuses().filter((s) => s.id !== 'STAR');
          n.setSensorEnabled('STAR', true, tick);
        }
      },
      after: (tick, n) => {
        if (tick >= disableAt && tick < enableAt) {
          const s = status(n, 'STAR');
          expect(s.enabled).toBe(false);
          expect(s.accepted).toBe(frozen!.accepted);
          expect(s.rejected).toBe(frozen!.rejected);
          expect(s.lastNis).toBe(frozen!.lastNis);
        }
      },
    });
    expect(frozen!.accepted + frozen!.rejected).toBe(20 * 10 - 1);
    expect(starAtEnable!.accepted).toBe(frozen!.accepted);
    expect(starAtEnable!.rejected).toBe(frozen!.rejected);
    // The other four kept measuring at their rates during the 10 s outage, nothing isolated,
    // and their NIS stayed nominal.
    for (let i = 0; i < othersAtDisable.length; i++) {
      const a = othersAtDisable[i]!;
      const b = othersAtEnable[i]!;
      expect(b.id).toBe(a.id);
      expect(b.accepted + b.rejected - (a.accepted + a.rejected)).toBe(a.rateHz * 10);
      expect(b.isolated).toBe(false);
      expect(b.enabled).toBe(true);
      expect(b.meanNis).toBeGreaterThan(1.0);
      expect(b.meanNis).toBeLessThan(3.5);
    }
    const star = status(nav, 'STAR');
    expect(star.enabled).toBe(true);
    // Re-enabled before step 2000: fixes on ticks 2000, 2005, …, 3000 — 201 of them.
    expect(star.accepted + star.rejected).toBe(frozen!.accepted + frozen!.rejected + 201);
    expect(star.isolated).toBe(false);
  });

  it('handles the INS heading wrapping from π − 0.001 to −π + 0.001 without an estimate jump', () => {
    const crossAt = secondsToTick(20);
    let maxVelJump = 0;
    let maxHeadingError = 0;
    let previousVel: [number, number] | null = null;
    const { nav, truth } = run({
      seed: 6,
      seconds: 40,
      heading: Math.PI - 0.001,
      truthFor: (tick, prev) => {
        const next = advance(prev, 0, 0);
        if (tick < crossAt) return next;
        // Cross the ±π seam: a 0.002 rad step in heading, i.e. a 0.5 m/s velocity change.
        const heading = -Math.PI + 0.001;
        return {
          ...next,
          heading,
          vel: [next.speed * Math.sin(heading), next.speed * Math.cos(heading)],
        };
      },
      after: (tick, n, tr) => {
        const e = n.estimate(tr);
        if (tick * DT >= 10) maxHeadingError = Math.max(maxHeadingError, e.headingError);
        if (previousVel && tick >= crossAt - 200) {
          maxVelJump = Math.max(maxVelJump, Math.hypot(e.vel[0] - previousVel[0], e.vel[1] - previousVel[1]));
        }
        previousVel = e.vel;
      },
    });
    const final = nav.estimate(truth);
    expect(Math.abs(final.heading)).toBeGreaterThan(Math.PI - 0.01);
    expect(final.headingError).toBeLessThan(0.01);
    expect(maxHeadingError).toBeLessThan(0.01);
    // A wrap bug would show as a 2π innovation: the estimate would swing by hundreds of m/s.
    // Nominal per-tick velocity changes are the INS gain × its 0.75 m/s noise, so < 1 m/s.
    expect(maxVelJump).toBeLessThan(1);
    const ins = status(nav, 'INS');
    expect(ins.isolated).toBe(false);
    expect(ins.rejected / (ins.accepted + ins.rejected)).toBeLessThan(0.03);
    expect(ins.consecutiveRejects).toBeLessThan(5);
  });

  it('is deterministic: the same seed and truth sequence give identical estimates and statuses', () => {
    const truthSeq: PlatformTruth[] = [];
    let t = truthAt(0.3, 250);
    for (let tick = 1; tick <= 1500; tick++) {
      t = advance(t, tick > 500 ? 2 * DEG : 0, 0);
      truthSeq.push(t);
    }
    const a = new NavigationFilter(truthAt(0.3, 250), Rng.fromLabel(42, 'nav'));
    const b = new NavigationFilter(truthAt(0.3, 250), Rng.fromLabel(42, 'nav'));
    for (let tick = 1; tick <= 1500; tick++) {
      const truth = truthSeq[tick - 1]!;
      if (tick === 800) {
        a.setDisturbance('TERRAIN', { noiseScale: 10, bias: [0, 0], untilTick: 1200 }, tick);
        b.setDisturbance('TERRAIN', { noiseScale: 10, bias: [0, 0], untilTick: 1200 }, tick);
      }
      a.step(tick, truth);
      b.step(tick, truth);
      const ea = a.estimate(truth);
      const eb = b.estimate(truth);
      expect(ea.pos).toEqual(eb.pos);
      expect(ea.vel).toEqual(eb.vel);
      expect(Array.from(ea.cov)).toEqual(Array.from(eb.cov));
      expect(a.sensorStatuses()).toEqual(b.sensorStatuses());
      expect(a.drainEvents()).toEqual(b.drainEvents());
    }
    // And a different seed really does produce a different run.
    const c = new NavigationFilter(truthAt(0.3, 250), Rng.fromLabel(43, 'nav'));
    c.step(1, truthSeq[0]!);
    expect(c.estimate(truthSeq[0]!).pos).not.toEqual(a.estimate(truthSeq[1499]!).pos);
  });

  it('expires a disturbance at untilTick and reports it in the status meanwhile', () => {
    const onset = secondsToTick(15);
    const until = secondsToTick(20);
    let seenDuring: SensorStatus | null = null;
    const { nav, events } = run({
      seed: 8,
      seconds: 30,
      before: (tick, n) => {
        if (tick === onset) n.setDisturbance('TERRAIN', { noiseScale: 10, bias: [5, -5], untilTick: until }, tick);
      },
      after: (tick, n) => {
        if (tick === until - 1) seenDuring = status(n, 'TERRAIN');
        if (tick === until) {
          const s = status(n, 'TERRAIN');
          expect(s.noiseScale).toBe(1);
          expect(s.bias).toEqual([0, 0]);
          expect(Number.isNaN(s.disturbanceUntilTick)).toBe(true);
        }
      },
    });
    expect(seenDuring!.noiseScale).toBe(10);
    expect(seenDuring!.bias).toEqual([5, -5]);
    expect(seenDuring!.disturbanceUntilTick).toBe(until);
    expect(seenDuring!.isolated).toBe(true);
    expect(status(nav, 'TERRAIN').isolated).toBe(false);
    expect(events.map((e) => e.level)).toEqual(['warn', 'info']);
    expect(events[1]!.tick).toBeGreaterThanOrEqual(until);
    expect(events[1]!.tick).toBeLessThanOrEqual(until + secondsToTick(2));
  });

  it('drainEvents returns each event once and setDisturbance copies the bias', () => {
    const nav = new NavigationFilter(truthAt(0.3, 250), Rng.fromLabel(9, 'nav'));
    const bias: [number, number] = [400, -150];
    nav.setDisturbance('SWARM', { noiseScale: 1, bias, untilTick: Infinity }, 1);
    bias[0] = 0;
    expect(status(nav, 'SWARM').bias).toEqual([400, -150]);
    let truth = truthAt(0.3, 250);
    for (let tick = 1; tick <= 100; tick++) {
      truth = advance(truth, 0, 0);
      nav.step(tick, truth);
    }
    const first = nav.drainEvents();
    expect(first).toHaveLength(1);
    expect(first[0]!.source).toBe('nav');
    expect(first[0]!.level).toBe('warn');
    expect(nav.drainEvents()).toEqual([]);
  });

  it('steps 30 000 ticks (a 300 s run) quickly enough for seek-by-replay', () => {
    let truth = truthAt(0.3, 250);
    const nav = new NavigationFilter(truth, Rng.fromLabel(10, 'nav'));
    const t0 = performance.now();
    for (let tick = 1; tick <= 30_000; tick++) {
      truth = advance(truth, 0, 0);
      nav.step(tick, truth);
    }
    const ms = performance.now() - t0;
    // ~10 µs/tick measured; the bound is generous so slow CI does not flake, but a return to
    // the allocating Mat path (~80 µs/tick) would fail it.
    expect(ms).toBeLessThan(1500);
    expect(nav.estimate(truth).posError).toBeLessThan(20);
  });

  it('exposes the contract sensor configuration on the statuses it reports', () => {
    const nav = new NavigationFilter(truthAt(0.3, 250), Rng.fromLabel(11, 'nav'));
    for (const s of nav.sensorStatuses()) {
      expect(s.rateHz).toBe(SENSOR_CONFIGS[s.id].rateHz);
      expect(s.name).toBe(SENSOR_CONFIGS[s.id].name);
      expect(TICK_HZ % s.rateHz).toBe(0);
    }
  });
});
