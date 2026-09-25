/**
 * Built-in scenarios shipped with the package. Each JSON file is validated
 * through `parseScenario` at module load, so a malformed built-in fails fast
 * on import rather than mid-run.
 */
import type { Scenario } from '../core/types';
import { parseScenario } from './schema';
import baseline from '../../scenarios/baseline.json';
import sensorDegradation from '../../scenarios/sensor-degradation.json';
import decoySwarm from '../../scenarios/decoy-swarm.json';
import fullMission from '../../scenarios/full-mission.json';

const RAW: readonly unknown[] = [baseline, sensorDegradation, decoySwarm, fullMission];

/** All built-in scenarios, validated on import, in menu order. */
export const BUILTIN_SCENARIOS: Scenario[] = RAW.map((json) => parseScenario(json));

/** Ids of the built-in scenarios, in the same order as `BUILTIN_SCENARIOS`. */
export const BUILTIN_SCENARIO_IDS: readonly string[] = BUILTIN_SCENARIOS.map((s) => s.id);

const RAW_BY_ID = new Map<string, unknown>(BUILTIN_SCENARIOS.map((s, i) => [s.id, RAW[i]]));

/**
 * Look up a built-in scenario by id. Returns a fresh deep copy each call (the
 * JSON is re-parsed), so a simulation may hold and even mutate it without
 * affecting other runs. Throws for an unknown id.
 */
export function getScenario(id: string): Scenario {
  const raw = RAW_BY_ID.get(id);
  if (raw === undefined) {
    throw new Error(`Unknown scenario id '${id}'. Built-in scenarios: ${BUILTIN_SCENARIO_IDS.join(', ')}`);
  }
  return parseScenario(raw);
}
