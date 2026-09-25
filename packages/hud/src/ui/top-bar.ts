/**
 * Top bar: scenario select, seed input + reseed, transport (play/pause),
 * speed buttons, `T+MM:SS.ss` time readout, phase name and tick cost.
 *
 * "Reseed" restarts the selected scenario with the seed typed in the input
 * (falling back to the current run's seed when the input is not a number).
 * The seed input is only overwritten when the run's seed actually changes so
 * frames never clobber a value the operator is typing.
 */
import type { FrameMessage, HudHandlers, ReadyMessage } from '../contracts';
import { button, h, pressedCell, textEl, type FlagCell } from './dom';
import { formatTime, micros } from './format';

/** Playback multipliers offered as buttons (`data-testid="speed-<value>"`). */
export const SPEEDS: readonly number[] = [0.5, 1, 2, 4];

export interface TopBar {
  readonly el: HTMLElement;
  setReady(ready: ReadyMessage): void;
  update(frame: FrameMessage): void;
}

interface SpeedButton {
  value: number;
  el: HTMLButtonElement;
  pressed: FlagCell;
}

/** Build the top-bar controls into `root` and return the updater. */
export function createTopBar(root: HTMLElement, handlers: HudHandlers): TopBar {
  let seed = NaN;
  let scenarioId = '';
  let optionKey = '';

  const select = h('select', { class: 'select', 'data-testid': 'scenario-select', 'aria-label': 'Scenario' });
  const seedInput = h('input', {
    class: 'input input--seed',
    'data-testid': 'seed-input',
    type: 'number',
    min: '0',
    step: '1',
    inputmode: 'numeric',
    'aria-label': 'Seed',
  });

  const currentSeed = (): number => {
    const v = Number.parseInt(seedInput.value, 10);
    return Number.isFinite(v) && v >= 0 ? v >>> 0 : Number.isFinite(seed) ? seed : 0;
  };
  const restart = (): void => handlers.selectScenario(select.value || scenarioId, currentSeed());

  select.addEventListener('change', restart);
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') restart();
  });

  const reseed = button('Reseed', 'btn-reseed', restart);
  const play = button('Play', 'btn-play', () => handlers.play(), 'btn btn--transport');
  const pause = button('Pause', 'btn-pause', () => handlers.pause(), 'btn btn--transport');
  const playPressed = pressedCell(play, false);
  const pausePressed = pressedCell(pause, false);

  const speeds: SpeedButton[] = SPEEDS.map((value) => {
    const el = button(`${value}×`, `speed-${value}`, () => handlers.setSpeed(value), 'btn btn--speed');
    return { value, el, pressed: pressedCell(el, value === 1) };
  });

  const time = textEl('span', { class: 'readout readout--time', 'data-testid': 'time-readout' }, formatTime(0));
  const phase = textEl('span', { class: 'readout readout--phase', 'data-testid': 'phase-name' }, '--');
  const cost = textEl('span', { class: 'readout readout--cost', 'data-testid': 'tick-cost' }, micros(0));

  const el = h('div', { class: 'top-bar__controls' }, [
    h('label', { class: 'field' }, [h('span', { class: 'field__label' }, ['scenario']), select]),
    h('label', { class: 'field' }, [h('span', { class: 'field__label' }, ['seed']), seedInput]),
    reseed,
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Transport' }, [play, pause]),
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Speed' }, speeds.map((s) => s.el)),
    h('div', { class: 'readouts' }, [
      time.el,
      h('span', { class: 'readout__label' }, ['phase']),
      phase.el,
      h('span', { class: 'readout__label' }, ['tick']),
      cost.el,
    ]),
  ]);
  root.appendChild(el);

  const applyRun = (id: string, runSeed: number, force: boolean): void => {
    if (force || id !== scenarioId) {
      scenarioId = id;
      select.value = id;
    }
    if (force || runSeed !== seed) {
      seed = runSeed;
      seedInput.value = String(runSeed);
    }
  };

  return {
    el,
    setReady(ready: ReadyMessage): void {
      const key = ready.scenarios.map((s) => `${s.id}\u0000${s.name}`).join('\u0001');
      if (key !== optionKey) {
        optionKey = key;
        select.replaceChildren(...ready.scenarios.map((s) => h('option', { value: s.id, title: s.description }, [s.name])));
      }
      applyRun(ready.scenarioId, ready.seed, true);
    },
    update(frame: FrameMessage): void {
      const s = frame.snapshot;
      applyRun(s.scenarioId, s.seed, false);
      time.set(formatTime(s.time));
      phase.set(s.phase || '--');
      cost.set(micros(s.tickMicros));
      playPressed.set(frame.playing);
      pausePressed.set(!frame.playing);
      for (const sb of speeds) sb.pressed.set(Math.abs(frame.speed - sb.value) < 1e-9);
    },
  };
}
