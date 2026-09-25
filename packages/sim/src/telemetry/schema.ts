/**
 * Telemetry record schema: the ordered list of columns every record carries,
 * the byte cost of each column kind, and a builder that lays a record out in
 * schema order so the orchestrator cannot get the layout wrong.
 */
import type { TelemetryField } from '../core/interfaces';
import { SENSOR_IDS } from '../core/types';
import type { NavEstimate, PlatformTruth, SensorId, SensorStatus } from '../core/types';

export type TelemetryKind = TelemetryField['kind'];

/** Storage size of one value of each column kind, in bytes. */
export const KIND_BYTES: Readonly<Record<TelemetryKind, number>> = { f64: 8, f32: 4, i32: 4, u8: 1 };

/** Per-sensor column suffixes, in the order they appear after `<ID>_`. */
export const SENSOR_FIELD_SUFFIXES = ['nis', 'influence', 'isolated', 'enabled'] as const;

function sensorFields(id: SensorId): TelemetryField[] {
  return [
    { name: `${id}_nis`, kind: 'f32' },
    { name: `${id}_influence`, kind: 'f32' },
    { name: `${id}_isolated`, kind: 'u8' },
    { name: `${id}_enabled`, kind: 'u8' },
  ];
}

/**
 * The canonical telemetry schema, in record order:
 * platform truth and navigation estimate, filter integrity, four columns per
 * sensor in `SENSOR_IDS` order, then tracker/radar counts and tick cost.
 */
export const TELEMETRY_FIELDS: readonly TelemetryField[] = Object.freeze([
  { name: 'tick', kind: 'i32' },
  { name: 'time', kind: 'f64' },
  { name: 'truthE', kind: 'f64' },
  { name: 'truthN', kind: 'f64' },
  { name: 'truthVE', kind: 'f64' },
  { name: 'truthVN', kind: 'f64' },
  { name: 'estE', kind: 'f64' },
  { name: 'estN', kind: 'f64' },
  { name: 'estVE', kind: 'f64' },
  { name: 'estVN', kind: 'f64' },
  { name: 'posError', kind: 'f64' },
  { name: 'velError', kind: 'f64' },
  { name: 'posSigma', kind: 'f64' },
  { name: 'traceP', kind: 'f64' },
  ...SENSOR_IDS.flatMap(sensorFields),
  { name: 'tracksTotal', kind: 'i32' },
  { name: 'tracksConfirmed', kind: 'i32' },
  { name: 'detections', kind: 'i32' },
  { name: 'clutter', kind: 'i32' },
  { name: 'radarScan', kind: 'u8' },
  { name: 'tickMicros', kind: 'f32' },
] as TelemetryField[]);

/** Bytes needed to store one record of `fields` (sum of the column kinds). */
export function bytesPerRecord(fields: readonly TelemetryField[]): number {
  let total = 0;
  for (let i = 0; i < fields.length; i++) total += KIND_BYTES[(fields[i] as TelemetryField).kind];
  return total;
}

const indexCache = new WeakMap<readonly TelemetryField[], ReadonlyMap<string, number>>();

/**
 * Name → column index for a field list. Cached per array identity, so hot
 * callers (the terminal formatter, the HUD series extractor) pay for the map
 * once per schema instead of once per record.
 */
export function fieldIndexMap(fields: readonly TelemetryField[]): ReadonlyMap<string, number> {
  const cached = indexCache.get(fields);
  if (cached) return cached;
  const map = new Map<string, number>();
  for (let i = 0; i < fields.length; i++) {
    const name = (fields[i] as TelemetryField).name;
    if (map.has(name)) throw new Error(`telemetry: duplicate field name "${name}"`);
    map.set(name, i);
  }
  indexCache.set(fields, map);
  return map;
}

/** Column index of `name` in the canonical schema, or -1. */
export function fieldIndex(name: string, fields: readonly TelemetryField[] = TELEMETRY_FIELDS): number {
  const i = fieldIndexMap(fields).get(name);
  return i === undefined ? -1 : i;
}

