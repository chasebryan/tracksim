import { describe, expect, it } from 'vitest';
import type { NavEstimate, PlatformTruth, SensorId, SensorStatus } from '../core/types';
import { SENSOR_IDS } from '../core/types';
import {
  TELEMETRY_FIELDS,
  bytesPerRecord,
  buildTelemetryRecord,
  buildTelemetryRecordInto,
  fieldIndex,
  fieldIndexMap,
} from './schema';
import type { TelemetryRecordParts } from './schema';
import { formatTerminalLine } from './format';

/** The contract list, written out in full so a reordering anywhere fails loudly. */
const EXPECTED_FIELDS: [string, string][] = [
  ['tick', 'i32'],
  ['time', 'f64'],
  ['truthE', 'f64'],
  ['truthN', 'f64'],
  ['truthVE', 'f64'],
  ['truthVN', 'f64'],
  ['estE', 'f64'],
  ['estN', 'f64'],
  ['estVE', 'f64'],
  ['estVN', 'f64'],
  ['posError', 'f64'],
  ['velError', 'f64'],
  ['posSigma', 'f64'],
  ['traceP', 'f64'],
  ['INS_nis', 'f32'],
  ['INS_influence', 'f32'],
  ['INS_isolated', 'u8'],
  ['INS_enabled', 'u8'],
  ['STAR_nis', 'f32'],
  ['STAR_influence', 'f32'],
  ['STAR_isolated', 'u8'],
  ['STAR_enabled', 'u8'],
  ['MAGGRAV_nis', 'f32'],
  ['MAGGRAV_influence', 'f32'],
  ['MAGGRAV_isolated', 'u8'],
  ['MAGGRAV_enabled', 'u8'],
  ['TERRAIN_nis', 'f32'],
  ['TERRAIN_influence', 'f32'],
  ['TERRAIN_isolated', 'u8'],
  ['TERRAIN_enabled', 'u8'],
  ['SWARM_nis', 'f32'],
  ['SWARM_influence', 'f32'],
  ['SWARM_isolated', 'u8'],
  ['SWARM_enabled', 'u8'],
  ['tracksTotal', 'i32'],
  ['tracksConfirmed', 'i32'],
  ['detections', 'i32'],
  ['clutter', 'i32'],
  ['radarScan', 'u8'],
  ['tickMicros', 'f32'],
];

function sensor(id: SensorId, overrides: Partial<SensorStatus> = {}): SensorStatus {
  return {
    id,
    name: id,
    rateHz: 100,
    enabled: true,
    lastNis: 1.5,
    meanNis: 1.2,
    gateChi2: 9.21,
    accepted: 10,
    rejected: 1,
    consecutiveRejects: 0,
    isolated: false,
    influence: 0.05,
    meanInfluence: 0.04,
    noiseScale: 1,
    bias: [0, 0],
    disturbanceUntilTick: NaN,
    ...overrides,
  };
}

function parts(overrides: Partial<TelemetryRecordParts> = {}): TelemetryRecordParts {
  const truth: PlatformTruth = {
    pos: [1001, 2002],
    vel: [30.5, -40.25],
    heading: 2.5,
    speed: 50.3,
    alt: 3000,
    turnRate: 0,
    accel: 0,
  };
  const cov = new Float64Array(16);
  cov[0] = 100;
  cov[5] = 200;
  cov[10] = 3;
  cov[15] = 4;
  cov[1] = 999; // off-diagonal must not leak into traceP
  const nav: NavEstimate = {
    pos: [1010, 1990],
    vel: [31, -39],
    heading: 2.4,
    speed: 49.7,
    cov,
    posSigma: 12.25,
    velSigma: 1.87,
    posError: 15.03,
    velError: 1.6,
    headingError: 0.1,
  };
  return {
    tick: 1234,
    time: 12.34,
    truth,
    nav,
    sensors: SENSOR_IDS.map((id) => sensor(id)),
    tracksTotal: 4,
    tracksConfirmed: 3,
    detections: 7,
    clutter: 2,
    radarScan: true,
    tickMicros: 87.5,
    ...overrides,
  };
}

