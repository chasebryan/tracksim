import { describe, expect, it } from 'vitest';
import type { TelemetryField } from '../core/interfaces';
import { DT, TICK_HZ } from '../core/constants';
import { Rng } from '../core/rng';
import { TelemetryRing } from './ring';
import { TELEMETRY_FIELDS, buildTelemetryRecord, fieldIndex } from './schema';
import { decodeBinary } from './encoders';
import { formatTerminalLine } from './format';

/**
 * Reviewer probes. Everything here uses a zero clock and fixed seeds, so the
 * assertions are exact (integers, bit-identical strings/bytes) unless a
 * tolerance is stated inline.
 */

const SMALL_FIELDS: TelemetryField[] = [
  { name: 'tick', kind: 'i32' },
  { name: 'x', kind: 'f64' },
  { name: 'y', kind: 'f32' },
  { name: 'flag', kind: 'u8' },
];

describe('review: orchestrator push cadence', () => {
  it('reports 100 records/s for the real pipeline: one push at tick 0, then one per step', () => {
    // core/simulation.ts pushes in its constructor (tick 0) and once per step() at the new tick.
    const ring = new TelemetryRing(SMALL_FIELDS, 1000, () => 0);
    ring.push([0, 0, 0, 0], 0);
    expect(ring.metrics(0).recordsPerSec).toBe(1);
    for (let t = 1; t <= 99; t++) ring.push([t, 0, 0, 0], t);
    // ticks 0..99 all lie in (-1, 99]
    expect(ring.metrics(99).recordsPerSec).toBe(TICK_HZ);
    for (let t = 100; t <= 250; t++) {
      ring.push([t, 0, 0, 0], t);
      expect(ring.metrics(t).recordsPerSec).toBe(TICK_HZ);
    }
    // a stall (no pushes for 30 ticks) is visible immediately at the current tick
    expect(ring.metrics(280).recordsPerSec).toBe(70);
  });

  it('metrics on an empty ring are all zero', () => {
    const ring = new TelemetryRing(TELEMETRY_FIELDS, 10, () => 0);
    expect(ring.metrics(0)).toEqual({
      records: 0,
      capacity: 10,
      utilization: 0,
      recordsPerSec: 0,
      lastPushMicros: 0,
      meanPushMicros: 0,
      bytesPerRecord: 179,
      totalBytes: 0,
    });
  });
});

describe('review: ring index arithmetic', () => {
  it('column() window that straddles the physical wrap boundary is ordered oldest first', () => {
    // capacity 6, pushes 0..9 -> head = 4; retained ticks 4..9 occupy slots 4,5,0,1,2,3.
    // A 5-wide window starts at retained record 1 (slot 5) and crosses slot 5 -> 0.
    const ring = new TelemetryRing(SMALL_FIELDS, 6, () => 0);
    for (let t = 0; t < 10; t++) ring.push([t, t, t, 0], t);
    expect(Array.from(ring.column('tick', 5))).toEqual([5, 6, 7, 8, 9]);
    expect(Array.from(ring.column('tick', 6))).toEqual([4, 5, 6, 7, 8, 9]);
    expect(Array.from(ring.column('tick', 1))).toEqual([9]);
    // get() agrees with column() for every retained index
    for (let i = 0; i < ring.length; i++) expect(ring.get(i)[0]).toBe(4 + i);
  });

  it('a second wrap of exactly `capacity` pushes leaves head where it started', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 4, () => 0);
    for (let t = 0; t < 12; t++) ring.push([t, 0, 0, 0], t);
    expect(ring.length).toBe(4);
    expect(ring.pushed).toBe(12);
    expect(ring.get(0)[0]).toBe(8);
    expect(ring.get(3)[0]).toBe(11);
  });
});

