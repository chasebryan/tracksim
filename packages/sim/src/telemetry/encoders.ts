/**
 * Telemetry export encoders. Each works on a column-addressable record source
 * (the ring implements it) so no encoder needs to allocate a row per record.
 *
 * Binary layout (all integers little-endian):
 *   bytes 0..3   ASCII magic "TSIM"
 *   bytes 4..7   u32 version (1)
 *   bytes 8..11  u32 header length in bytes
 *   header       UTF-8 JSON `{fields, capacity, length, pushed}`
 *   columns      for each field in order: `length` values, oldest first,
 *                packed contiguously in the field's kind (no padding)
 */
import type { TelemetryField } from '../core/interfaces';
import { KIND_BYTES, bytesPerRecord } from './schema';
import type { TelemetryKind } from './schema';

/** Minimal columnar view of retained records; record 0 is the oldest. */
export interface ColumnarRecords {
  readonly fields: readonly TelemetryField[];
  readonly capacity: number;
  readonly length: number;
  readonly pushed: number;
  /** Value of column `field` in retained record `record`, no allocation. */
  valueAt(record: number, field: number): number;
}

export const TELEMETRY_BINARY_MAGIC = 'TSIM';
export const TELEMETRY_BINARY_VERSION = 1;
const PREAMBLE_BYTES = 12;

/** What `decodeBinary` recovers: the schema plus every retained record, oldest first. */
export interface DecodedTelemetry {
  fields: TelemetryField[];
  records: number[][];
  capacity: number;
  pushed: number;
}

function jsonNumber(v: number): string {
  return Number.isFinite(v) ? String(v) : 'null';
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One JSON object per line with field names as keys; NaN/±Infinity become `null`. */
export function encodeJSONL(src: ColumnarRecords): string {
  const n = src.fields.length;
  const keys: string[] = [];
  for (let f = 0; f < n; f++) keys.push(JSON.stringify((src.fields[f] as TelemetryField).name) + ':');
  const lines: string[] = [];
  const cells: string[] = new Array<string>(n);
  for (let r = 0; r < src.length; r++) {
    for (let f = 0; f < n; f++) cells[f] = (keys[f] as string) + jsonNumber(src.valueAt(r, f));
    lines.push('{' + cells.join(',') + '}\n');
  }
  return lines.join('');
}

/** RFC 4180-style CSV: a header row of field names, then one row per record. */
export function encodeCSV(src: ColumnarRecords): string {
  const n = src.fields.length;
  const header: string[] = [];
  for (let f = 0; f < n; f++) header.push(csvCell((src.fields[f] as TelemetryField).name));
  const lines: string[] = [header.join(',') + '\n'];
  const cells: string[] = new Array<string>(n);
  for (let r = 0; r < src.length; r++) {
    for (let f = 0; f < n; f++) cells[f] = String(src.valueAt(r, f));
    lines.push(cells.join(',') + '\n');
  }
  return lines.join('');
}

/** Pack the retained records into the binary container described in the module header. */
export function encodeBinary(src: ColumnarRecords): ArrayBuffer {
  const fields = src.fields;
  const length = src.length;
  const header = utf8Encode(
    JSON.stringify({
      fields: fields.map((f) => ({ name: f.name, kind: f.kind })),
      capacity: src.capacity,
      length,
      pushed: src.pushed,
    }),
  );
  const total = PREAMBLE_BYTES + header.length + bytesPerRecord(fields) * length;
  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) bytes[i] = TELEMETRY_BINARY_MAGIC.charCodeAt(i);
  view.setUint32(4, TELEMETRY_BINARY_VERSION, true);
  view.setUint32(8, header.length, true);
  bytes.set(header, PREAMBLE_BYTES);
  let offset = PREAMBLE_BYTES + header.length;
  for (let f = 0; f < fields.length; f++) {
    const kind = (fields[f] as TelemetryField).kind;
    const size = KIND_BYTES[kind];
    for (let r = 0; r < length; r++) {
      writeValue(view, offset, kind, src.valueAt(r, f));
      offset += size;
    }
  }
  return buf;
}

/**
 * Parse a buffer produced by `encodeBinary`/`TelemetryRing.toBinary`.
 * Throws on a bad magic, an unsupported version, a malformed header or a
 * truncated column section.
 */