describe('TELEMETRY_FIELDS', () => {
  it('matches the contract list exactly, in order', () => {
    expect(TELEMETRY_FIELDS.map((f) => [f.name, f.kind])).toEqual(EXPECTED_FIELDS);
    expect(TELEMETRY_FIELDS).toHaveLength(40);
  });

  it('has unique names and a cached index map', () => {
    const map = fieldIndexMap(TELEMETRY_FIELDS);
    expect(map.size).toBe(TELEMETRY_FIELDS.length);
    expect(map.get('tick')).toBe(0);
    expect(map.get('tickMicros')).toBe(39);
    expect(fieldIndexMap(TELEMETRY_FIELDS)).toBe(map);
    expect(fieldIndex('traceP')).toBe(13);
    expect(fieldIndex('nope')).toBe(-1);
    expect(() => fieldIndexMap([{ name: 'a', kind: 'u8' }, { name: 'a', kind: 'f64' }])).toThrow(/duplicate/);
  });
});

describe('bytesPerRecord', () => {
  it('sums the storage kinds', () => {
    // 1 i32 + 13 f64 + 5 × (f32 + f32 + u8 + u8) + 4 i32 + u8 + f32 = 4 + 104 + 50 + 16 + 1 + 4
    expect(bytesPerRecord(TELEMETRY_FIELDS)).toBe(179);
    expect(bytesPerRecord([])).toBe(0);
    expect(
      bytesPerRecord([
        { name: 'a', kind: 'f64' },
        { name: 'b', kind: 'f32' },
        { name: 'c', kind: 'i32' },
        { name: 'd', kind: 'u8' },
      ]),
    ).toBe(17);
  });
});

describe('buildTelemetryRecord', () => {
  const at = (rec: ArrayLike<number>, name: string): number => rec[fieldIndex(name)] as number;

  it('places every value at the index of its field', () => {
    const rec = buildTelemetryRecord(parts());
    expect(rec).toBeInstanceOf(Float64Array);
    expect(rec).toHaveLength(TELEMETRY_FIELDS.length);
    expect(at(rec, 'tick')).toBe(1234);
    expect(at(rec, 'time')).toBe(12.34);
    expect(at(rec, 'truthE')).toBe(1001);
    expect(at(rec, 'truthN')).toBe(2002);
    expect(at(rec, 'truthVE')).toBe(30.5);
    expect(at(rec, 'truthVN')).toBe(-40.25);
    expect(at(rec, 'estE')).toBe(1010);
    expect(at(rec, 'estN')).toBe(1990);
    expect(at(rec, 'estVE')).toBe(31);
    expect(at(rec, 'estVN')).toBe(-39);
    expect(at(rec, 'posError')).toBe(15.03);
    expect(at(rec, 'velError')).toBe(1.6);
    expect(at(rec, 'posSigma')).toBe(12.25);
    expect(at(rec, 'traceP')).toBe(307);
    expect(at(rec, 'tracksTotal')).toBe(4);
    expect(at(rec, 'tracksConfirmed')).toBe(3);
    expect(at(rec, 'detections')).toBe(7);
    expect(at(rec, 'clutter')).toBe(2);
    expect(at(rec, 'radarScan')).toBe(1);
    expect(at(rec, 'tickMicros')).toBe(87.5);
  });

  it('lays sensors out in SENSOR_IDS order regardless of input order', () => {
    const sensors: SensorStatus[] = [
      sensor('SWARM', { lastNis: 5, influence: 0.5, isolated: true, enabled: true }),
      sensor('INS', { lastNis: 1, influence: 0.1, isolated: false, enabled: true }),
      sensor('TERRAIN', { lastNis: 41, influence: 0, isolated: true, enabled: false }),
      sensor('STAR', { lastNis: 2, influence: 0.2, isolated: false, enabled: false }),
      sensor('MAGGRAV', { lastNis: 3, influence: 0.3, isolated: false, enabled: true }),
    ];
    const rec = buildTelemetryRecord(parts({ sensors, radarScan: false }));
    expect(at(rec, 'INS_nis')).toBe(1);
    expect(at(rec, 'INS_influence')).toBeCloseTo(0.1, 12);
    expect(at(rec, 'INS_isolated')).toBe(0);
    expect(at(rec, 'INS_enabled')).toBe(1);
    expect(at(rec, 'STAR_nis')).toBe(2);
    expect(at(rec, 'STAR_enabled')).toBe(0);
    expect(at(rec, 'MAGGRAV_nis')).toBe(3);
    expect(at(rec, 'TERRAIN_nis')).toBe(41);
    expect(at(rec, 'TERRAIN_isolated')).toBe(1);
    expect(at(rec, 'TERRAIN_enabled')).toBe(0);
    expect(at(rec, 'SWARM_nis')).toBe(5);
    expect(at(rec, 'SWARM_influence')).toBeCloseTo(0.5, 12);
    expect(at(rec, 'SWARM_isolated')).toBe(1);
    expect(at(rec, 'radarScan')).toBe(0);
    // sensor block is exactly fields 14..33
    expect(fieldIndex('INS_nis')).toBe(14);
    expect(fieldIndex('SWARM_enabled')).toBe(33);
  });

  it('fills a missing sensor with NaN NIS and zero flags', () => {
    const rec = buildTelemetryRecord(parts({ sensors: [sensor('INS')] }));
    expect(at(rec, 'INS_nis')).toBe(1.5);
    expect(at(rec, 'STAR_nis')).toBeNaN();
    expect(at(rec, 'STAR_influence')).toBe(0);
    expect(at(rec, 'STAR_isolated')).toBe(0);
    expect(at(rec, 'STAR_enabled')).toBe(0);
  });

  it('buildTelemetryRecordInto reuses the caller buffer and rejects short ones', () => {
    const out = new Float64Array(TELEMETRY_FIELDS.length);
    expect(buildTelemetryRecordInto(parts(), out)).toBe(out);
    expect(out[0]).toBe(1234);
    expect(() => buildTelemetryRecordInto(parts(), new Float64Array(3))).toThrow(/slots/);
  });
});

