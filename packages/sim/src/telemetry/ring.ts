/**
 * Struct-of-arrays telemetry ring buffer: one preallocated typed array per
 * field, a head index, O(1) push with no per-push allocation. Retains the
 * newest `capacity` records; older ones are overwritten in place.
 */
import type { ITelemetryRing, TelemetryField } from '../core/interfaces';
import type { TelemetryMetrics } from '../core/types';
import { TICK_HZ } from '../core/constants';
import { TELEMETRY_FIELDS, bytesPerRecord, fieldIndexMap } from './schema';
import type { TelemetryKind } from './schema';
import { encodeBinary, encodeCSV, encodeJSONL } from './encoders';
import type { ColumnarRecords } from './encoders';

type TypedColumn = Float64Array | Float32Array | Int32Array | Uint8Array;

/** Default record capacity: 360 s of ticks at TICK_HZ. */
export const DEFAULT_TELEMETRY_CAPACITY = 36_000;

/** EMA weight for `meanPushMicros`. */
const PUSH_EMA_ALPHA = 0.01;

function allocColumn(kind: TelemetryKind, capacity: number): TypedColumn {
  switch (kind) {
    case 'f64':
      return new Float64Array(capacity);
    case 'f32':
      return new Float32Array(capacity);
    case 'i32':
      return new Int32Array(capacity);
    case 'u8':
      return new Uint8Array(capacity);
  }
}

interface PerformanceLike {
  now(): number;
}

function defaultNow(): () => number {
  const perf = (globalThis as unknown as { performance?: PerformanceLike }).performance;
  if (perf && typeof perf.now === 'function') return perf.now.bind(perf);
  return () => 0;
}

/**
 * Fixed-capacity, column-oriented record store.
 *
 * `push` cost is measured with the injected `now()` (milliseconds; defaults
 * to `performance.now` when the host has one, else a zero clock). Throughput
 * (`recordsPerSec`) is measured in sim time: the number of records pushed
 * whose tick lies within the last `TICK_HZ` ticks of the tick passed to
 * `metrics()`, so it reads 100 for a healthy one-record-per-tick pipeline
 * regardless of how fast the wall clock is running.
 */
export class TelemetryRing implements ITelemetryRing, ColumnarRecords {
  readonly fields: readonly TelemetryField[];
  readonly capacity: number;
  readonly bytesPerRecord: number;

  private readonly columns: TypedColumn[];
  private readonly index: ReadonlyMap<string, number>;
  private readonly now: () => number;
  /** Next slot to write. */
  private head = 0;
  private count = 0;
  private total = 0;
  private lastPushMicros = 0;
  private meanPushMicros = 0;
  /** Sliding window of push counts keyed by `tick % TICK_HZ`; `windowTicks` holds the tick each slot currently represents. */
  private readonly windowTicks = new Float64Array(TICK_HZ).fill(-1);
  private readonly windowCounts = new Uint32Array(TICK_HZ);

