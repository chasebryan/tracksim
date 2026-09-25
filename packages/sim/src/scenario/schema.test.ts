import { describe, expect, it } from 'vitest';
import type { Scenario } from '../core/types';
import { ScenarioValidationError, formatIssuePath, parseScenario } from './schema';

/** A small but complete scenario exercising every event type once. */
function validScenario(): Scenario {
  return {
    id: 'unit',
    name: 'Unit test scenario',
    description: 'Exercises every event type.',
    durationS: 60,
    seed: 7,
    platform: { pos: [0, 0], vel: [0, 250], alt: 9000 },
    phases: [
      { t: 0, name: 'Start' },
      { t: 30, name: 'Middle' },
    ],
    contacts: [
      { id: 1, kind: 'beacon', label: 'friendly', declared: true, pos: [1000, 8000], vel: [0, 240], elevationDeg: 2, jitter: 0.5 },
      { id: 2, kind: 'vehicle', label: 'hostile', declared: false, pos: [12000, 20000], vel: [-50, 100], elevationDeg: 5, jitter: 2, pd: 0.9, spawnAt: 5, despawnAt: 55 },
    ],
    events: [
      { t: 1, type: 'sensor.noise', sensor: 'TERRAIN', scale: 10, durationS: 5 },
      { t: 2, type: 'sensor.bias', sensor: 'SWARM', bias: [400, -150] },
      { t: 3, type: 'sensor.enable', sensor: 'STAR', enabled: false },
      { t: 4, type: 'platform.turn', rateDegS: 3, durationS: 10 },
      { t: 5, type: 'platform.accel', mps2: 1.5, durationS: 10 },
      { t: 6, type: 'radar.clutter', rate: 10, durationS: 20 },
      { t: 7, type: 'radar.pd', pd: 0.8 },
      {
        t: 8,
        type: 'contacts.spawn',
        contacts: [
          { id: 3, kind: 'decoy', label: 'decoy', declared: false, pos: [12500, 21000], vel: [-40, 110], elevationDeg: 5, jitter: 60, pd: 0.65, spawnAt: 8, despawnAt: 30 },
        ],
      },
      { t: 9, type: 'contact.despawn', id: 3 },
      { t: 10, type: 'intel', contactId: 2, label: 'hostile' },
      { t: 11, type: 'log', message: 'hello', level: 'warn' },
      { t: 12, type: 'log', message: 'no level' },
    ],
  };
}

/** Round-trip through JSON so the input is exactly what a file would give us. */
function asJson(s: unknown): unknown {
  return JSON.parse(JSON.stringify(s));
}

function errorOf(json: unknown): ScenarioValidationError {
  try {
    parseScenario(json);
  } catch (err) {
    if (err instanceof ScenarioValidationError) return err;
    throw err;
  }
  throw new Error('expected parseScenario to throw');
}

