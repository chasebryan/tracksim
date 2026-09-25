import { describe, expect, it } from 'vitest';
import type { TelemetryField } from '../core/interfaces';
import { TICK_HZ } from '../core/constants';
import { TelemetryRing, DEFAULT_TELEMETRY_CAPACITY } from './ring';
import { TELEMETRY_FIELDS, bytesPerRecord } from './schema';

const SMALL_FIELDS: TelemetryField[] = [
  { name: 'tick', kind: 'i32' },
  { name: 'x', kind: 'f64' },
  { name: 'y', kind: 'f32' },
  { name: 'flag', kind: 'u8' },
];

/** A deterministic clock that advances a fixed amount on every read. */
function fakeClock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs);
}

type Hosted = { process?: { memoryUsage(): { heapUsed: number } }; performance?: { now(): number } };
const host = globalThis as unknown as Hosted;

describe('TelemetryRing basics', () => {
  it('defaults to the canonical schema and capacity', () => {
    const ring = new TelemetryRing();
    expect(ring.fields).toBe(TELEMETRY_FIELDS);
    expect(ring.capacity).toBe(DEFAULT_TELEMETRY_CAPACITY);
    expect(ring.capacity).toBe(36_000);
    expect(ring.length).toBe(0);
    expect(ring.pushed).toBe(0);
  });

  it('rejects bad construction arguments and malformed pushes', () => {
    expect(() => new TelemetryRing(SMALL_FIELDS, 0)).toThrow(/capacity/);
    expect(() => new TelemetryRing(SMALL_FIELDS, 2.5)).toThrow(/capacity/);
    expect(() => new TelemetryRing([], 4)).toThrow(/field/);
    const ring = new TelemetryRing(SMALL_FIELDS, 4, () => 0);
    expect(() => ring.push([1, 2, 3], 0)).toThrow(/expected 4 values/);
    expect(() => ring.get(0)).toThrow(RangeError);
  });

  it('push/get/length/pushed', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 8, () => 0);
    ring.push([1, 1.5, 2.5, 1], 1);
    ring.push(new Float64Array([2, -3.25, 0.5, 0]), 2);
    expect(ring.length).toBe(2);
    expect(ring.pushed).toBe(2);
    expect(ring.get(0)).toEqual([1, 1.5, 2.5, 1]);
    expect(ring.get(1)).toEqual([2, -3.25, 0.5, 0]);
    expect(() => ring.get(2)).toThrow(RangeError);
    expect(() => ring.get(-1)).toThrow(RangeError);
  });

  it('stores each column in its declared kind', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 4, () => 0);
    ring.push([7.9, 0.1, 0.1, 300], 0);
    const rec = ring.get(0);
    expect(rec[0]).toBe(7); // i32 truncates
    expect(rec[1]).toBe(0.1); // f64 exact
    expect(rec[2]).toBe(Math.fround(0.1)); // f32 rounds to nearest single
    expect(rec[3]).toBe(300 & 0xff); // u8 wraps
  });
});

describe('TelemetryRing wrap-around', () => {
  it('keeps the newest `capacity` records in order', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 5, () => 0);
    for (let i = 0; i < 13; i++) ring.push([i, i * 10, i, i & 1], i);
    expect(ring.length).toBe(5);
    expect(ring.pushed).toBe(13);
    for (let i = 0; i < 5; i++) {
      const expectedTick = 8 + i;
      expect(ring.get(i)).toEqual([expectedTick, expectedTick * 10, expectedTick, expectedTick & 1]);
    }
    expect(ring.metrics(12).utilization).toBe(1);
  });

  it('is exact at the wrap boundary (pushed === capacity)', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 3, () => 0);
    for (let i = 0; i < 3; i++) ring.push([i, i, i, 0], i);
    expect(ring.get(0)[0]).toBe(0);
    expect(ring.get(2)[0]).toBe(2);
    ring.push([3, 3, 3, 0], 3);
    expect(ring.get(0)[0]).toBe(1);
    expect(ring.get(2)[0]).toBe(3);
  });
});

describe('TelemetryRing.column', () => {
  it('returns the last `count` values oldest first as a fresh Float64Array', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 6, () => 0);
    for (let i = 0; i < 10; i++) ring.push([i, i * 0.5, i, 0], i);
    const x = ring.column('x', 4);
    expect(x).toBeInstanceOf(Float64Array);
    expect(Array.from(x)).toEqual([3, 3.5, 4, 4.5]);
    expect(ring.column('x', 4)).not.toBe(x);
    expect(Array.from(ring.column('tick', 100))).toEqual([4, 5, 6, 7, 8, 9]);
    expect(ring.column('y', 0)).toHaveLength(0);
    expect(() => ring.column('missing', 3)).toThrow(/unknown field/);
  });

  it('returns f32 columns widened to their exact single-precision values', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 4, () => 0);
    ring.push([0, 0, 0.3, 0], 0);
    expect(ring.column('y', 1)[0]).toBe(Math.fround(0.3));
  });
});

