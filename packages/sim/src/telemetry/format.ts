/**
 * Fixed-width terminal rendering of one telemetry record, e.g.
 *
 *   T+00:12.34 | err    8.2m σ    6.1m | INS   1.9  STAR   2.3  MAG   1.7  TER  41.0! SWR   2.0  | trk   4/  3 det   7 clt   2
 *
 * Every numeric cell has a fixed width so consecutive lines align in a
 * monospace panel and the HUD can replace text in place without reflow.
 * `!` after a NIS marks an isolated sensor; `off` marks a disabled one; `--`
 * marks a value that is not yet available (NaN).
 */
import type { TelemetryField } from '../core/interfaces';
import { SENSOR_IDS } from '../core/types';
import type { SensorId } from '../core/types';
import { TELEMETRY_FIELDS, fieldIndexMap } from './schema';

/** Short sensor tags used in the terminal line. */
export const SENSOR_ABBREV: Readonly<Record<SensorId, string>> = {
  INS: 'INS',
  STAR: 'STAR',
  MAGGRAV: 'MAG',
  TERRAIN: 'TER',
  SWARM: 'SWR',
};

const ERR_WIDTH = 6;
const NIS_WIDTH = 5;
const COUNT_WIDTH = 3;

/** Right-align `v` to `width` with `decimals` places; `--` when NaN, `#`-filled when it does not fit. */
function num(v: number, width: number, decimals: number): string {
  if (Number.isNaN(v)) return '--'.padStart(width);
  if (!Number.isFinite(v)) return (v > 0 ? 'inf' : '-inf').padStart(width);
  const s = v.toFixed(decimals);
  return s.length > width ? '#'.repeat(width) : s.padStart(width);
}

function int(v: number, width: number): string {
  return num(v, width, 0);
}

function clock(time: number): string {
  if (!Number.isFinite(time)) return 'T+--:--.--';
  const cs = Math.max(0, Math.round(time * 100));
  const mm = Math.floor(cs / 6000);
  const rest = cs - mm * 6000;
  const ss = Math.floor(rest / 100);
  const cc = rest - ss * 100;
  return `T+${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

/**
 * Render `record` (ordered like `fields`) as one fixed-width line. Sensors are
 * shown in `SENSOR_IDS` order for every id whose `<ID>_nis` column exists in
 * `fields`; any other missing column renders as `--`.
 */
export function formatTerminalLine(record: ArrayLike<number>, fields: readonly TelemetryField[] = TELEMETRY_FIELDS): string {
  const index = fieldIndexMap(fields);
  const value = (name: string): number => {
    const i = index.get(name);
    return i === undefined ? NaN : (record[i] as number);
  };

  const parts: string[] = [];
  parts.push(clock(value('time')));
  parts.push(`err ${num(value('posError'), ERR_WIDTH, 1)}m σ ${num(value('posSigma'), ERR_WIDTH, 1)}m`);

  const sensors: string[] = [];
  for (let s = 0; s < SENSOR_IDS.length; s++) {
    const id = SENSOR_IDS[s] as SensorId;
    if (!index.has(`${id}_nis`)) continue;
    const enabled = value(`${id}_enabled`);
    const isolated = value(`${id}_isolated`) === 1;
    const nis = enabled === 0 ? 'off'.padStart(NIS_WIDTH) : num(value(`${id}_nis`), NIS_WIDTH, 1);
    sensors.push(`${SENSOR_ABBREV[id]} ${nis}${isolated ? '!' : ' '}`);
  }
  if (sensors.length > 0) parts.push(sensors.join(' '));

  parts.push(
    `trk ${int(value('tracksTotal'), COUNT_WIDTH)}/${int(value('tracksConfirmed'), COUNT_WIDTH)}` +
      ` det ${int(value('detections'), COUNT_WIDTH)} clt ${int(value('clutter'), COUNT_WIDTH)}`,
  );
  return parts.join(' | ');
}
