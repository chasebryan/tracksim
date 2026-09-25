/**
 * Static configuration of the five navigation sensors that feed the EKF, plus
 * the filter tuning constants fixed by CONTRACTS.md "nav/". Everything here is
 * data; the behaviour lives in navigation-filter.ts.
 */
import type { SensorId, Vec2 } from '../core/types';
import { SENSOR_IDS } from '../core/types';
import { TICK_HZ } from '../core/constants';
import { chi2Critical } from '../math/chi2';

/** INS reports [speed, heading] through a nonlinear h(x); every other sensor reports [pE, pN]. */
export type SensorKind = 'ins' | 'position';

export interface SensorConfig {
  readonly id: SensorId;
  /** Human label shown on the HUD sensor card. */
  readonly name: string;
  readonly rateHz: number;
  readonly kind: SensorKind;
  /**
   * Nominal 1-σ measurement noise per component: [m/s, rad] for INS,
   * [m, m] for position fixes. This is the R the filter always assumes.
   */
  readonly sigma: Readonly<Vec2>;
  /** Slow bias random walk σ per √s per component (INS only; zero elsewhere). */
  readonly biasWalkSigma: Readonly<Vec2>;
}

const NO_WALK: Readonly<Vec2> = [0, 0];

/** Sensor table from CONTRACTS.md, keyed by id. Iterate via `SENSOR_IDS` for a fixed order. */
export const SENSOR_CONFIGS: Readonly<Record<SensorId, SensorConfig>> = {
  INS: {
    id: 'INS',
    name: 'Inertial (speed/heading)',
    rateHz: 100,
    kind: 'ins',
    sigma: [0.5, 0.003],
    biasWalkSigma: [0.02, 0.0002],
  },
  STAR: {
    id: 'STAR',
    name: 'Star tracker (position fix)',
    rateHz: 20,
    kind: 'position',
    sigma: [12, 12],
    biasWalkSigma: NO_WALK,
  },
  MAGGRAV: {
    id: 'MAGGRAV',
    name: 'Magnetic/gravity map match',
    rateHz: 50,
    kind: 'position',
    sigma: [60, 60],
    biasWalkSigma: NO_WALK,
  },
  TERRAIN: {
    id: 'TERRAIN',
    name: 'Terrain-contour radar fix',
    rateHz: 10,
    kind: 'position',
    sigma: [8, 8],
    biasWalkSigma: NO_WALK,
  },
  SWARM: {
    id: 'SWARM',
    name: 'Swarm-relative mesh fix',
    rateHz: 100,
    kind: 'position',
    sigma: [35, 35],
    biasWalkSigma: NO_WALK,
  },
};

/** The sensor table in `SENSOR_IDS` order — the order measurements are processed each tick. */
export const SENSOR_CONFIG_LIST: readonly SensorConfig[] = SENSOR_IDS.map((id) => SENSOR_CONFIGS[id]);

/** Innovation gate shared by every sensor: chi-square(2 dof) at 0.99. */
export const NAV_GATE_CHI2: number = chi2Critical(2, 0.99);

/** Filter state dimension: [pE, pN, vE, vN] plus the INS [speed, heading] bias states. */
export const NAV_STATE_DIM = 6;

/** White-noise-acceleration σ (m/s²) of the constant-velocity process model. */
export const NAV_SIGMA_ACCEL = 20;

/**
 * Multiplier on the INS bias-walk σ the *filter* models (the simulated sensor walks at the
 * table value). A margin above 1 keeps the filter from being overconfident about the bias
 * it is tracking, so the reported posSigma stays honest.
 */
export const NAV_BIAS_WALK_MARGIN = 2;

/** 1-σ of the noise added to truth when initialising [pE, pN, vE, vN]. */
export const NAV_INIT_STATE_SIGMA: readonly [number, number, number, number] = [20, 20, 2, 2];

/** Diagonal of the initial covariance P0 (variances of [pE, pN, vE, vN]). */
export const NAV_INIT_P_DIAG: readonly [number, number, number, number] = [100 * 100, 100 * 100, 10 * 10, 10 * 10];

/** EMA coefficient used for `meanNis` and `meanInfluence`. */
export const NAV_EMA_ALPHA = 0.05;

/** Seconds of consecutive rejections (and of consecutive acceptances) that flip `isolated`. */
export const NAV_ISOLATION_SECONDS = 0.5;

/** Estimated ground speed below which the INS Jacobian is ill-conditioned and the update is skipped. */
export const INS_MIN_SPEED = 0.1;

/** Ticks between two measurements of a sensor (`TICK_HZ / rateHz`, an integer for every entry). */
export function sensorPeriodTicks(cfg: SensorConfig): number {
  return TICK_HZ / cfg.rateHz;
}

/** True when an enabled sensor produces a measurement on `tick`. */
export function isSensorDue(cfg: SensorConfig, tick: number): boolean {
  return tick % sensorPeriodTicks(cfg) === 0;
}

/** Consecutive rejections that isolate a sensor: half a second of its measurements. */
export function isolationThreshold(cfg: SensorConfig): number {
  return Math.ceil(cfg.rateHz * NAV_ISOLATION_SECONDS);
}