describe('TelemetryRing.metrics', () => {
  it('reports sim-rate throughput of 100 records/s for one push per tick', () => {
    const ring = new TelemetryRing(TELEMETRY_FIELDS, 1000, () => 0);
    const rec = new Float64Array(TELEMETRY_FIELDS.length);
    for (let t = 1; t <= 300; t++) {
      rec[0] = t;
      ring.push(rec, t);
    }
    const m = ring.metrics(300);
    expect(m.recordsPerSec).toBe(TICK_HZ);
    expect(m.recordsPerSec).toBe(100);
    expect(m.records).toBe(300);
    expect(m.capacity).toBe(1000);
    expect(m.utilization).toBeCloseTo(0.3, 12);
    expect(m.bytesPerRecord).toBe(bytesPerRecord(TELEMETRY_FIELDS));
    expect(m.bytesPerRecord).toBe(179);
    expect(m.totalBytes).toBe(179 * 300);
    expect(m.lastPushMicros).toBeGreaterThanOrEqual(0);
    expect(m.meanPushMicros).toBeGreaterThanOrEqual(0);
  });

  it('counts only pushes inside the trailing TICK_HZ-tick window', () => {
    const ring = new TelemetryRing(SMALL_FIELDS, 1000, () => 0);
    for (let t = 0; t < 50; t++) ring.push([t, 0, 0, 0], t);
    expect(ring.metrics(49).recordsPerSec).toBe(50);
    expect(ring.metrics(99).recordsPerSec).toBe(50);
    expect(ring.metrics(100).recordsPerSec).toBe(49);
    expect(ring.metrics(149).recordsPerSec).toBe(0);
    // Two records on one tick count twice; a stale slot is reset when its tick is reused.
    ring.push([200, 0, 0, 0], 200);
    ring.push([200, 0, 0, 0], 200);
    expect(ring.metrics(200).recordsPerSec).toBe(2);
    expect(ring.metrics(300).recordsPerSec).toBe(0);
  });

  it('measures push cost with the injected clock and smooths it with α = 0.01', () => {
    // Each push reads the clock twice, so one push costs exactly one step: 0.25 ms = 250 µs.
    const ring = new TelemetryRing(SMALL_FIELDS, 8, fakeClock(0.25));
    ring.push([0, 0, 0, 0], 0);
    expect(ring.metrics(0).lastPushMicros).toBeCloseTo(250, 9);
    expect(ring.metrics(0).meanPushMicros).toBeCloseTo(250, 9);
    ring.push([1, 0, 0, 0], 1);
    expect(ring.metrics(1).meanPushMicros).toBeCloseTo(250, 9);

    // Scripted readings: push 1 sees 0.25 → 0.5 ms (250 µs), push 2 sees 0.75 → 2.0 ms (1250 µs);
    // the EMA moves 1 % of the way from 250 towards 1250.
    const readings = [0.25, 0.5, 0.75, 2.0];
    let reads = 0;
    const jumpy = new TelemetryRing(SMALL_FIELDS, 8, () => readings[reads++] as number);
    jumpy.push([0, 0, 0, 0], 0);
    jumpy.push([1, 0, 0, 0], 1);
    expect(reads).toBe(4);
    const m = jumpy.metrics(1);
    // tolerance 1e-9 µs: pure floating arithmetic on exactly representable quarter-millisecond steps
    expect(m.lastPushMicros).toBeCloseTo(1250, 9);
    expect(m.meanPushMicros).toBeCloseTo(250 + 0.01 * (1250 - 250), 9);
  });

  it('falls back to a zero clock without performance.now', () => {
    const saved = host.performance;
    host.performance = undefined;
    try {
      const ring = new TelemetryRing(SMALL_FIELDS, 4);
      ring.push([0, 0, 0, 0], 0);
      expect(ring.metrics(0).lastPushMicros).toBe(0);
    } finally {
      host.performance = saved;
    }
  });
});

describe('TelemetryRing performance', () => {
  it('pushes 200 000 canonical records in < 500 ms without growing the heap', () => {
    const perf = host.performance;
    const nowMs = perf ? perf.now.bind(perf) : () => 0;
    const ring = new TelemetryRing(TELEMETRY_FIELDS, DEFAULT_TELEMETRY_CAPACITY);
    const rec = new Float64Array(TELEMETRY_FIELDS.length);
    // Warm up the push path so JIT compilation is not charged to the timed window.
    for (let t = 0; t < 2000; t++) ring.push(rec, t);

    const heapBefore = host.process ? host.process.memoryUsage().heapUsed : 0;
    const t0 = nowMs();
    for (let t = 0; t < 200_000; t++) {
      rec[0] = t;
      rec[1] = t * 0.01;
      ring.push(rec, t);
    }
    const elapsed = nowMs() - t0;
    const heapAfter = host.process ? host.process.memoryUsage().heapUsed : 0;

    expect(ring.pushed).toBe(202_000);
    expect(ring.length).toBe(DEFAULT_TELEMETRY_CAPACITY);
    expect(ring.get(DEFAULT_TELEMETRY_CAPACITY - 1)[0]).toBe(199_999);
    expect(elapsed).toBeLessThan(500);
    // The columns are preallocated off-heap; the loop should allocate nothing. GC timing and JIT
    // code objects add noise, so allow a generous 16 MB before calling it a leak.
    expect(heapAfter - heapBefore).toBeLessThan(16 * 1024 * 1024);
  });
});