describe('formatTerminalLine', () => {
  const lines = [
    buildTelemetryRecord(parts()),
    buildTelemetryRecord(parts({ time: 0, tracksTotal: 0, tracksConfirmed: 0, detections: 0, clutter: 0 })),
    buildTelemetryRecord(
      parts({
        time: 299.99,
        nav: { ...parts().nav, posError: 1234.5, posSigma: 0.04 },
        sensors: [
          sensor('INS', { lastNis: NaN }),
          sensor('STAR', { enabled: false }),
          sensor('MAGGRAV', { lastNis: 999.94 }),
          sensor('TERRAIN', { lastNis: 41.02, isolated: true }),
          sensor('SWARM', { lastNis: 2.04 }),
        ],
        tracksTotal: 123,
        tracksConfirmed: 99,
        detections: 250,
        clutter: 12,
      }),
    ),
    buildTelemetryRecord(parts({ nav: { ...parts().nav, posError: 123456, posSigma: NaN } })),
  ].map((rec) => formatTerminalLine(Array.from(rec), TELEMETRY_FIELDS));

  it('has a stable width across records', () => {
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it('renders the documented layout', () => {
    expect(lines[0]).toBe(
      'T+00:12.34 | err   15.0m σ   12.3m | INS   1.5  STAR   1.5  MAG   1.5  TER   1.5  SWR   1.5  | trk   4/  3 det   7 clt   2',
    );
    expect(lines[1]).toMatch(/^T\+00:00\.00 \| /);
    expect(lines[1]).toMatch(/trk {3}0\/ {2}0 det {3}0 clt {3}0$/);
  });

  it('marks isolated, disabled and unavailable sensors', () => {
    const l = lines[2] as string;
    expect(l).toContain('T+04:59.99');
    expect(l).toContain('err 1234.5m');
    expect(l).toContain('σ    0.0m');
    expect(l).toContain('INS    --');
    expect(l).toContain('STAR   off');
    expect(l).toContain('MAG 999.9');
    expect(l).toContain('TER  41.0!');
    expect(l).toContain('SWR   2.0 ');
    expect(l).toContain('trk 123/ 99 det 250 clt  12');
  });

  it('never widens a cell that overflows', () => {
    expect(lines[3]).toContain('err ######m σ     --m');
  });

  it('works with a reduced schema and missing columns', () => {
    const fields = [
      { name: 'time', kind: 'f64' as const },
      { name: 'posError', kind: 'f64' as const },
    ];
    const line = formatTerminalLine([65.5, 3.14159], fields);
    expect(line).toBe('T+01:05.50 | err    3.1m σ     --m | trk  --/ -- det  -- clt  --');
  });
});
