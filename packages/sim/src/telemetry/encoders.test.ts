import { describe, expect, it } from 'vitest';
import type { TelemetryField } from '../core/interfaces';
import { Rng } from '../core/rng';
import { TelemetryRing } from './ring';
import { TELEMETRY_FIELDS, bytesPerRecord } from './schema';
import { decodeBinary, encodeBinary, TELEMETRY_BINARY_MAGIC, TELEMETRY_BINARY_VERSION } from './encoders';

const MIXED_FIELDS: TelemetryField[] = [
  { name: 'tick', kind: 'i32' },
  { name: 'pos', kind: 'f64' },
  { name: 'nis', kind: 'f32' },
  { name: 'flag', kind: 'u8' },
  { name: 'neg', kind: 'i32' },
];

/** Seeded ring with `n` pushes of varied magnitudes, including negatives and non-integers. */
function filledRing(fields: readonly TelemetryField[], capacity: number, n: number, seed = 7): TelemetryRing {
  const rng = Rng.fromLabel(seed, 'telemetry-test');
  const ring = new TelemetryRing(fields, capacity, () => 0);
  const rec = new Array<number>(fields.length);
  for (let t = 0; t < n; t++) {
    for (let f = 0; f < fields.length; f++) {
      const kind = (fields[f] as TelemetryField).kind;
      rec[f] =
        kind === 'u8' ? rng.int(0, 256) : kind === 'i32' ? rng.int(-1_000_000, 1_000_000) : rng.uniform(-5e4, 5e4) * Math.exp(rng.uniform(-6, 6));
    }
    rec[0] = t;
    ring.push(rec, t);
  }
  return ring;
}

describe('toJSONL', () => {
  it('emits one valid JSON object per line keyed by field name, oldest first', () => {
    const ring = filledRing(MIXED_FIELDS, 8, 5);
    const text = ring.toJSONL();
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    lines.forEach((line, i) => {
      const obj = JSON.parse(line) as Record<string, number>;
      expect(Object.keys(obj)).toEqual(MIXED_FIELDS.map((f) => f.name));
      expect(Object.values(obj)).toEqual(ring.get(i));
    });
  });

  it('reflects wrap-around and encodes non-finite values as null', () => {
    const ring = new TelemetryRing(MIXED_FIELDS, 2, () => 0);
    ring.push([0, 1, 1, 1, 1], 0);
    ring.push([1, NaN, Infinity, 2, 2], 1);
    ring.push([2, -Infinity, 0.5, 3, 3], 2);
    const lines = ring.toJSONL().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({ tick: 1, pos: null, nis: null, flag: 2, neg: 2 });
    expect(JSON.parse(lines[1] as string)).toEqual({ tick: 2, pos: null, nis: 0.5, flag: 3, neg: 3 });
  });

  it('is empty for an empty ring', () => {
    expect(new TelemetryRing(MIXED_FIELDS, 4, () => 0).toJSONL()).toBe('');
  });
});

describe('toCSV', () => {
  it('has a header row of field names and one row per record', () => {
    const ring = filledRing(TELEMETRY_FIELDS, 50, 120);
    const lines = ring.toCSV().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe(TELEMETRY_FIELDS.map((f) => f.name).join(','));
    for (let i = 1; i < lines.length; i++) {
      const cells = (lines[i] as string).split(',');
      expect(cells).toHaveLength(TELEMETRY_FIELDS.length);
      expect(cells.map(Number)).toEqual(ring.get(i - 1));
    }
  });

  it('writes NaN literally and quotes awkward header names', () => {
    const ring = new TelemetryRing([{ name: 'a,b', kind: 'f64' }, { name: 'c', kind: 'f32' }], 2, () => 0);
    ring.push([NaN, 1], 0);
    expect(ring.toCSV()).toBe('"a,b",c\nNaN,1\n');
  });

  it('is header-only for an empty ring', () => {
    expect(new TelemetryRing(MIXED_FIELDS, 4, () => 0).toCSV()).toBe('tick,pos,nis,flag,neg\n');
  });
});

