/**
 * Scenario interpreter: maps authored event times onto sim ticks so the
 * orchestrator can ask "what fires on this tick?" in O(1), and names the
 * current phase for the HUD.
 */
import { secondsToTick } from '../core/constants';
import type { IScenarioPlayer } from '../core/interfaces';
import type { Scenario, ScenarioEvent } from '../core/types';

/**
 * Tick on which a timed event's effect expires: `secondsToTick(t + durationS)`,
 * or `Infinity` for events with no (or an omitted) `durationS`. The
 * orchestrator passes this straight through as `untilTick`.
 */
export function eventUntilTick(e: ScenarioEvent): number {
  if ('durationS' in e && typeof e.durationS === 'number') return secondsToTick(e.t + e.durationS);
  return Infinity;
}

/** Tick on which an event starts. */
export function eventStartTick(e: ScenarioEvent): number {
  return secondsToTick(e.t);
}

/**
 * Plays back a validated `Scenario`. Event ticks are precomputed once in the
 * constructor; `eventsDue` and `phaseAt` allocate nothing beyond the returned
 * array so they are safe to call every tick.
 */
export class ScenarioPlayer implements IScenarioPlayer {
  readonly scenario: Scenario;
  /** Distinct ticks on which at least one event fires, ascending. */
  readonly ticks: readonly number[];
  private readonly byTick: Map<number, ScenarioEvent[]>;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.byTick = new Map();
    for (const e of scenario.events) {
      const tick = eventStartTick(e);
      const bucket = this.byTick.get(tick);
      if (bucket) bucket.push(e);
      else this.byTick.set(tick, [e]);
    }
    this.ticks = Array.from(this.byTick.keys()).sort((a, b) => a - b);
  }

  /** Total ticks in the scenario (`secondsToTick(durationS)`). */
  get durationTicks(): number {
    return secondsToTick(this.scenario.durationS);
  }

  /** Events whose start tick equals `tick`, in authored order; a new array each call. */
  eventsDue(tick: number): ScenarioEvent[] {
    const bucket = this.byTick.get(tick);
    return bucket ? bucket.slice() : [];
  }

  /**
   * Name of the phase with the greatest `t <= time` (the temporally last one
   * that has started). Before the first phase starts, the first phase's name.
   *
   * `parseScenario` guarantees at least one phase in strictly ascending
   * order, so for a validated scenario this is simply the last authored phase
   * with `t <= time`. A hand-built `Scenario` that bypasses the schema is
   * still handled: unsorted phases resolve by time (later authored wins a
   * tie), and an empty phase list yields `''`.
   */
  phaseAt(time: number): string {
    const phases = this.scenario.phases;
    let name = phases[0]?.name ?? '';
    let best = -Infinity;
    for (const p of phases) {
      if (p.t <= time && p.t >= best) {
        best = p.t;
        name = p.name;
      }
    }
    return name;
  }
}