describe('review: export fidelity and determinism', () => {
  const EXTREME: TelemetryField[] = [
    { name: 'a', kind: 'f64' },
    { name: 'b', kind: 'f64' },
    { name: 'c', kind: 'i32' },
    { name: 'd', kind: 'u8' },
  ];
  const VALUES: number[][] = [
    [1e21, 5e-324, 2 ** 31 - 1, 255],
    [-1.7976931348623157e308, 123456789.123456789, -(2 ** 31), 0],
    [-0, 0.1 + 0.2, -1, 128],
    [Math.PI, 1e-7, 42, 7],
  ];

  function fill(): TelemetryRing {
    const ring = new TelemetryRing(EXTREME, 8, () => 0);
    VALUES.forEach((v, t) => ring.push(v, t));
    return ring;
  }

  it('JSONL and CSV reproduce every stored f64 bit-exactly (String -> JSON.parse/Number)', () => {
    const ring = fill();
    const jsonl = ring.toJSONL().split('\n').filter((l) => l.length > 0);
    const csv = ring.toCSV().split('\n').filter((l) => l.length > 0).slice(1);
    expect(jsonl).toHaveLength(VALUES.length);
    expect(csv).toHaveLength(VALUES.length);
    // Text formats cannot carry the sign of zero (String(-0) === '0', like JSON.stringify), so signed
    // zero is normalised on both sides; every other value must be bit-exact.
    const norm = (v: number): number => (v === 0 ? 0 : v);
    for (let r = 0; r < VALUES.length; r++) {
      const stored = ring.get(r).map(norm);
      const obj = JSON.parse(jsonl[r] as string) as Record<string, number>;
      expect(Object.values(obj).map(norm)).toEqual(stored);
      expect((csv[r] as string).split(',').map(Number).map(norm)).toEqual(stored);
      if (r === 2) {
        expect(Object.is(ring.get(2)[0], -0)).toBe(true);
        expect(Object.is(obj.a, 0)).toBe(true);
      }
    }
  });

  it('binary round-trip is bit-exact for the extreme f64/i32/u8 values', () => {
    const ring = fill();
    const decoded = decodeBinary(ring.toBinary());
    for (let r = 0; r < VALUES.length; r++) expect(decoded.records[r]).toEqual(ring.get(r));
    expect(Object.is((decoded.records[2] as number[])[0], -0)).toBe(true);
  });

  it('two rings fed the same seeded stream produce byte-identical exports', () => {
    const make = (): TelemetryRing => {
      const rng = Rng.fromLabel(11, 'review');
      const ring = new TelemetryRing(TELEMETRY_FIELDS, 128, () => 0);
      const rec = new Float64Array(TELEMETRY_FIELDS.length);
      for (let t = 0; t < 300; t++) {
        for (let f = 0; f < rec.length; f++) rec[f] = rng.uniform(-1e3, 1e3);
        rec[0] = t;
        ring.push(rec, t);
      }
      return ring;
    };
    const a = make();
    const b = make();
    expect(a.toJSONL()).toBe(b.toJSONL());
    expect(a.toCSV()).toBe(b.toCSV());
    expect(new Uint8Array(a.toBinary())).toEqual(new Uint8Array(b.toBinary()));
  });

  it('decodeBinary rejects trailing bytes and a header length that disagrees with the payload', () => {
    const ring = fill();
    const good = ring.toBinary();
    const padded = new Uint8Array(good.byteLength + 1);
    padded.set(new Uint8Array(good));
    expect(() => decodeBinary(padded)).toThrow(/expected/);

    // Rewrite the header's `length` from 4 to 3 without changing the payload.
    const view = new DataView(good);
    const headerLen = view.getUint32(8, true);
    const headerText = String.fromCharCode(...new Uint8Array(good, 12, headerLen));
    const tampered = headerText.replace('"length":4', '"length":3');
    expect(tampered).not.toBe(headerText);
    const out = new Uint8Array(good.byteLength);
    out.set(new Uint8Array(good));
    for (let i = 0; i < headerLen; i++) out[12 + i] = tampered.charCodeAt(i);
    expect(() => decodeBinary(out)).toThrow(/expected/);
  });
});

describe('review: terminal clock is immune to tick*DT float noise', () => {
  it('formats T+mm:ss.cc from integer tick arithmetic for every tick of a 300 s run', () => {
    // `time` reaches the formatter as tick * DT (e.g. 29 * 0.01 = 0.29000000000000004); the
    // rendered centiseconds must equal the integer tick for all 30 001 ticks.
    const fields: TelemetryField[] = [{ name: 'time', kind: 'f64' }];
    for (let tick = 0; tick <= 30_000; tick++) {
      const mm = Math.floor(tick / 6000);
      const ss = Math.floor((tick % 6000) / 100);
      const cc = tick % 100;
      const expected = `T+${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
      const line = formatTerminalLine([tick * DT], fields);
      if (!line.startsWith(expected)) {
        throw new Error(`tick ${tick}: got "${line.slice(0, 10)}", expected "${expected}"`);
      }
    }
  });

  it('renders a canonical record retrieved from the ring identically to the freshly built record', () => {
    const rec = buildTelemetryRecord({
      tick: 4321,
      time: 43.21,
      truth: { pos: [1, 2], vel: [3, 4], heading: 0, speed: 5, alt: 0, turnRate: 0, accel: 0 },
      nav: {
        pos: [1, 2],
        vel: [3, 4],
        heading: 0,
        speed: 5,
        cov: new Float64Array(16),
        posSigma: 7.75,
        velSigma: 0,
        posError: 3.25,
        velError: 0,
        headingError: 0,
      },
      sensors: [],
      tracksTotal: 2,
      tracksConfirmed: 1,
      detections: 3,
      clutter: 0,
      radarScan: false,
      tickMicros: 12.5,
    });
    const ring = new TelemetryRing(TELEMETRY_FIELDS, 4, () => 0);
    ring.push(rec, 4321);
    expect(formatTerminalLine(ring.get(0), ring.fields)).toBe(formatTerminalLine(rec, TELEMETRY_FIELDS));
    // missing sensors render as disabled ("off"), not as NaN
    expect(formatTerminalLine(ring.get(0), ring.fields)).toContain('INS   off');
    expect(ring.get(0)[fieldIndex('INS_enabled')]).toBe(0);
  });
});