export function decodeBinary(buf: ArrayBuffer | ArrayBufferView): DecodedTelemetry {
  const view = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.byteLength < PREAMBLE_BYTES) throw new Error('decodeBinary: buffer too short for preamble');
  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== TELEMETRY_BINARY_MAGIC) throw new Error(`decodeBinary: bad magic "${magic}"`);
  const version = view.getUint32(4, true);
  if (version !== TELEMETRY_BINARY_VERSION) throw new Error(`decodeBinary: unsupported version ${version}`);
  const headerLen = view.getUint32(8, true);
  if (PREAMBLE_BYTES + headerLen > view.byteLength) throw new Error('decodeBinary: header exceeds buffer');
  const headerBytes = new Uint8Array(view.buffer, view.byteOffset + PREAMBLE_BYTES, headerLen);
  const header = parseHeader(utf8Decode(headerBytes));
  const { fields, length } = header;
  const columnsStart = PREAMBLE_BYTES + headerLen;
  const expected = columnsStart + bytesPerRecord(fields) * length;
  if (expected !== view.byteLength) {
    throw new Error(`decodeBinary: expected ${expected} bytes for ${length} records, got ${view.byteLength}`);
  }
  const records: number[][] = new Array<number[]>(length);
  for (let r = 0; r < length; r++) records[r] = new Array<number>(fields.length);
  let offset = columnsStart;
  for (let f = 0; f < fields.length; f++) {
    const kind = (fields[f] as TelemetryField).kind;
    const size = KIND_BYTES[kind];
    for (let r = 0; r < length; r++) {
      (records[r] as number[])[f] = readValue(view, offset, kind);
      offset += size;
    }
  }
  return { fields, records, capacity: header.capacity, pushed: header.pushed };
}

interface BinaryHeader {
  fields: TelemetryField[];
  capacity: number;
  length: number;
  pushed: number;
}

function isKind(k: unknown): k is TelemetryKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(KIND_BYTES, k);
}

function nonNegativeInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`decodeBinary: header ${what} is not a non-negative integer`);
  return v;
}

function parseHeader(text: string): BinaryHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('decodeBinary: header is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('decodeBinary: header is not an object');
  const h = raw as Record<string, unknown>;
  if (!Array.isArray(h.fields)) throw new Error('decodeBinary: header fields missing');
  const fields: TelemetryField[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < h.fields.length; i++) {
    const f = h.fields[i] as Record<string, unknown> | null;
    if (typeof f !== 'object' || f === null || typeof f.name !== 'string' || !isKind(f.kind)) {
      throw new Error(`decodeBinary: header field ${i} is malformed`);
    }
    if (seen.has(f.name)) throw new Error(`decodeBinary: duplicate field "${f.name}"`);
    seen.add(f.name);
    fields.push({ name: f.name, kind: f.kind });
  }
  return {
    fields,
    capacity: nonNegativeInt(h.capacity, 'capacity'),
    length: nonNegativeInt(h.length, 'length'),
    pushed: nonNegativeInt(h.pushed, 'pushed'),
  };
}

function writeValue(view: DataView, offset: number, kind: TelemetryKind, v: number): void {
  switch (kind) {
    case 'f64':
      view.setFloat64(offset, v, true);
      break;
    case 'f32':
      view.setFloat32(offset, v, true);
      break;
    case 'i32':
      view.setInt32(offset, v | 0, true);
      break;
    case 'u8':
      view.setUint8(offset, v & 0xff);
      break;
  }
}

function readValue(view: DataView, offset: number, kind: TelemetryKind): number {
  switch (kind) {
    case 'f64':
      return view.getFloat64(offset, true);
    case 'f32':
      return view.getFloat32(offset, true);
    case 'i32':
      return view.getInt32(offset, true);
    case 'u8':
      return view.getUint8(offset);
  }
}

// UTF-8 without TextEncoder/TextDecoder: the sim package compiles against the
// bare ES2022 lib, which does not declare them.

function utf8Encode(s: string): Uint8Array {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i) as number;
    if (c > 0xffff) i++;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  const out = new Uint8Array(n);
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i) as number;
    if (c > 0xffff) i++;
    if (c < 0x80) {
      out[j++] = c;
    } else if (c < 0x800) {
      out[j++] = 0xc0 | (c >> 6);
      out[j++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[j++] = 0xe0 | (c >> 12);
      out[j++] = 0x80 | ((c >> 6) & 0x3f);
      out[j++] = 0x80 | (c & 0x3f);
    } else {
      out[j++] = 0xf0 | (c >> 18);
      out[j++] = 0x80 | ((c >> 12) & 0x3f);
      out[j++] = 0x80 | ((c >> 6) & 0x3f);
      out[j++] = 0x80 | (c & 0x3f);
    }
  }
  return out;
}

function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  const at = (i: number): number => (i < bytes.length ? (bytes[i] as number) : 0);
  for (let i = 0; i < bytes.length; ) {
    const b0 = at(i);
    let c: number;
    if (b0 < 0x80) {
      c = b0;
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      c = ((b0 & 0x1f) << 6) | (at(i + 1) & 0x3f);
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      c = ((b0 & 0x0f) << 12) | ((at(i + 1) & 0x3f) << 6) | (at(i + 2) & 0x3f);
      i += 3;
    } else {
      c = ((b0 & 0x07) << 18) | ((at(i + 1) & 0x3f) << 12) | ((at(i + 2) & 0x3f) << 6) | (at(i + 3) & 0x3f);
      i += 4;
    }
    parts.push(String.fromCodePoint(c > 0x10ffff ? 0xfffd : c));
  }
  return parts.join('');
}