describe('toBinary / decodeBinary', () => {
  it('starts with the TSIM magic, version 1 and a JSON header', () => {
    const ring = filledRing(MIXED_FIELDS, 8, 3);
    const buf = ring.toBinary();
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe(TELEMETRY_BINARY_MAGIC);
    expect(TELEMETRY_BINARY_MAGIC).toBe('TSIM');
    expect(view.getUint32(4, true)).toBe(TELEMETRY_BINARY_VERSION);
    expect(TELEMETRY_BINARY_VERSION).toBe(1);
    const headerLen = view.getUint32(8, true);
    const headerText = String.fromCharCode(...bytes.subarray(12, 12 + headerLen));
    expect(JSON.parse(headerText)).toEqual({ fields: MIXED_FIELDS, capacity: 8, length: 3, pushed: 3 });
    expect(buf.byteLength).toBe(12 + headerLen + bytesPerRecord(MIXED_FIELDS) * 3);
  });

  it('lays each column out contiguously, little-endian, in field order', () => {
    const ring = new TelemetryRing(MIXED_FIELDS, 4, () => 0);
    ring.push([1, 1.5, 0.5, 9, -1], 0);
    ring.push([2, 2.5, 0.25, 8, -2], 1);
    const buf = ring.toBinary();
    const view = new DataView(buf);
    let off = 12 + view.getUint32(8, true);
    expect(view.getInt32(off, true)).toBe(1);
    expect(view.getInt32(off + 4, true)).toBe(2);
    off += 8;
    expect(view.getFloat64(off, true)).toBe(1.5);
    expect(view.getFloat64(off + 8, true)).toBe(2.5);
    off += 16;
    expect(view.getFloat32(off, true)).toBe(0.5);
    expect(view.getFloat32(off + 4, true)).toBe(0.25);
    off += 8;
    expect(view.getUint8(off)).toBe(9);
    expect(view.getUint8(off + 1)).toBe(8);
    off += 2;
    expect(view.getInt32(off, true)).toBe(-1);
    expect(view.getInt32(off + 4, true)).toBe(-2);
    expect(off + 8).toBe(buf.byteLength);
  });

  it('round-trips exactly for f64/i32/u8 and within float32 precision for f32', () => {
    const ring = filledRing(MIXED_FIELDS, 64, 100);
    const originals: number[][] = [];
    // Re-generate the pre-storage inputs so the f32 tolerance is checked against what was pushed,
    // not against the already-rounded stored value.
    const rng = Rng.fromLabel(7, 'telemetry-test');
    for (let t = 0; t < 100; t++) {
      const rec = new Array<number>(MIXED_FIELDS.length);
      for (let f = 0; f < MIXED_FIELDS.length; f++) {
        const kind = (MIXED_FIELDS[f] as TelemetryField).kind;
        rec[f] =
          kind === 'u8' ? rng.int(0, 256) : kind === 'i32' ? rng.int(-1_000_000, 1_000_000) : rng.uniform(-5e4, 5e4) * Math.exp(rng.uniform(-6, 6));
      }
      rec[0] = t;
      originals.push(rec);
    }
    const decoded = decodeBinary(ring.toBinary());
    expect(decoded.fields).toEqual(MIXED_FIELDS);
    expect(decoded.records).toHaveLength(64);
    expect(decoded.capacity).toBe(64);
    expect(decoded.pushed).toBe(100);
    for (let i = 0; i < 64; i++) {
      const orig = originals[36 + i] as number[];
      const rec = decoded.records[i] as number[];
      expect(rec[0]).toBe(orig[0]); // i32
      expect(rec[1]).toBe(orig[1]); // f64 bit-exact
      expect(rec[3]).toBe(orig[3]); // u8
      expect(rec[4]).toBe(orig[4]); // i32 negative
      // f32: stored value is the nearest single, so decoded === fround(original) and the relative
      // error is at most half an ulp of a 24-bit significand (2^-24); assert a full ulp to be safe.
      const v = orig[2] as number;
      expect(rec[2]).toBe(Math.fround(v));
      expect(Math.abs((rec[2] as number) - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -23);
      // and it equals what the ring itself reports
      expect(rec).toEqual(ring.get(i));
    }
  });

  it('round-trips the canonical schema after wrap-around', () => {
    const ring = filledRing(TELEMETRY_FIELDS, 300, 1000);
    const decoded = decodeBinary(ring.toBinary());
    expect(decoded.fields).toEqual(TELEMETRY_FIELDS);
    expect(decoded.records).toHaveLength(300);
    for (let i = 0; i < 300; i++) expect(decoded.records[i]).toEqual(ring.get(i));
    expect((decoded.records[0] as number[])[0]).toBe(700);
  });

  it('round-trips an empty ring and non-ASCII field names', () => {
    const fields: TelemetryField[] = [{ name: 'σ_pos', kind: 'f64' }, { name: '温度', kind: 'u8' }, { name: 'e\u{1F680}', kind: 'i32' }];
    const empty = new TelemetryRing(fields, 4, () => 0);
    expect(decodeBinary(empty.toBinary())).toEqual({ fields, records: [], capacity: 4, pushed: 0 });
    empty.push([1.25, 2, 3], 0);
    expect(decodeBinary(empty.toBinary()).records).toEqual([[1.25, 2, 3]]);
  });

  it('accepts a Uint8Array view over the same bytes', () => {
    const ring = filledRing(MIXED_FIELDS, 4, 4);
    const buf = ring.toBinary();
    const padded = new Uint8Array(buf.byteLength + 6);
    padded.set(new Uint8Array(buf), 3);
    const view = new Uint8Array(padded.buffer, 3, buf.byteLength);
    expect(decodeBinary(view).records).toEqual(decodeBinary(buf).records);
  });

  it('rejects a bad magic, an unknown version, a truncated body and a corrupt header', () => {
    const ring = filledRing(MIXED_FIELDS, 4, 4);
    const good = ring.toBinary();

    const badMagic = good.slice(0);
    new Uint8Array(badMagic)[0] = 'X'.charCodeAt(0);
    expect(() => decodeBinary(badMagic)).toThrow(/bad magic/);

    const badVersion = good.slice(0);
    new DataView(badVersion).setUint32(4, 2, true);
    expect(() => decodeBinary(badVersion)).toThrow(/unsupported version 2/);

    expect(() => decodeBinary(good.slice(0, good.byteLength - 1))).toThrow(/expected/);
    expect(() => decodeBinary(new ArrayBuffer(4))).toThrow(/too short/);

    const hugeHeader = good.slice(0);
    new DataView(hugeHeader).setUint32(8, 1 << 30, true);
    expect(() => decodeBinary(hugeHeader)).toThrow(/header exceeds/);

    const corruptHeader = good.slice(0);
    new Uint8Array(corruptHeader)[12] = '?'.charCodeAt(0);
    expect(() => decodeBinary(corruptHeader)).toThrow(/valid JSON/);
  });

  it('encodeBinary works on any ColumnarRecords source', () => {
    const src = {
      fields: [{ name: 'a', kind: 'u8' as const }],
      capacity: 2,
      length: 2,
      pushed: 5,
      valueAt: (r: number): number => r + 10,
    };
    const decoded = decodeBinary(encodeBinary(src));
    expect(decoded.records).toEqual([[10], [11]]);
    expect(decoded.pushed).toBe(5);
  });
});