describe('parseScenario', () => {
  it('accepts a valid scenario and returns an equal, fully typed object', () => {
    const input = validScenario();
    const parsed = parseScenario(asJson(input));
    expect(parsed).toEqual(input);
    expect(parsed.events).toHaveLength(12);
    expect(parsed.contacts[1]?.pd).toBe(0.9);
  });

  it('returns a fresh deep copy rather than the input object', () => {
    const input = validScenario();
    const parsed = parseScenario(input);
    expect(parsed).not.toBe(input);
    expect(parsed.platform.pos).not.toBe(input.platform.pos);
    parsed.platform.pos[0] = 999;
    parsed.contacts[0]!.pos[1] = -1;
    expect(input.platform.pos[0]).toBe(0);
    expect(input.contacts[0]!.pos[1]).toBe(8000);
  });

  it('accepts optional fields when omitted', () => {
    const s = validScenario();
    s.contacts = [{ id: 1, kind: 'vehicle', label: 'unknown', declared: false, pos: [0, 5000], vel: [0, 100], elevationDeg: 0, jitter: 1 }];
    s.events = [{ t: 0.5, type: 'log', message: 'x' }];
    const parsed = parseScenario(asJson(s));
    expect(parsed.contacts[0]).not.toHaveProperty('pd');
    expect(parsed.events[0]).not.toHaveProperty('level');
  });

  it('rejects events that round to tick 0, which Simulation.step never produces', () => {
    const s = validScenario();
    s.events[0]!.t = 0;
    // 0.004 s * 100 Hz = 0.4 -> tick 0 (rejected); 0.01 s -> tick 1 (the first stepped tick)
    s.events[1]!.t = 0.004;
    s.events[2]!.t = 0.01;
    const err = errorOf(s);
    expect(err.issues.map((i) => i.path)).toEqual(['events[0].t', 'events[1].t']);
    expect(err.message).toMatch(/events\[0\]\.t: event time 0 rounds to tick 0/);
    expect(err.message).toMatch(/first stepped tick is 1/);
  });

  it('rejects phases that are not strictly ascending in time and names each offending phase', () => {
    const s = validScenario();
    s.phases = [
      { t: 0, name: 'A' },
      { t: 50, name: 'B' },
      { t: 20, name: 'C' },
      { t: 20, name: 'D' },
    ];
    const err = errorOf(s);
    expect(err.issues.map((i) => i.path)).toEqual(['phases[2].t', 'phases[3].t']);
    expect(err.message).toContain('phases[2].t: phase time 20 must be after the previous phase at 50');
    expect(err.message).toContain('phases[3].t: phase time 20 must be after the previous phase at 20');
  });

  it('rejects an empty phase list but not a first phase that starts after 0', () => {
    const s = validScenario();
    s.phases = [];
    const err = errorOf(s);
    expect(err.issues.map((i) => i.path)).toEqual(['phases']);
    expect(err.message).toMatch(/at least one phase/);
    s.phases = [{ t: 5, name: 'Late start' }];
    expect(() => parseScenario(asJson(s))).not.toThrow();
  });

  it('rejects a missing required field and names its path', () => {
    const s = validScenario() as unknown as Record<string, unknown>;
    delete s['durationS'];
    const err = errorOf(s);
    expect(err.issues.some((i) => i.path === 'durationS')).toBe(true);
    expect(err.message).toContain('durationS: Required');
  });

  it('rejects a missing nested field on an event', () => {
    const s = validScenario();
    const ev = s.events[3] as unknown as Record<string, unknown>;
    delete ev['durationS'];
    const err = errorOf(s);
    expect(err.issues.map((i) => i.path)).toContain('events[3].durationS');
  });

  it('rejects a wrong enum value and names its path', () => {
    const s = validScenario();
    (s.events[0] as unknown as Record<string, unknown>)['sensor'] = 'GPS';
    const err = errorOf(s);
    const issue = err.issues.find((i) => i.path === 'events[0].sensor');
    expect(issue).toBeDefined();
    expect(issue!.message).toMatch(/GPS/);
    expect(issue!.message).toMatch(/INS/);
  });

  it('rejects an unknown event type via the discriminator', () => {
    const s = validScenario();
    (s.events[1] as unknown as Record<string, unknown>)['type'] = 'sensor.explode';
    const err = errorOf(s);
    expect(err.issues.map((i) => i.path)).toContain('events[1].type');
  });

  it('rejects a bad contact kind and label inside a contacts.spawn event', () => {
    const s = validScenario();
    const spawn = s.events[7] as Extract<Scenario['events'][number], { type: 'contacts.spawn' }>;
    (spawn.contacts[0] as unknown as Record<string, unknown>)['kind'] = 'drone';
    (spawn.contacts[0] as unknown as Record<string, unknown>)['label'] = 'neutral';
    const paths = errorOf(s).issues.map((i) => i.path);
    expect(paths).toContain('events[7].contacts[0].kind');
    expect(paths).toContain('events[7].contacts[0].label');
  });

  it('rejects wrong primitive types and names each path', () => {
    const s = validScenario() as unknown as Record<string, unknown>;
    s['seed'] = 'abc';
    (s['platform'] as Record<string, unknown>)['alt'] = '9000';
    (s['contacts'] as Record<string, unknown>[])[0]!['declared'] = 'yes';
    const err = errorOf(s);
    const paths = err.issues.map((i) => i.path);
    expect(paths).toContain('seed');
    expect(paths).toContain('platform.alt');
    expect(paths).toContain('contacts[0].declared');
    // every issue is rendered on its own line as "<path>: <message>"
    for (const i of err.issues) expect(err.message).toContain(`${i.path}: ${i.message}`);
  });

  it('rejects a Vec2 that is not exactly two numbers', () => {
    const s = validScenario() as unknown as Record<string, unknown>;
    (s['platform'] as Record<string, unknown>)['vel'] = [0, 250, 1];
    const paths = errorOf(s).issues.map((i) => i.path);
    expect(paths.some((p) => p.startsWith('platform.vel'))).toBe(true);
  });

  it('rejects unknown keys (typo protection)', () => {
    const s = validScenario();
    (s.events[0] as unknown as Record<string, unknown>)['duration'] = 5;
    const err = errorOf(s);
    expect(err.issues.map((i) => i.path)).toContain('events[0]');
    expect(err.message).toMatch(/duration/);
  });

  it('rejects non-object roots with a (root) path', () => {
    expect(errorOf('nope').issues[0]!.path).toBe('(root)');
    expect(errorOf(null).issues[0]!.path).toBe('(root)');
    expect(errorOf(undefined).issues[0]!.path).toBe('(root)');
  });

  it('rejects negative times, non-positive durations and out-of-range pd', () => {
    const s = validScenario();
    s.events[0]!.t = -1;
    (s.events[3] as { durationS: number }).durationS = 0;
    s.contacts[1]!.pd = 1.5;
    const paths = errorOf(s).issues.map((i) => i.path);
    expect(paths).toContain('events[0].t');
    expect(paths).toContain('events[3].durationS');
    expect(paths).toContain('contacts[1].pd');
  });

  it('rejects events scheduled after the scenario ends', () => {
    const s = validScenario();
    s.events[11]!.t = 61;
    const paths = errorOf(s).issues.map((i) => i.path);
    expect(paths).toEqual(['events[11].t']);
    // exactly at the end is allowed
    s.events[11]!.t = 60;
    expect(() => parseScenario(s)).not.toThrow();
  });

  it('rejects duplicate contact ids across contacts and spawn events', () => {
    const s = validScenario();
    const spawn = s.events[7] as Extract<Scenario['events'][number], { type: 'contacts.spawn' }>;
    spawn.contacts[0]!.id = 2;
    s.events[8] = { t: 9, type: 'contact.despawn', id: 2 };
    const paths = errorOf(s).issues.map((i) => i.path);
    expect(paths).toEqual(['events[7].contacts[0].id']);
  });

  it('rejects contact.despawn and intel that reference unknown contact ids', () => {
    const s = validScenario();
    s.events[8] = { t: 9, type: 'contact.despawn', id: 42 };
    s.events[9] = { t: 10, type: 'intel', contactId: 43, label: 'hostile' };
    const err = errorOf(s);
    const paths = err.issues.map((i) => i.path);
    expect(paths).toContain('events[8].id');
    expect(paths).toContain('events[9].contactId');
    expect(err.message).toContain('unknown contact id 42');
  });

  it('rejects a contact whose despawnAt is not after spawnAt', () => {
    const s = validScenario();
    s.contacts[1]!.despawnAt = 5;
    const paths = errorOf(s).issues.map((i) => i.path);
    expect(paths).toEqual(['contacts[1].despawnAt']);
  });

  it('reports every problem at once', () => {
    const s = validScenario() as unknown as Record<string, unknown>;
    delete s['name'];
    s['seed'] = 1.5;
    (s['phases'] as Record<string, unknown>[])[1]!['name'] = '';
    const err = errorOf(s);
    expect(err.issues.length).toBe(3);
    expect(err.message).toMatch(/^Invalid scenario \(3 issues\):/);
    expect(err.name).toBe('ScenarioValidationError');
  });
});

describe('formatIssuePath', () => {
  it('renders dotted paths with bracketed indices', () => {
    expect(formatIssuePath([])).toBe('(root)');
    expect(formatIssuePath(['seed'])).toBe('seed');
    expect(formatIssuePath(['events', 3, 'contacts', 0, 'pos', 1])).toBe('events[3].contacts[0].pos[1]');
    expect(formatIssuePath([0, 'x'])).toBe('[0].x');
  });
});
