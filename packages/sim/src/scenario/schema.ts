/**
 * Zod schema for scenario files. Mirrors `Scenario`, `ScenarioEvent`,
 * `ScenarioPhase` and `ContactSpec` from core/types exactly, plus the
 * sanity checks a hand-authored JSON file can get wrong (negative times,
 * events that round to the never-stepped tick 0, unsorted phases, duplicate
 * contact ids, events that reference contacts that do not exist).
 *
 * `parseScenario` is the single entry point; it throws a
 * `ScenarioValidationError` whose message lists every problem as
 * `<path>: <message>` so an author can fix them all in one pass.
 */
import { z } from 'zod';
import { secondsToTick } from '../core/constants';
import { SENSOR_IDS } from '../core/types';
import type { ContactSpec, Scenario, ScenarioEvent, ScenarioPhase } from '../core/types';

const finite = z.number().finite();
const seconds = finite.nonnegative();
const durationS = finite.positive();
const vec2 = z.tuple([finite, finite]);
const contactId = z.number().int();

const sensorId = z.enum(SENSOR_IDS);
const trackLabel = z.enum(['friendly', 'unknown', 'hostile', 'decoy']);
const contactKind = z.enum(['vehicle', 'decoy', 'beacon']);
const eventLevel = z.enum(['info', 'warn', 'alert']);

/** Schema for a single `ContactSpec`. */
export const contactSpecSchema = z
  .object({
    id: contactId,
    kind: contactKind,
    label: trackLabel,
    declared: z.boolean(),
    pos: vec2,
    vel: vec2,
    elevationDeg: finite,
    jitter: finite.nonnegative(),
    pd: finite.min(0).max(1).optional(),
    spawnAt: seconds.optional(),
    despawnAt: seconds.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.spawnAt !== undefined && c.despawnAt !== undefined && c.despawnAt <= c.spawnAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['despawnAt'],
        message: `despawnAt (${c.despawnAt}) must be after spawnAt (${c.spawnAt})`,
      });
    }
  }) satisfies z.ZodType<ContactSpec>;

/** Schema for a single `ScenarioEvent`, discriminated on `type`. */
export const scenarioEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      t: seconds,
      type: z.literal('sensor.noise'),
      sensor: sensorId,
      scale: finite.nonnegative(),
      durationS: durationS.optional(),
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('sensor.bias'),
      sensor: sensorId,
      bias: vec2,
      durationS: durationS.optional(),
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('sensor.enable'),
      sensor: sensorId,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('platform.turn'),
      rateDegS: finite,
      durationS,
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('platform.accel'),
      mps2: finite,
      durationS,
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('radar.clutter'),
      rate: finite.nonnegative(),
      durationS: durationS.optional(),
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('radar.pd'),
      pd: finite.min(0).max(1),
      durationS: durationS.optional(),
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('contacts.spawn'),
      contacts: z.array(contactSpecSchema),
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('contact.despawn'),
      id: contactId,
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('intel'),
      contactId,
      label: trackLabel,
    })
    .strict(),
  z
    .object({
      t: seconds,
      type: z.literal('log'),
      message: z.string(),
      level: eventLevel.optional(),
    })
    .strict(),
]) satisfies z.ZodType<ScenarioEvent>;

/** Schema for a `ScenarioPhase`. */
export const scenarioPhaseSchema = z
  .object({
    t: seconds,
    name: z.string().min(1),
  })
  .strict() satisfies z.ZodType<ScenarioPhase>;

/** Schema for a whole `Scenario`, including cross-field checks. */
export const scenarioSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    durationS,
    seed: z.number().int(),
    platform: z.object({ pos: vec2, vel: vec2, alt: finite }).strict(),
    phases: z.array(scenarioPhaseSchema).min(1, 'a scenario needs at least one phase (the HUD shows its name)'),
    contacts: z.array(contactSpecSchema),
    events: z.array(scenarioEventSchema),
  })
  .strict()
  .superRefine((s, ctx) => {
    // Phases must be authored in strictly ascending time so "the last phase
    // with t <= time" is unambiguous and phaseAt is a simple scan.
    for (let i = 1; i < s.phases.length; i++) {
      const prev = (s.phases[i - 1] as ScenarioPhase).t;
      const cur = (s.phases[i] as ScenarioPhase).t;
      if (!(cur > prev)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phases', i, 't'],
          message: `phase time ${cur} must be after the previous phase at ${prev}`,
        });
      }
    }
    const known = new Set<number>();
    const claim = (id: number, path: (string | number)[]): void => {
      if (known.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `duplicate contact id ${id}` });
      }
      known.add(id);
    };
    s.contacts.forEach((c, i) => claim(c.id, ['contacts', i, 'id']));
    s.events.forEach((e, i) => {
      if (e.type === 'contacts.spawn') e.contacts.forEach((c, j) => claim(c.id, ['events', i, 'contacts', j, 'id']));
    });
    s.events.forEach((e, i) => {
      // The simulation starts at tick 0 and step() only ever produces ticks
      // >= 1, so an event whose time rounds to tick 0 would never fire.
      if (secondsToTick(e.t) === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', i, 't'],
          message: `event time ${e.t} rounds to tick 0, which is never stepped; the first stepped tick is 1 (t = 0.01)`,
        });
      }
      if (e.t > s.durationS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', i, 't'],
          message: `event time ${e.t} is after the scenario ends at ${s.durationS}`,
        });
      }
      if (e.type === 'contact.despawn' && !known.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', i, 'id'],
          message: `unknown contact id ${e.id}`,
        });
      }
      if (e.type === 'intel' && !known.has(e.contactId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', i, 'contactId'],
          message: `unknown contact id ${e.contactId}`,
        });
      }
    });
  }) satisfies z.ZodType<Scenario>;

/** One validation problem: where it is and what is wrong. */
export interface ScenarioIssue {
  /** Dotted path with bracketed indices, e.g. `events[3].sensor`; `(root)` for the top level. */
  path: string;
  message: string;
}

/** Thrown by `parseScenario`; `message` lists every issue, one per line. */
export class ScenarioValidationError extends Error {
  readonly issues: readonly ScenarioIssue[];

  constructor(issues: ScenarioIssue[]) {
    const lines = issues.map((i) => `  ${i.path}: ${i.message}`);
    super(`Invalid scenario (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${lines.join('\n')}`);
    this.name = 'ScenarioValidationError';
    this.issues = issues;
  }
}

/** Format a zod issue path as `a.b[2].c`; empty path becomes `(root)`. */
export function formatIssuePath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length === 0 ? seg : `.${seg}`;
  }
  return out;
}

/**
 * Validate untrusted JSON as a `Scenario`. Returns a fresh, fully typed
 * object (zod copies every object, array and tuple, so callers may mutate the
 * result without touching the input). Throws `ScenarioValidationError` with
 * every problem listed as `<path>: <message>`.
 */
export function parseScenario(json: unknown): Scenario {
  const result = scenarioSchema.safeParse(json);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: formatIssuePath(i.path), message: i.message }));
  throw new ScenarioValidationError(issues);
}
