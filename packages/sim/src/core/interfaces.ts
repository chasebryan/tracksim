/**
 * Module interfaces. Each sim module implements one of these; the
 * `Simulation` orchestrator in core/simulation.ts composes them.
 * Modules never import each other — only `core/types`, `core/rng`,
 * `core/constants` and `math/*`.
 */
import type {
  ContactSnapshot,
  ContactSpec,
  Detection,
  GateSetting,
  NavEstimate,
  PlatformTruth,
  RadarStatus,
  Scenario,
  ScenarioEvent,
  SensorId,
  SensorStatus,
  SimEvent,
  TelemetryMetrics,
  TrackLabel,
  TrackSnapshot,
} from './types';

/** Buffer of events a module produced since the last drain. */
export interface EventProducer {
  drainEvents(): SimEvent[];
}

// ---------------------------------------------------------------------------
// world/ — platform truth and contacts
// ---------------------------------------------------------------------------

export interface WorldContact {
  spec: ContactSpec;
  pos: [number, number];
  vel: [number, number];
  alive: boolean;
}

export interface IWorld extends EventProducer {
  readonly platform: PlatformTruth;
  /** Alive and dead contacts; consumers filter on `alive`. */
  readonly contacts: readonly WorldContact[];
  /** Advance platform kinematics and contacts by one tick. */
  step(tick: number): void;
  setTurn(rateRadS: number, untilTick: number): void;
  setAccel(mps2: number, untilTick: number): void;
  spawn(spec: ContactSpec, tick: number): void;
  despawn(id: number, tick: number): void;
  /** Spawn `count` decoys clustered near a contact (or near a random alive contact). Returns their ids. */
  spawnDecoys(count: number, tick: number, nearContactId?: number): number[];
  contactSnapshots(): ContactSnapshot[];
}

// ---------------------------------------------------------------------------
// nav/ — five sensor models feeding one EKF
// ---------------------------------------------------------------------------

export interface Disturbance {
  noiseScale: number;
  bias: [number, number];
  untilTick: number;
}

export interface INavigationFilter extends EventProducer {
  /** Generate measurements for every sensor due on `tick` from `truth`, then run the EKF. */
  step(tick: number, truth: PlatformTruth): void;
  setSensorEnabled(id: SensorId, enabled: boolean, tick: number): void;
  setDisturbance(id: SensorId, d: Disturbance, tick: number): void;
  clearDisturbance(id: SensorId, tick: number): void;
  estimate(truth: PlatformTruth): NavEstimate;
  sensorStatuses(): SensorStatus[];
}

// ---------------------------------------------------------------------------
// tracking/ — radar detections and the multi-target tracker
// ---------------------------------------------------------------------------

export interface IRadar extends EventProducer {
  /** True when a scan completes on this tick (every TICK_HZ / scanHz ticks). */
  isScanTick(tick: number): boolean;
  /** Produce detections for a scan; call only when isScanTick(tick). */
  scan(tick: number, platform: PlatformTruth, contacts: readonly WorldContact[]): Detection[];
  setClutterRate(rate: number, untilTick: number): void;
  setPd(pd: number, untilTick: number): void;
  status(tick: number, gate: GateSetting, gateChi2: number): RadarStatus;
}

export interface ITracker extends EventProducer {
  readonly gate: GateSetting;
  readonly gateChi2: number;
  setGate(g: GateSetting, tick: number): void;
  /** Run one association/update cycle with the detections of a completed scan. */
  update(tick: number, detections: Detection[], dtScan: number): void;
  setLabel(trackId: number, label: TrackLabel, tick: number): boolean;
  /** Label every track currently associated with `contactId` (and future ones). */
  applyIntel(contactId: number, label: TrackLabel, tick: number): void;
  tracks(): TrackSnapshot[];
}

// ---------------------------------------------------------------------------
// scenario/
// ---------------------------------------------------------------------------

export interface IScenarioPlayer {
  readonly scenario: Scenario;
  /** Events whose start tick equals `tick`, in authored order. */
  eventsDue(tick: number): ScenarioEvent[];
  phaseAt(time: number): string;
}

// ---------------------------------------------------------------------------
// telemetry/
// ---------------------------------------------------------------------------

export interface TelemetryField {
  name: string;
  /** Column storage type. */
  kind: 'f64' | 'f32' | 'i32' | 'u8';
}

export interface ITelemetryRing {
  readonly fields: readonly TelemetryField[];
  readonly capacity: number;
  readonly length: number;
  /** Total records ever pushed (≥ length). */
  readonly pushed: number;
  /** Append one record. `values` is ordered like `fields`. */
  push(values: ArrayLike<number>, tick: number): void;
  /** Record i, 0 = oldest retained. */
  get(i: number): number[];
  /** Column accessor for plotting: values of `field` for the last `count` records (oldest first). */
  column(field: string, count: number): Float64Array;
  metrics(tick: number): TelemetryMetrics;
  toJSONL(): string;
  toCSV(): string;
  toBinary(): ArrayBuffer;
}
