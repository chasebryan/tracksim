/**
 * Five simulated navigation sensors feeding one extended Kalman filter with
 * per-sensor innovation gating and isolation bookkeeping.
 *
 * State x = [pE, pN, vE, vN, bS, bH]: the constant-velocity kinematic state of
 * CONTRACTS.md plus the two slow INS bias states (speed and heading). The INS
 * bias random walk is part of the simulated sensor, and a filter that does not
 * carry it is overconfident by an order of magnitude (its 100 Hz velocity pins
 * the estimate to the drifting INS while the position fixes are too weak to
 * pull it back), so the biases are estimated and `NavEstimate.cov` reports the
 * 4×4 kinematic block.
 *
 * Every tick the filter predicts, then processes each sensor that is due (in
 * `SENSOR_IDS` order): a measurement is generated from truth with the
 * *disturbed* noise, and the update always assumes the *nominal* R — the
 * filter does not know about disturbances, which is what makes the chi-square
 * gate meaningful.
 */
import type { Disturbance, INavigationFilter } from '../core/interfaces';
import type { NavEstimate, PlatformTruth, SensorId, SensorStatus, SimEvent, Vec2 } from '../core/types';
import { SENSOR_IDS } from '../core/types';
import { DT, wrapAngle } from '../core/constants';
import type { Rng } from '../core/rng';
import { constantVelocity2D, H_POSITION_2D } from '../math/kalman';
import { NavEkf } from './ekf';
import type { EkfUpdateResult } from './ekf';
import {
  INS_MIN_SPEED,
  NAV_BIAS_WALK_MARGIN,
  NAV_EMA_ALPHA,
  NAV_GATE_CHI2,
  NAV_INIT_P_DIAG,
  NAV_INIT_STATE_SIGMA,
  NAV_SIGMA_ACCEL,
  NAV_STATE_DIM,
  SENSOR_CONFIGS,
  isolationThreshold,
  sensorPeriodTicks,
} from './sensors';
import type { SensorConfig } from './sensors';

const N = NAV_STATE_DIM;
const KIN = 4;
const ZERO_BIAS: Readonly<Vec2> = [0, 0];

/** Mutable per-sensor runtime: configuration, its own RNG stream, and gating bookkeeping. */
interface SensorRuntime {
  readonly cfg: SensorConfig;
  readonly rng: Rng;
  /** Nominal 2×2 measurement covariance the filter assumes, row-major. */
  readonly R: Float64Array;
  readonly periodTicks: number;
  /** Consecutive rejects that isolate, and consecutive accepts that readmit. */
  readonly isolationCount: number;
  enabled: boolean;
  lastNis: number;
  meanNis: number;
  accepted: number;
  rejected: number;
  consecutiveRejects: number;
  consecutiveAccepts: number;
  isolated: boolean;
  influence: number;
  meanInfluence: number;
  disturbance: Disturbance | null;
  /** True bias random walk of the simulated sensor (INS only), added to the generated measurement. */
  readonly walkBias: Vec2;
}

/** Embed the 4×4 constant-velocity F (or Q) into the n×n state model; the bias block is `biasDiag`. */
function embedKinematic(block: Float64Array, biasDiag: readonly number[]): Float64Array {
  const out = new Float64Array(N * N);
  for (let i = 0; i < KIN; i++) for (let j = 0; j < KIN; j++) out[i * N + j] = block[i * KIN + j] as number;
  for (let i = KIN; i < N; i++) out[i * N + i] = biasDiag[i - KIN] as number;
  return out;
}

/** 2×N position Jacobian: `H_POSITION_2D` padded with zero columns for the bias states. */
const H_POSITION: Float64Array = (() => {
  const out = new Float64Array(2 * N);
  for (let i = 0; i < 2; i++) for (let j = 0; j < KIN; j++) out[i * N + j] = H_POSITION_2D.data[i * KIN + j] as number;
  return out;
})();

/**
 * Navigation filter: generates sensor measurements from platform truth and
 * fuses them with an EKF. See CONTRACTS.md "nav/" for the parameters.
 */
export class NavigationFilter implements INavigationFilter {
  private readonly ekf: NavEkf;
  private readonly F: Float64Array;
  private readonly Q: Float64Array;
  private readonly sensors: SensorRuntime[];
  private readonly insH = new Float64Array(2 * N);
  private readonly innovation = new Float64Array(2);
  /** Scratch for the measurement generated on the current tick. */
  private readonly z = new Float64Array(2);
  private events: SimEvent[] = [];

