/**
 * Shared data contracts for the simulation. Everything the HUD sees crosses
 * the worker boundary as a `Snapshot`; everything the operator does crosses
 * back as a `Command`. Both are plain, structured-cloneable data.
 *
 * Coordinate conventions:
 *  - Positions are [east, north] metres in a flat local frame.
 *  - Heading and bearing are radians, 0 = north, clockwise positive
 *    (heading = atan2(vE, vN)).
 *  - Elevation is radians above the horizontal plane.
 */

export type Vec2 = [number, number];

// ---------------------------------------------------------------------------
// Platform & navigation
// ---------------------------------------------------------------------------

export interface PlatformTruth {
  pos: Vec2;
  vel: Vec2;
  heading: number;
  speed: number;
  alt: number;
  /** Commanded turn rate (rad/s) and along-track acceleration (m/s²) currently applied. */
  turnRate: number;
  accel: number;
}

export const SENSOR_IDS = ['INS', 'STAR', 'MAGGRAV', 'TERRAIN', 'SWARM'] as const;
export type SensorId = (typeof SENSOR_IDS)[number];

export interface SensorStatus {
  id: SensorId;
  /** Human label, e.g. "Inertial (speed/heading)". */
  name: string;
  rateHz: number;
  enabled: boolean;
  /** NIS of the most recent measurement (NaN if none yet). */
  lastNis: number;
  /** Exponential moving average of NIS over accepted+rejected measurements. */
  meanNis: number;
  /** Chi-square gate this sensor's measurements are tested against. */
  gateChi2: number;
  accepted: number;
  rejected: number;
  consecutiveRejects: number;
  /** True once consecutiveRejects reaches the isolation threshold; clears on the next accepted measurement. */
  isolated: boolean;
  /** Fractional trace(P) reduction of the last accepted update, [0, 1]. */
  influence: number;
  /** Exponential moving average of influence. This is the honest "weight" readout. */
  meanInfluence: number;
  /** Current disturbance applied by scenario/operator to the *generated* measurement. */
  noiseScale: number;
  bias: Vec2;
  /** Tick on which the disturbance ends (Infinity = until cleared). NaN if none. */
  disturbanceUntilTick: number;
}

export interface NavEstimate {
  pos: Vec2;
  vel: Vec2;
  heading: number;
  speed: number;
  /** 4×4 row-major covariance of [pE, pN, vE, vN]. */
  cov: Float64Array;
  /** sqrt(mean of position-block diagonal), metres. */
  posSigma: number;
  velSigma: number;
  /** Errors against truth (the sim knows truth; the filter does not). */
  posError: number;
  velError: number;
  headingError: number;
}

// ---------------------------------------------------------------------------
// Contacts, radar, tracks
// ---------------------------------------------------------------------------

export type ContactKind = 'vehicle' | 'decoy' | 'beacon';
export type TrackLabel = 'friendly' | 'unknown' | 'hostile' | 'decoy';
export type TrackStatus = 'tentative' | 'confirmed' | 'coasting' | 'dropped';
export type GateSetting = 'loose' | 'normal' | 'strict';

/** Scenario-authored description of an entity in the world (absolute frame). */
export interface ContactSpec {
  id: number;
  kind: ContactKind;
  /** Ground-truth label. Reaches the tracker only if `declared`, via an `intel` event, or via operator command. */
  label: TrackLabel;
  /** Broadcasts its identity (transponder) so detections carry `declaredLabel`. */
  declared: boolean;
  pos: Vec2;
  vel: Vec2;
  elevationDeg: number;
  /** Position random-walk sigma per second (m/√s); decoys use this to look incoherent. */
  jitter: number;
  /** Per-scan detection probability override; defaults by kind if omitted. */
  pd?: number;
  spawnAt?: number;
  despawnAt?: number;
}

export interface ContactSnapshot {
  id: number;
  kind: ContactKind;
  label: TrackLabel;
  /** Relative to platform, world-aligned. */
  pos: Vec2;
  vel: Vec2;
  range: number;
  bearing: number;
  elevation: number;
  alive: boolean;
}

export interface Detection {
  /** Relative to platform, world-aligned, metres. */
  pos: Vec2;
  /** 2×2 row-major measurement covariance. */
  cov: [number, number, number, number];
  elevation: number;
  /** Ground truth for metrics only: originating contact, or null for clutter. */
  contactId: number | null;
  declaredLabel: TrackLabel | null;
}