/** Everything a record is built from, straight out of the tick pipeline. */
export interface TelemetryRecordParts {
  tick: number;
  time: number;
  truth: PlatformTruth;
  nav: NavEstimate;
  /** Any order; sensors are located by id and laid out in `SENSOR_IDS` order. */
  sensors: readonly SensorStatus[];
  tracksTotal: number;
  tracksConfirmed: number;
  detections: number;
  clutter: number;
  /** True when a radar scan completed on this tick. */
  radarScan: boolean;
  /** Wall-clock cost of the tick in microseconds (0 when unavailable). */
  tickMicros: number;
}

// Fixed offsets of the canonical layout; the sensor block starts after the 14 nav columns.
const SENSOR_BLOCK_START = 14;
const SENSOR_BLOCK_WIDTH = SENSOR_FIELD_SUFFIXES.length;
const TAIL_START = SENSOR_BLOCK_START + SENSOR_IDS.length * SENSOR_BLOCK_WIDTH;

function findSensor(sensors: readonly SensorStatus[], id: SensorId): SensorStatus | undefined {
  for (let i = 0; i < sensors.length; i++) {
    const s = sensors[i] as SensorStatus;
    if (s.id === id) return s;
  }
  return undefined;
}

/**
 * Write a record for `parts` into `out` (length ≥ `TELEMETRY_FIELDS.length`)
 * in canonical order and return it. `traceP` is the trace of the 4×4
 * navigation covariance. Per sensor: the most recent NIS (`lastNis`, NaN
 * before the first measurement), the influence of the last accepted update
 * (`influence`), and the isolated/enabled flags as 0/1. A sensor missing from
 * `parts.sensors` is written as NaN NIS, 0 influence, not isolated, disabled.
 */
export function buildTelemetryRecordInto(parts: TelemetryRecordParts, out: Float64Array): Float64Array {
  if (out.length < TELEMETRY_FIELDS.length) {
    throw new Error(`buildTelemetryRecord: out has ${out.length} slots, need ${TELEMETRY_FIELDS.length}`);
  }
  const { truth, nav } = parts;
  const cov = nav.cov;
  out[0] = parts.tick;
  out[1] = parts.time;
  out[2] = truth.pos[0];
  out[3] = truth.pos[1];
  out[4] = truth.vel[0];
  out[5] = truth.vel[1];
  out[6] = nav.pos[0];
  out[7] = nav.pos[1];
  out[8] = nav.vel[0];
  out[9] = nav.vel[1];
  out[10] = nav.posError;
  out[11] = nav.velError;
  out[12] = nav.posSigma;
  out[13] = (cov[0] as number) + (cov[5] as number) + (cov[10] as number) + (cov[15] as number);
  for (let s = 0; s < SENSOR_IDS.length; s++) {
    const base = SENSOR_BLOCK_START + s * SENSOR_BLOCK_WIDTH;
    const status = findSensor(parts.sensors, SENSOR_IDS[s] as SensorId);
    if (status) {
      out[base] = status.lastNis;
      out[base + 1] = status.influence;
      out[base + 2] = status.isolated ? 1 : 0;
      out[base + 3] = status.enabled ? 1 : 0;
    } else {
      out[base] = NaN;
      out[base + 1] = 0;
      out[base + 2] = 0;
      out[base + 3] = 0;
    }
  }
  out[TAIL_START] = parts.tracksTotal;
  out[TAIL_START + 1] = parts.tracksConfirmed;
  out[TAIL_START + 2] = parts.detections;
  out[TAIL_START + 3] = parts.clutter;
  out[TAIL_START + 4] = parts.radarScan ? 1 : 0;
  out[TAIL_START + 5] = parts.tickMicros;
  return out;
}

/** Allocate and fill a record laid out per `TELEMETRY_FIELDS`. */
export function buildTelemetryRecord(parts: TelemetryRecordParts): Float64Array {
  return buildTelemetryRecordInto(parts, new Float64Array(TELEMETRY_FIELDS.length));
}