  /**
   * @param initialTruth Platform truth at tick 0; the kinematic state starts there plus
   *   N(0, [20, 20, 2, 2]) and the bias states at 0.
   * @param rng The module's stream (`Rng.fromLabel(seed, 'nav')`). The initial-state noise is drawn
   *   from it directly, then each sensor forks its own labelled sub-stream in `SENSOR_IDS` order, so
   *   disabling one sensor does not perturb the noise the others see.
   */
  constructor(initialTruth: PlatformTruth, rng: Rng) {
    const s = NAV_INIT_STATE_SIGMA;
    const ins = SENSOR_CONFIGS.INS;
    const x0 = [
      initialTruth.pos[0] + s[0] * rng.normal(),
      initialTruth.pos[1] + s[1] * rng.normal(),
      initialTruth.vel[0] + s[2] * rng.normal(),
      initialTruth.vel[1] + s[3] * rng.normal(),
      0,
      0,
    ];
    // The true INS bias starts at zero; allow it one second of (margin-inflated) random walk.
    const biasVar: Vec2 = [
      (NAV_BIAS_WALK_MARGIN * ins.biasWalkSigma[0]) ** 2,
      (NAV_BIAS_WALK_MARGIN * ins.biasWalkSigma[1]) ** 2,
    ];
    const P0 = new Float64Array(N * N);
    for (let i = 0; i < KIN; i++) P0[i * N + i] = NAV_INIT_P_DIAG[i] as number;
    for (let i = KIN; i < N; i++) P0[i * N + i] = biasVar[i - KIN] as number;
    this.ekf = new NavEkf(x0, P0);

    const model = constantVelocity2D(DT, NAV_SIGMA_ACCEL);
    this.F = embedKinematic(model.F.data, [1, 1]);
    this.Q = embedKinematic(model.Q.data, [biasVar[0] * DT, biasVar[1] * DT]);

    this.sensors = SENSOR_IDS.map((id) => {
      const cfg = SENSOR_CONFIGS[id];
      return {
        cfg,
        rng: rng.fork(id),
        R: Float64Array.from([cfg.sigma[0] * cfg.sigma[0], 0, 0, cfg.sigma[1] * cfg.sigma[1]]),
        periodTicks: sensorPeriodTicks(cfg),
        isolationCount: isolationThreshold(cfg),
        enabled: true,
        lastNis: NaN,
        meanNis: NaN,
        accepted: 0,
        rejected: 0,
        consecutiveRejects: 0,
        consecutiveAccepts: 0,
        isolated: false,
        influence: 0,
        meanInfluence: 0,
        disturbance: null,
        walkBias: [0, 0],
      };
    });
  }

  /** Predict one tick, then generate and fuse every sensor due on `tick`. */
  step(tick: number, truth: PlatformTruth): void {
    this.ekf.predict(this.F, this.Q);
    for (const sensor of this.sensors) {
      if (sensor.disturbance !== null && tick >= sensor.disturbance.untilTick) sensor.disturbance = null;
      if (!sensor.enabled || tick % sensor.periodTicks !== 0) continue;
      this.generate(sensor, truth);
      const result = this.fuse(sensor);
      if (result !== null) this.record(sensor, result, tick);
    }
  }

  setSensorEnabled(id: SensorId, enabled: boolean, _tick: number): void {
    this.sensor(id).enabled = enabled;
  }

  /** Apply a disturbance to the generated measurements of `id` until `d.untilTick` (Infinity = until cleared). */
  setDisturbance(id: SensorId, d: Disturbance, _tick: number): void {
    this.sensor(id).disturbance = { noiseScale: d.noiseScale, bias: [d.bias[0], d.bias[1]], untilTick: d.untilTick };
  }

  clearDisturbance(id: SensorId, _tick: number): void {
    this.sensor(id).disturbance = null;
  }

  /** Current kinematic state, its 4×4 covariance block, and errors against `truth`. */
  estimate(truth: PlatformTruth): NavEstimate {
    const x = this.ekf.x;
    const P = this.ekf.P;
    const pos: Vec2 = [x[0] as number, x[1] as number];
    const vel: Vec2 = [x[2] as number, x[3] as number];
    const heading = Math.atan2(vel[0], vel[1]);
    const cov = new Float64Array(KIN * KIN);
    for (let i = 0; i < KIN; i++) for (let j = 0; j < KIN; j++) cov[i * KIN + j] = P[i * N + j] as number;
    return {
      pos,
      vel,
      heading,
      speed: Math.hypot(vel[0], vel[1]),
      cov,
      posSigma: Math.sqrt(((P[0] as number) + (P[N + 1] as number)) / 2),
      velSigma: Math.sqrt(((P[2 * N + 2] as number) + (P[3 * N + 3] as number)) / 2),
      posError: Math.hypot(pos[0] - truth.pos[0], pos[1] - truth.pos[1]),
      velError: Math.hypot(vel[0] - truth.vel[0], vel[1] - truth.vel[1]),
      headingError: Math.abs(wrapAngle(heading - truth.heading)),
    };
  }

  /** Estimated INS biases [speed m/s, heading rad] — diagnostic, not part of the contract surface. */
  insBiasEstimate(): Vec2 {
    return [this.ekf.x[KIN] as number, this.ekf.x[KIN + 1] as number];
  }

