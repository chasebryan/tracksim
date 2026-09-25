/**
 * Radar / tracker panel: radar status line, track and detection counts,
 * the gate selector, the disturbance buttons (each sends one operator
 * `Command`) and the truth-overlay toggle (view state only).
 */
import type { Command, GateSetting, TrackSnapshot } from '@tracksim/sim';
import type { FrameMessage, HudHandlers, HudViewState } from '../contracts';
import { button, classCell, h, pressedCell, textEl, type FlagCell, type TextCell } from './dom';
import { fixed, integer, km } from './format';

export const GATES: readonly GateSetting[] = ['loose', 'normal', 'strict'];

/** Nominal clutter rate (false alarms per scan); the burst button sends 10× this. */
export const NOMINAL_CLUTTER_RATE = 2;

export interface DisturbanceButton {
  id: 'terrain' | 'swarm' | 'clutter' | 'decoys';
  testId: string;
  label: string;
  title: string;
  /** Fresh command object each call so nothing downstream can share state. */
  command(): Command;
}

/** The four disturbance buttons and the exact commands they send (CONTRACTS.md "hud/"). */
export const DISTURBANCES: readonly DisturbanceButton[] = [
  {
    id: 'terrain',
    testId: 'btn-inject-terrain',
    label: 'TERRAIN ×10',
    title: 'Inject TERRAIN noise ×10 for 20 s',
    command: () => ({ type: 'sensor.disturb', sensor: 'TERRAIN', noiseScale: 10, bias: [0, 0], durationS: 20 }),
  },
  {
    id: 'swarm',
    testId: 'btn-spoof-swarm',
    label: 'SWARM +400 m',
    title: 'Spoof SWARM fix +400 m east for 20 s',
    command: () => ({ type: 'sensor.disturb', sensor: 'SWARM', noiseScale: 1, bias: [400, 0], durationS: 20 }),
  },
  {
    id: 'clutter',
    testId: 'btn-clutter',
    label: 'clutter ×10',
    title: `Clutter burst: ${NOMINAL_CLUTTER_RATE * 10} false alarms per scan for 20 s`,
    command: () => ({ type: 'radar.clutter', rate: NOMINAL_CLUTTER_RATE * 10, durationS: 20 }),
  },
  {
    id: 'decoys',
    testId: 'btn-decoys',
    label: '6 decoys',
    title: 'Spawn six decoys near a contact',
    command: () => ({ type: 'contacts.spawnDecoys', count: 6 }),
  },
];

/** Confirmed tracks = confirmed or coasting (same rule as the orchestrator's telemetry). */
export function countConfirmed(tracks: readonly TrackSnapshot[]): number {
  let n = 0;
  for (const t of tracks) if (t.status === 'confirmed' || t.status === 'coasting') n++;
  return n;
}

/** Total tracks = everything not yet dropped. */
export function countTotal(tracks: readonly TrackSnapshot[]): number {
  let n = 0;
  for (const t of tracks) if (t.status !== 'dropped') n++;
  return n;
}

export interface TrackerPanel {
  update(frame: FrameMessage): void;
}

interface Stat {
  el: HTMLElement;
  value: TextCell;
}

function stat(label: string, testId: string): Stat {
  const value = textEl('dd', { class: 'num', 'data-testid': testId }, '0');
  return { el: h('div', { class: 'stat' }, [h('dt', {}, [label]), value.el]), value };
}

/** Build the tracker controls into `root`; `state.showTruth` is toggled by the overlay button. */
export function createTrackerPanel(root: HTMLElement, handlers: HudHandlers, state: HudViewState): TrackerPanel {
  const scanHz = textEl('span', { class: 'v', 'data-testid': 'radar-scan-hz' }, '--');
  const maxRange = textEl('span', { class: 'v', 'data-testid': 'radar-max-range' }, '--');
  const clutterRate = textEl('span', { class: 'v', 'data-testid': 'radar-clutter-rate' }, '--');
  const clutterWarn: FlagCell = classCell(clutterRate.el, 'is-warn');
  const pd = textEl('span', { class: 'v', 'data-testid': 'radar-pd' }, '--');
  const gateChi2 = textEl('span', { class: 'v', 'data-testid': 'radar-gate-chi2' }, '--');

  const confirmed = stat('confirmed', 'tracks-confirmed');
  const total = stat('tracks', 'tracks-total');
  const detections = stat('detections', 'detections');
  const clutter = stat('clutter', 'clutter');

  const gateButtons = GATES.map((g) => {
    const el = button(g, `btn-gate-${g}`, () => handlers.command({ type: 'gate', value: g }), 'btn btn--gate');
    return { gate: g, el, pressed: pressedCell(el, g === 'normal') };
  });

  const disturbButtons = DISTURBANCES.map((d) => {
    const el = button(d.label, d.testId, () => handlers.command(d.command()), 'btn btn--disturb');
    el.title = d.title;
    return el;
  });

  const truthToggle = button('truth overlay', 'btn-toggle-truth', () => {
    state.showTruth = !state.showTruth;
    truthPressed.set(state.showTruth);
  });
  const truthPressed = pressedCell(truthToggle, state.showTruth);

  root.append(
    h('div', { class: 'radar-status' }, [
      h('span', { class: 'k' }, ['scan']),
      scanHz.el,
      h('span', { class: 'k' }, ['range']),
      maxRange.el,
      h('span', { class: 'k' }, ['clutter λ']),
      clutterRate.el,
      h('span', { class: 'k' }, ['pd']),
      pd.el,
      h('span', { class: 'k' }, ['χ²']),
      gateChi2.el,
    ]),
    h('dl', { class: 'stats stats--4' }, [confirmed.el, total.el, detections.el, clutter.el]),
    h('div', { class: 'control-row' }, [
      h('span', { class: 'k' }, ['gate']),
      h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Association gate' }, gateButtons.map((b) => b.el)),
    ]),
    h('div', { class: 'control-row control-row--wrap' }, [
      h('span', { class: 'k' }, ['disturb']),
      h('div', { class: 'btn-group btn-group--wrap', role: 'group', 'aria-label': 'Disturbances' }, disturbButtons),
    ]),
    h('div', { class: 'control-row' }, [h('span', { class: 'k' }, ['overlay']), truthToggle]),
  );

  return {
    update(frame: FrameMessage): void {
      const { radar, tracks } = frame.snapshot;
      scanHz.set(`${integer(radar.scanHz)} Hz`);
      maxRange.set(km(radar.maxRange, 0));
      clutterRate.set(fixed(radar.clutterRate, 1));
      clutterWarn.set(radar.clutterRate > NOMINAL_CLUTTER_RATE);
      pd.set(fixed(radar.pd, 2));
      gateChi2.set(fixed(radar.gateChi2, 2));
      confirmed.value.set(integer(countConfirmed(tracks)));
      total.value.set(integer(countTotal(tracks)));
      detections.value.set(integer(radar.detectionsLastScan));
      clutter.value.set(integer(radar.clutterLastScan));
      for (const b of gateButtons) b.pressed.set(b.gate === radar.gate);
      truthPressed.set(state.showTruth);
    },
  };
}
