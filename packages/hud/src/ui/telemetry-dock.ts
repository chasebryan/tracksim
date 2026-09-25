/**
 * Bottom dock: the telemetry terminal (24 fixed rows whose text is replaced),
 * measured ring-buffer metrics, export buttons, recording loader, the
 * timeline scrubber and the event log (last 40 events, newest first).
 */
import type { SimEvent } from '@tracksim/sim';
import type { ExportFormat, FrameMessage, HudHandlers } from '../contracts';
import { button, h, textEl, type TextCell } from './dom';
import { bytes, formatTime, integer, micros, percent } from './format';

export const TERMINAL_ROWS = 24;
export const EVENT_LOG_LIMIT = 40;

export const EXPORTS: readonly { format: ExportFormat; testId: string; label: string }[] = [
  { format: 'jsonl', testId: 'btn-export-jsonl', label: 'JSONL' },
  { format: 'csv', testId: 'btn-export-csv', label: 'CSV' },
  { format: 'bin', testId: 'btn-export-bin', label: 'BIN' },
  { format: 'recording', testId: 'btn-export-recording', label: 'Recording' },
];

export interface TelemetryDock {
  update(frame: FrameMessage): void;
  /** Clear the event log (new run). */
  reset(): void;
  /** True while the operator is dragging the scrubber (frames do not move it). */
  isScrubbing(): boolean;
}

function stat(label: string, testId: string, initial: string): { el: HTMLElement; value: TextCell } {
  const value = textEl('dd', { class: 'num', 'data-testid': testId }, initial);
  return { el: h('div', { class: 'stat' }, [h('dt', {}, [label]), value.el]), value };
}

function eventRow(e: SimEvent, key: string): HTMLElement {
  return h('li', { class: `event event--${e.level} event--src-${e.source}`, 'data-key': key, 'data-level': e.level }, [
    h('span', { class: 'event__time' }, [formatTime(e.time)]),
    h('span', { class: 'event__source' }, [e.source]),
    h('span', { class: 'event__msg' }, [e.message]),
  ]);
}