  /** One status per sensor, in `SENSOR_IDS` order. Returned objects are fresh copies. */
  sensorStatuses(): SensorStatus[] {
    return this.sensors.map((s) => {
      const d = s.disturbance;
      return {
        id: s.cfg.id,
        name: s.cfg.name,
        rateHz: s.cfg.rateHz,
        enabled: s.enabled,
        lastNis: s.lastNis,
        meanNis: s.meanNis,
        gateChi2: NAV_GATE_CHI2,
        accepted: s.accepted,
        rejected: s.rejected,
        consecutiveRejects: s.consecutiveRejects,
        isolated: s.isolated,
        influence: s.influence,
        meanInfluence: s.meanInfluence,
        noiseScale: d === null ? 1 : d.noiseScale,
        bias: d === null ? [0, 0] : [d.bias[0], d.bias[1]],
        disturbanceUntilTick: d === null ? NaN : d.untilTick,
      };
    });
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private sensor(id: SensorId): SensorRuntime {
    const s = this.sensors[SENSOR_IDS.indexOf(id)];
    if (s === undefined) throw new Error(`NavigationFilter: unknown sensor ${id}`);
    return s;
  }

  /**
   * Writes z = h(truth) + bias + noiseScale · σ ⊙ N(0,1) (plus the INS bias random walk) into
   * `this.z`. Always draws the same number of normals per sensor kind so the stream stays aligned.
   */
  private generate(s: SensorRuntime, truth: PlatformTruth): void {
    const { cfg, rng } = s;
    const z = this.z;
    const scale = s.disturbance === null ? 1 : s.disturbance.noiseScale;
    const bias = s.disturbance === null ? ZERO_BIAS : s.disturbance.bias;
    if (cfg.kind === 'ins') {
      const sqrtDt = Math.sqrt(1 / cfg.rateHz);
      s.walkBias[0] += cfg.biasWalkSigma[0] * sqrtDt * rng.normal();
      s.walkBias[1] += cfg.biasWalkSigma[1] * sqrtDt * rng.normal();
      z[0] = truth.speed + s.walkBias[0] + bias[0] + scale * cfg.sigma[0] * rng.normal();
      z[1] = wrapAngle(truth.heading + s.walkBias[1] + bias[1] + scale * cfg.sigma[1] * rng.normal());
      return;
    }
    z[0] = truth.pos[0] + bias[0] + scale * cfg.sigma[0] * rng.normal();
    z[1] = truth.pos[1] + bias[1] + scale * cfg.sigma[1] * rng.normal();
  }

  /** Run the gated EKF update of `this.z` with the nominal R. Returns null when the INS update is skipped. */
  private fuse(s: SensorRuntime): EkfUpdateResult | null {
    const x = this.ekf.x;
    const y = this.innovation;
    const z = this.z;
    if (s.cfg.kind === 'ins') {
      const vE = x[2] as number;
      const vN = x[3] as number;
      const speed = Math.hypot(vE, vN);
      if (speed < INS_MIN_SPEED) return null;
      const s2 = speed * speed;
      const H = this.insH;
      H[2] = vE / speed;
      H[3] = vN / speed;
      H[KIN] = 1;
      H[N + 2] = vN / s2;
      H[N + 3] = -vE / s2;
      H[N + KIN + 1] = 1;
      y[0] = (z[0] as number) - (speed + (x[KIN] as number));
      y[1] = wrapAngle((z[1] as number) - (Math.atan2(vE, vN) + (x[KIN + 1] as number)));
      return this.ekf.update(y, H, s.R, NAV_GATE_CHI2);
    }
    y[0] = (z[0] as number) - (x[0] as number);
    y[1] = (z[1] as number) - (x[1] as number);
    return this.ekf.update(y, H_POSITION, s.R, NAV_GATE_CHI2);
  }

  /** Gating bookkeeping: NIS/influence EMAs, counters, and the isolation state machine. */
  private record(s: SensorRuntime, r: EkfUpdateResult, tick: number): void {
    const a = NAV_EMA_ALPHA;
    s.lastNis = r.nis;
    s.meanNis = Number.isNaN(s.meanNis) ? r.nis : s.meanNis + a * (r.nis - s.meanNis);
    if (r.accepted) {
      s.accepted++;
      s.consecutiveRejects = 0;
      s.consecutiveAccepts++;
      s.influence = r.influence;
      s.meanInfluence += a * (r.influence - s.meanInfluence);
      if (s.isolated && s.consecutiveAccepts >= s.isolationCount) {
        s.isolated = false;
        this.emit(tick, 'info', `${s.cfg.id} readmitted after ${s.consecutiveAccepts} consecutive accepted measurements`);
      }
    } else {
      s.rejected++;
      s.consecutiveRejects++;
      s.consecutiveAccepts = 0;
      s.meanInfluence *= 1 - a;
      if (!s.isolated && s.consecutiveRejects >= s.isolationCount) {
        s.isolated = true;
        this.emit(
          tick,
          'warn',
          `${s.cfg.id} isolated: ${s.consecutiveRejects} consecutive measurements rejected (NIS ${r.nis.toFixed(1)} > ${NAV_GATE_CHI2})`,
        );
      }
    }
  }

  private emit(tick: number, level: 'info' | 'warn', message: string): void {
    this.events.push({ tick, time: tick * DT, source: 'nav', level, message });
  }
}