export interface RadarStatus {
  scanHz: number;
  maxRange: number;
  /** Expected false alarms per scan (Poisson mean). */
  clutterRate: number;
  pd: number;
  detectionsLastScan: number;
  clutterLastScan: number;
  /** Ticks since the last scan completed. */
  ticksSinceScan: number;
  gate: GateSetting;
  gateChi2: number;
}

export interface TrackSnapshot {
  id: number;
  status: TrackStatus;
  label: TrackLabel;
  /** 0..1 — how the label was arrived at: fraction of hits carrying a declaration, or 1 for operator/intel. */
  labelConfidence: number;
  /** 0..1 composite of recent hit ratio and positional certainty. */
  quality: number;
  pos: Vec2;
  vel: Vec2;
  range: number;
  bearing: number;
  elevation: number;
  speed: number;
  ageScans: number;
  hits: number;
  misses: number;
  consecutiveMisses: number;
  posSigma: number;
  /** Ground truth for metrics only: contact this track has mostly been associated with. */
  contactId: number | null;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetryMetrics {
  records: number;
  capacity: number;
  /** records / capacity, 0..1 */
  utilization: number;
  /** Measured over the last second of sim ticks. */
  recordsPerSec: number;
  lastPushMicros: number;
  meanPushMicros: number;
  bytesPerRecord: number;
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Events, snapshot, commands
// ---------------------------------------------------------------------------

export type EventSource = 'scenario' | 'nav' | 'radar' | 'tracking' | 'operator' | 'system';
export type EventLevel = 'info' | 'warn' | 'alert';

export interface SimEvent {
  tick: number;
  time: number;
  source: EventSource;
  level: EventLevel;
  message: string;
}

export interface Snapshot {
  tick: number;
  time: number;
  seed: number;
  scenarioId: string;
  scenarioName: string;
  durationS: number;
  phase: string;
  truth: PlatformTruth;
  nav: NavEstimate;
  sensors: SensorStatus[];
  radar: RadarStatus;
  tracks: TrackSnapshot[];
  contacts: ContactSnapshot[];
  /** Events emitted during this tick only. */
  events: SimEvent[];
  telemetry: TelemetryMetrics;
  /** Wall-clock cost of computing this tick, microseconds (0 when no clock is available). */
  tickMicros: number;
}

export type Command =
  | { type: 'gate'; value: GateSetting }
  | { type: 'sensor.enable'; sensor: SensorId; enabled: boolean }
  | { type: 'sensor.disturb'; sensor: SensorId; noiseScale: number; bias: Vec2; durationS: number }
  | { type: 'sensor.clear'; sensor: SensorId }
  | { type: 'radar.clutter'; rate: number; durationS: number }
  | { type: 'contacts.spawnDecoys'; count: number; nearContactId?: number }
  | { type: 'track.label'; trackId: number; label: TrackLabel }
  | { type: 'log'; message: string };

/** A command as recorded in a session log: applied at the start of `tick`. */
export interface TimedCommand {
  tick: number;
  command: Command;
}

/** Everything needed to reproduce a run exactly. */
export interface Recording {
  version: 1;
  seed: number;
  scenarioId: string;
  commands: TimedCommand[];
  /** Tick at which the recording was stopped. */
  endTick: number;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export type ScenarioEvent =
  | { t: number; type: 'sensor.noise'; sensor: SensorId; scale: number; durationS?: number }
  | { t: number; type: 'sensor.bias'; sensor: SensorId; bias: Vec2; durationS?: number }
  | { t: number; type: 'sensor.enable'; sensor: SensorId; enabled: boolean }
  | { t: number; type: 'platform.turn'; rateDegS: number; durationS: number }
  | { t: number; type: 'platform.accel'; mps2: number; durationS: number }
  | { t: number; type: 'radar.clutter'; rate: number; durationS?: number }
  | { t: number; type: 'radar.pd'; pd: number; durationS?: number }
  | { t: number; type: 'contacts.spawn'; contacts: ContactSpec[] }
  | { t: number; type: 'contact.despawn'; id: number }
  | { t: number; type: 'intel'; contactId: number; label: TrackLabel }
  | { t: number; type: 'log'; message: string; level?: EventLevel };

export interface ScenarioPhase {
  t: number;
  name: string;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  durationS: number;
  /** Default seed when the host does not supply one. */
  seed: number;
  platform: {
    pos: Vec2;
    vel: Vec2;
    alt: number;
  };
  phases: ScenarioPhase[];
  contacts: ContactSpec[];
  events: ScenarioEvent[];
}
