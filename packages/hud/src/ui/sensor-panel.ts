/**
 * Sensor panel: one card per navigation sensor with an enable toggle, rate,
 * last/mean NIS against the gate, mean-influence bar, accepted/rejected
 * counts, the active disturbance and the ISOLATED badge.
 *
 * Cards are created once (in `SENSOR_ORDER`) and updated in place; the
 * checkbox is only rewritten when the sim's `enabled` flag actually changes.
 */
import type { SensorId, SensorStatus } from '@tracksim/sim';
import type { FrameMessage, HudHandlers } from '../contracts';
import { barCell, classCell, h, hiddenCell, textEl, type BarCell, type FlagCell, type TextCell } from './dom';
import { fixed, integer, percent } from './format';

/** Display order; matches `SENSOR_IDS` in the sim (asserted by the tests). */
export const SENSOR_ORDER: readonly SensorId[] = ['INS', 'STAR', 'MAGGRAV', 'TERRAIN', 'SWARM'];

export interface SensorPanel {
  update(frame: FrameMessage): void;
}

interface SensorCard {
  el: HTMLElement;
  enable: HTMLInputElement;
  lastEnabled: boolean;
  name: TextCell;
  rate: TextCell;
  nis: TextCell;
  meanNis: TextCell;
  gate: TextCell;
  influence: BarCell;
  influenceText: TextCell;
  accepted: TextCell;
  rejected: TextCell;
  isolatedHidden: FlagCell;
  disturbance: TextCell;
  disturbanceHidden: FlagCell;
  isolatedClass: FlagCell;
  disabledClass: FlagCell;
  rejectingClass: FlagCell;
}

/** True when a disturbance is currently applied to the generated measurement. */
export function hasDisturbance(s: SensorStatus): boolean {
  const scaled = Number.isFinite(s.noiseScale) && s.noiseScale !== 1;
  return scaled || s.bias[0] !== 0 || s.bias[1] !== 0;
}

function disturbanceText(s: SensorStatus): string {
  const parts: string[] = [];
  if (Number.isFinite(s.noiseScale) && s.noiseScale !== 1) parts.push(`noise ×${fixed(s.noiseScale, 1)}`);
  if (s.bias[0] !== 0 || s.bias[1] !== 0) parts.push(`bias [${integer(s.bias[0])}, ${integer(s.bias[1])}] m`);
  return parts.join(' ');
}

/** Build the five sensor cards into `root` and return the updater. */
export function createSensorPanel(root: HTMLElement, handlers: HudHandlers): SensorPanel {
  const cards = new Map<string, SensorCard>();
  const list = h('div', { class: 'sensor-list' });
  root.appendChild(list);

  const makeCard = (id: SensorId): SensorCard => {
    const enable = h('input', { type: 'checkbox', class: 'check__input', 'data-testid': `sensor-enable-${id}` });
    enable.checked = true;
    enable.addEventListener('change', () => handlers.command({ type: 'sensor.enable', sensor: id, enabled: enable.checked }));

    const name = textEl('span', { class: 'sensor-card__name' }, id);
    const rate = textEl('span', { class: 'sensor-card__rate' }, '-- Hz');
    const isolated = h('span', { class: 'badge badge--alert', 'data-testid': `sensor-isolated-${id}` }, ['ISOLATED']);
    const nis = textEl('span', { class: 'v', 'data-testid': `sensor-nis-${id}` }, '--');
    const meanNis = textEl('span', { class: 'v', 'data-testid': `sensor-mean-nis-${id}` }, '--');
    const gate = textEl('span', { class: 'v v--dim' }, '--');
    const influence = barCell('bar');
    const influenceText = textEl('span', { class: 'v', 'data-testid': `sensor-influence-${id}` }, percent(0));
    const accepted = textEl('span', { class: 'v', 'data-testid': `sensor-accepted-${id}` }, '0');
    const rejected = textEl('span', { class: 'v', 'data-testid': `sensor-rejected-${id}` }, '0');
    const disturbance = textEl('span', { class: 'badge badge--warn', 'data-testid': `sensor-disturbance-${id}` }, '');

    const el = h('article', { class: 'sensor-card', 'data-testid': `sensor-card-${id}`, 'data-sensor': id }, [
      h('header', { class: 'sensor-card__head' }, [
        h('label', { class: 'check' }, [enable, h('span', { class: 'sensor-card__id' }, [id])]),
        name.el,
        rate.el,
        isolated,
      ]),
      h('div', { class: 'sensor-card__row' }, [
        h('span', { class: 'k' }, ['NIS']),
        nis.el,
        h('span', { class: 'k' }, ['mean']),
        meanNis.el,
        h('span', { class: 'k' }, ['gate']),
        gate.el,
      ]),
      h('div', { class: 'sensor-card__row sensor-card__row--bar' }, [h('span', { class: 'k' }, ['influence']), influence.el, influenceText.el]),
      h('div', { class: 'sensor-card__row' }, [
        h('span', { class: 'k' }, ['acc']),
        accepted.el,
        h('span', { class: 'k' }, ['rej']),
        rejected.el,
        disturbance.el,
      ]),
    ]);
    list.appendChild(el);

    const card: SensorCard = {
      el,
      enable,
      lastEnabled: true,
      name,
      rate,
      nis,
      meanNis,
      gate,
      influence,
      influenceText,
      accepted,
      rejected,
      isolatedHidden: hiddenCell(isolated, true),
      disturbance,
      disturbanceHidden: hiddenCell(disturbance.el, true),
      isolatedClass: classCell(el, 'is-isolated'),
      disabledClass: classCell(el, 'is-disabled'),
      rejectingClass: classCell(el, 'is-rejecting'),
    };
    cards.set(id, card);
    return card;
  };

  for (const id of SENSOR_ORDER) makeCard(id);

  const render = (card: SensorCard, s: SensorStatus): void => {
    if (s.enabled !== card.lastEnabled) {
      card.lastEnabled = s.enabled;
      card.enable.checked = s.enabled;
    }
    card.name.set(s.name || s.id);
    card.rate.set(`${integer(s.rateHz)} Hz`);
    card.nis.set(fixed(s.lastNis, 1));
    card.meanNis.set(fixed(s.meanNis, 1));
    card.gate.set(fixed(s.gateChi2, 2));
    card.influence.set(s.meanInfluence);
    card.influenceText.set(percent(s.meanInfluence));
    card.accepted.set(integer(s.accepted));
    card.rejected.set(integer(s.rejected));
    card.isolatedHidden.set(!s.isolated);
    const disturbed = hasDisturbance(s);
    card.disturbance.set(disturbed ? disturbanceText(s) : '');
    card.disturbanceHidden.set(!disturbed);
    card.isolatedClass.set(s.isolated);
    card.disabledClass.set(!s.enabled);
    card.rejectingClass.set(Number.isFinite(s.lastNis) && s.lastNis > s.gateChi2);
  };

  return {
    update(frame: FrameMessage): void {
      const sensors = frame.snapshot.sensors;
      for (let i = 0; i < sensors.length; i++) {
        const s = sensors[i] as SensorStatus;
        render(cards.get(s.id) ?? makeCard(s.id), s);
      }
    },
  };
}