  constructor(fields: readonly TelemetryField[] = TELEMETRY_FIELDS, capacity = DEFAULT_TELEMETRY_CAPACITY, now?: () => number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`TelemetryRing: capacity must be a positive integer, got ${capacity}`);
    if (fields.length === 0) throw new Error('TelemetryRing: at least one field is required');
    this.fields = fields;
    this.capacity = capacity;
    this.index = fieldIndexMap(fields);
    this.bytesPerRecord = bytesPerRecord(fields);
    this.columns = fields.map((f) => allocColumn(f.kind, capacity));
    this.now = now ?? defaultNow();
  }

  /** Retained record count (≤ capacity). */
  get length(): number {
    return this.count;
  }

  /** Total records ever pushed. */
  get pushed(): number {
    return this.total;
  }

  /** Append one record ordered like `fields`; O(1), allocation-free. */
  push(values: ArrayLike<number>, tick: number): void {
    const t0 = this.now();
    const columns = this.columns;
    const n = columns.length;
    if (values.length !== n) throw new Error(`TelemetryRing.push: expected ${n} values, got ${values.length}`);
    const slot = this.head;
    for (let i = 0; i < n; i++) (columns[i] as TypedColumn)[slot] = values[i] as number;
    this.head = slot + 1 === this.capacity ? 0 : slot + 1;
    if (this.count < this.capacity) this.count++;
    this.total++;

    const wslot = ((Math.trunc(tick) % TICK_HZ) + TICK_HZ) % TICK_HZ;
    if (this.windowTicks[wslot] !== tick) {
      this.windowTicks[wslot] = tick;
      this.windowCounts[wslot] = 0;
    }
    this.windowCounts[wslot] = (this.windowCounts[wslot] as number) + 1;

    const micros = (this.now() - t0) * 1000;
    this.lastPushMicros = micros;
    this.meanPushMicros = this.total === 1 ? micros : this.meanPushMicros + PUSH_EMA_ALPHA * (micros - this.meanPushMicros);
  }

  /** Physical slot of retained record `i` (0 = oldest). */
  private slotOf(i: number): number {
    const s = this.head - this.count + i;
    return s < 0 ? s + this.capacity : s;
  }

  /** Column `field` of retained record `record`, without allocating. */
  valueAt(record: number, field: number): number {
    return (this.columns[field] as TypedColumn)[this.slotOf(record)] as number;
  }

  /** Record `i` as a plain array, 0 = oldest retained. Throws when out of range. */
  get(i: number): number[] {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) throw new RangeError(`TelemetryRing.get: index ${i} out of range [0, ${this.count})`);
    const slot = this.slotOf(i);
    const columns = this.columns;
    const out: number[] = new Array<number>(columns.length);
    for (let f = 0; f < columns.length; f++) out[f] = (columns[f] as TypedColumn)[slot] as number;
    return out;
  }

  /** Column index of `field`, throwing on an unknown name. */
  fieldIndex(field: string): number {
    const f = this.index.get(field);
    if (f === undefined) throw new Error(`TelemetryRing: unknown field "${field}"`);
    return f;
  }

  /**
   * The last `count` values of `field`, oldest first, as a fresh Float64Array.
   * Shorter than `count` when fewer records are retained.
   */
  column(field: string, count: number): Float64Array {
    const f = this.fieldIndex(field);
    const n = Math.max(0, Math.min(this.count, Math.floor(count)));
    const out = new Float64Array(n);
    const col = this.columns[f] as TypedColumn;
    const capacity = this.capacity;
    let slot = this.slotOf(this.count - n);
    for (let i = 0; i < n; i++) {
      out[i] = col[slot] as number;
      slot = slot + 1 === capacity ? 0 : slot + 1;
    }
    return out;
  }

  /** Records pushed with a tick in `(tick - TICK_HZ, tick]`. */
  private recordsInLastSecond(tick: number): number {
    let sum = 0;
    for (let s = 0; s < TICK_HZ; s++) {
      const t = this.windowTicks[s] as number;
      if (t >= 0 && t <= tick && tick - t < TICK_HZ) sum += this.windowCounts[s] as number;
    }
    return sum;
  }

  metrics(tick: number): TelemetryMetrics {
    return {
      records: this.count,
      capacity: this.capacity,
      utilization: this.count / this.capacity,
      recordsPerSec: this.recordsInLastSecond(tick),
      lastPushMicros: this.lastPushMicros,
      meanPushMicros: this.meanPushMicros,
      bytesPerRecord: this.bytesPerRecord,
      totalBytes: this.bytesPerRecord * this.total,
    };
  }

  toJSONL(): string {
    return encodeJSONL(this);
  }

  toCSV(): string {
    return encodeCSV(this);
  }

  toBinary(): ArrayBuffer {
    return encodeBinary(this);
  }
}
