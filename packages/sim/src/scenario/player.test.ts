import { describe, expect, it } from 'vitest';
import { TICK_HZ, secondsToTick } from '../core/constants';
import type { Scenario, ScenarioEvent } from '../core/types';
import { ScenarioPlayer, eventStartTick, eventUntilTick } from './player';

function scenario(events: ScenarioEvent[], phases: Scenario['phases'] = [{ t: 0, name: 'Only' }]): Scenario {
  return {
    id: 'p',
    name: 'Player test',
    description: '',
    durationS: 100,
    seed: 1,
    platform: { pos: [0, 0], vel: [0, 250], alt: 9000 },
    phases,
    contacts: [],
    events,
  };
}

describe('ScenarioPlayer.eventsDue', () => {
  // Events are authored out of time order and share ticks deliberately: the
  // player must bucket by tick yet preserve authored order inside a bucket.
  const events: ScenarioEvent[] = [
    { t: 10, type: 'log', message: 'a' },
    { t: 0, type: 'log', message: 'b' },
    { t: 10, type: 'sensor.enable', sensor: 'STAR', enabled: false },
    { t: 2.5, type: 'radar.clutter', rate: 10, durationS: 5 },
    { t: 10, type: 'intel', contactId: 1, label: 'hostile' },
  ];
  const player = new ScenarioPlayer(scenario(events));

  it('returns every event whose tick matches, in authored order', () => {
    const due = player.eventsDue(secondsToTick(10));
    expect(due).toEqual([events[0], events[2], events[4]]);
    expect(due[0]).toBe(events[0]);
  });

  it('returns single events at tick 0 and at fractional-second ticks', () => {
    expect(player.eventsDue(0)).toEqual([events[1]]);
    expect(player.eventsDue(250)).toEqual([events[3]]);
  });

  it('returns nothing on every other tick', () => {
    const expected = new Set([0, 250, 1000]);
    const strayTicks: number[] = [];
    let total = 0;
    for (let tick = -10; tick <= secondsToTick(100) + 10; tick++) {
      const n = player.eventsDue(tick).length;
      total += n;
      if (n > 0 && !expected.has(tick)) strayTicks.push(tick);
    }
    expect(strayTicks).toEqual([]);
    expect(total).toBe(events.length);
    expect(player.eventsDue(999)).toEqual([]);
    expect(player.eventsDue(1001)).toEqual([]);
  });

  it('returns a new array each call so callers cannot corrupt the schedule', () => {
    const a = player.eventsDue(1000);
    a.pop();
    expect(player.eventsDue(1000)).toHaveLength(3);
    expect(player.eventsDue(1000)).not.toBe(a);
  });

  it('exposes distinct event ticks ascending and the scenario reference', () => {
    expect(player.ticks).toEqual([0, 250, 1000]);
    expect(player.durationTicks).toBe(100 * TICK_HZ);
    expect(player.scenario.events).toBe(events);
  });

  it('rounds sub-tick times to the nearest tick like secondsToTick', () => {
    const p = new ScenarioPlayer(scenario([{ t: 0.126, type: 'log', message: 'x' }]));
    // 0.126 s * 100 Hz = 12.6 -> tick 13
    expect(p.eventsDue(13)).toHaveLength(1);
    expect(p.eventsDue(12)).toHaveLength(0);
  });
});

describe('ScenarioPlayer.phaseAt', () => {
  const player = new ScenarioPlayer(
    scenario([], [
      { t: 5, name: 'First' },
      { t: 30, name: 'Second' },
      { t: 30.5, name: 'Third' },
      { t: 80, name: 'Fourth' },
    ]),
  );

  it('returns the first phase before any phase has started', () => {
    expect(player.phaseAt(0)).toBe('First');
    expect(player.phaseAt(4.99)).toBe('First');
  });

  it('returns the last phase whose t <= time, inclusive at the boundary', () => {
    expect(player.phaseAt(5)).toBe('First');
    expect(player.phaseAt(29.99)).toBe('First');
    expect(player.phaseAt(30)).toBe('Second');
    expect(player.phaseAt(30.49)).toBe('Second');
    expect(player.phaseAt(30.5)).toBe('Third');
    expect(player.phaseAt(80)).toBe('Fourth');
    expect(player.phaseAt(1e9)).toBe('Fourth');
  });

  it('returns an empty string when the scenario has no phases', () => {
    expect(new ScenarioPlayer(scenario([], [])).phaseAt(10)).toBe('');
  });

  it('resolves by time, not authored order, when a schema-bypassing scenario has unsorted phases', () => {
    // parseScenario rejects this list; a hand-built Scenario still gets the
    // phase with the greatest t <= time, with a later authored phase winning a tie.
    const p = new ScenarioPlayer(
      scenario([], [
        { t: 0, name: 'A' },
        { t: 50, name: 'B' },
        { t: 20, name: 'C' },
        { t: 20, name: 'D' },
      ]),
    );
    expect(p.phaseAt(10)).toBe('A');
    expect(p.phaseAt(19.99)).toBe('A');
    expect(p.phaseAt(20)).toBe('D');
    expect(p.phaseAt(49.99)).toBe('D');
    expect(p.phaseAt(50)).toBe('B');
    expect(p.phaseAt(1e9)).toBe('B');
  });
});

describe('eventUntilTick / eventStartTick', () => {
  it('returns secondsToTick(t + durationS) when a duration is present', () => {
    expect(eventUntilTick({ t: 30, type: 'sensor.noise', sensor: 'TERRAIN', scale: 10, durationS: 40 })).toBe(7000);
    expect(eventUntilTick({ t: 50, type: 'platform.turn', rateDegS: 3, durationS: 15 })).toBe(6500);
    expect(eventUntilTick({ t: 200, type: 'platform.accel', mps2: 1.5, durationS: 20 })).toBe(22000);
    expect(eventUntilTick({ t: 70, type: 'radar.clutter', rate: 10, durationS: 40 })).toBe(11000);
    expect(eventUntilTick({ t: 1.5, type: 'radar.pd', pd: 0.8, durationS: 0.25 })).toBe(175);
    expect(eventUntilTick({ t: 90, type: 'sensor.bias', sensor: 'SWARM', bias: [400, -150], durationS: 50 })).toBe(14000);
  });

  it('returns Infinity when durationS is omitted or the event type has none', () => {
    expect(eventUntilTick({ t: 30, type: 'sensor.noise', sensor: 'TERRAIN', scale: 10 })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'radar.clutter', rate: 10 })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'radar.pd', pd: 0.5 })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'sensor.bias', sensor: 'SWARM', bias: [1, 2] })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'sensor.enable', sensor: 'STAR', enabled: true })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'contacts.spawn', contacts: [] })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'contact.despawn', id: 1 })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'intel', contactId: 1, label: 'decoy' })).toBe(Infinity);
    expect(eventUntilTick({ t: 30, type: 'log', message: 'm' })).toBe(Infinity);
  });

  it('treats an explicitly undefined durationS as absent', () => {
    const e = { t: 3, type: 'radar.clutter', rate: 1, durationS: undefined } as ScenarioEvent;
    expect(eventUntilTick(e)).toBe(Infinity);
  });

  it('eventStartTick matches secondsToTick', () => {
    expect(eventStartTick({ t: 40, type: 'log', message: 'x' })).toBe(4000);
    expect(eventStartTick({ t: 0.126, type: 'log', message: 'x' })).toBe(13);
  });
});