/** Build the dock into `root`. */
export function createTelemetryDock(root: HTMLElement, handlers: HudHandlers): TelemetryDock {
  // -- terminal -----------------------------------------------------------------
  const rows: TextCell[] = [];
  const terminal = h('div', { class: 'terminal', 'data-testid': 'terminal', role: 'log', 'aria-live': 'off' });
  for (let i = 0; i < TERMINAL_ROWS; i++) {
    const row = textEl('div', { class: 'terminal__row' }, '');
    rows.push(row);
    terminal.appendChild(row.el);
  }

  // -- metrics + export + timeline ------------------------------------------------
  const recordsPerSec = stat('rec/s', 'metric-records-per-sec', '0');
  const pushMicros = stat('push', 'metric-push-micros', micros(0, 2));
  const utilization = stat('util', 'metric-utilization', percent(0));
  const totalBytes = stat('bytes', 'metric-bytes', bytes(0));
  const records = stat('records', 'metric-records', '0 / 0');
  const bytesPerRecord = stat('B/rec', 'metric-bytes-per-record', '0');

  const exportButtons = EXPORTS.map((x) => button(x.label, x.testId, () => handlers.exportAs(x.format), 'btn btn--export'));

  const loadInput = h('input', { type: 'file', class: 'file__input', 'data-testid': 'input-load-recording', accept: '.json,application/json' });
  loadInput.addEventListener('change', () => {
    const file = loadInput.files?.[0];
    if (file) handlers.loadRecording(file);
    loadInput.value = '';
  });

  const scrubber = h('input', {
    type: 'range',
    class: 'timeline__scrubber',
    'data-testid': 'timeline-scrubber',
    min: '0',
    max: '0',
    step: '1',
    value: '0',
    'aria-label': 'Timeline',
  });
  const timelineReadout = textEl('span', { class: 'timeline__readout', 'data-testid': 'timeline-readout' }, `${formatTime(0)} / ${formatTime(0)}`);
  let scrubbing = false;
  let lastTick = -1;
  let lastEndTick = -1;
  const stopScrub = (): void => {
    scrubbing = false;
  };
  scrubber.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  scrubber.addEventListener('input', () => {
    scrubbing = true;
  });
  scrubber.addEventListener('pointerup', stopScrub);
  scrubber.addEventListener('pointercancel', stopScrub);
  scrubber.addEventListener('blur', stopScrub);
  scrubber.addEventListener('change', () => {
    scrubbing = false;
    const tick = Number(scrubber.value);
    if (Number.isFinite(tick)) {
      lastTick = tick;
      handlers.seek(tick);
    }
  });

  const ring = h('div', { class: 'dock__ring' }, [
    h('dl', { class: 'stats stats--3' }, [recordsPerSec.el, pushMicros.el, utilization.el, totalBytes.el, records.el, bytesPerRecord.el]),
    h('div', { class: 'control-row control-row--wrap' }, [
      h('span', { class: 'k' }, ['export']),
      h('div', { class: 'btn-group btn-group--wrap', role: 'group', 'aria-label': 'Export' }, exportButtons),
      h('label', { class: 'btn btn--file' }, ['load recording', loadInput]),
    ]),
    h('div', { class: 'timeline' }, [scrubber, timelineReadout.el]),
  ]);

  // -- event log ------------------------------------------------------------------
  const log = h('ol', { class: 'event-log', 'data-testid': 'event-log', role: 'log', 'aria-live': 'polite' });
  let logCount = 0;
  let lastEventTick = -1;
  let runKey = '';

  const reset = (): void => {
    log.replaceChildren();
    logCount = 0;
    lastEventTick = -1;
  };

  root.append(
    h('section', { class: 'dock__section dock__section--terminal' }, [h('h2', { class: 'panel__title' }, ['telemetry']), terminal]),
    h('section', { class: 'dock__section dock__section--ring' }, [h('h2', { class: 'panel__title' }, ['ring buffer / timeline']), ring]),
    h('section', { class: 'dock__section dock__section--events' }, [h('h2', { class: 'panel__title' }, ['events']), log]),
  );

  return {
    reset,
    isScrubbing: () => scrubbing,
    update(frame: FrameMessage): void {
      const s = frame.snapshot;

      // Terminal: newest line in the last row, blanks above when fewer than 24 lines.
      const lines = frame.terminal;
      const n = Math.min(lines.length, TERMINAL_ROWS);
      const offset = TERMINAL_ROWS - n;
      const start = lines.length - n;
      for (let r = 0; r < TERMINAL_ROWS; r++) {
        const li = r - offset;
        (rows[r] as TextCell).set(li >= 0 ? (lines[start + li] as string) : '');
      }

      const m = s.telemetry;
      recordsPerSec.value.set(integer(m.recordsPerSec));
      pushMicros.value.set(micros(m.meanPushMicros, 2));
      utilization.value.set(percent(m.utilization, 1));
      totalBytes.value.set(bytes(m.totalBytes));
      records.value.set(`${integer(m.records)} / ${integer(m.capacity)}`);
      bytesPerRecord.value.set(integer(m.bytesPerRecord));

      if (frame.endTick !== lastEndTick) {
        lastEndTick = frame.endTick;
        scrubber.max = String(frame.endTick);
      }
      if (!scrubbing && s.tick !== lastTick) {
        lastTick = s.tick;
        scrubber.value = String(s.tick);
      }
      timelineReadout.set(`${formatTime(s.time)} / ${formatTime(s.durationS)}`);

      // Event log: a new (scenario, seed) run starts a fresh log; within a run only
      // events newer than the last shown tick are appended, newest on top.
      const key = `${s.scenarioId}\u0000${s.seed}`;
      if (key !== runKey) {
        runKey = key;
        reset();
      }
      const threshold = lastEventTick;
      let maxTick = threshold;
      for (let i = 0; i < s.events.length; i++) {
        const e = s.events[i] as SimEvent;
        if (e.tick <= threshold) continue;
        log.insertBefore(eventRow(e, `${e.tick}:${i}`), log.firstChild);
        logCount++;
        if (e.tick > maxTick) maxTick = e.tick;
      }
      lastEventTick = maxTick;
      while (logCount > EVENT_LOG_LIMIT) {
        log.lastElementChild?.remove();
        logCount--;
      }
    },
  };
}
