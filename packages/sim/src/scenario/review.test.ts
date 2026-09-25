import { describe, expect, it } from 'vitest';
import { secondsToTick } from '../core/constants';
import type { ContactSpec, ScenarioEvent, Vec2 } from '../core/types';
import { BUILTIN_SCENARIOS, getScenario } from './builtin';
import { ScenarioPlayer } from './player';

type SpawnEvent = Extract<ScenarioEvent, { type: 'contacts.spawn' }>;

describe('review: built-in events are reachable through the tick pipeline', () => {
  // CONTRACTS.md "Tick pipeline": the simulation starts at tick 0 and each
  // step() produces tick T >= 1; scenario events are applied in step 2 of the
  // step that produces their tick. Tick 0 is never produced by a step, so an
  // event with secondsToTick(t) === 0 can never fire. This mirrors exactly what
  // core/simulation.ts does (eventsDue(tick) for tick = 1..endTick) rather than
  // the tick-0-inclusive loop in builtin.test.ts, which masks the problem.
  describe.each(BUILTIN_SCENARIOS.map((s) => [s.id, s] as const))('%s', (_id, s) => {
    it('fires every authored event on some tick the orchestrator actually steps to', () => {
      const player = new ScenarioPlayer(s);
      const reached = new Set<ScenarioEvent>();
      for (let tick = 1; tick <= player.durationTicks; tick++) {
        for (const e of player.eventsDue(tick)) reached.add(e);
      }
      const unreachable = s.events.filter((e) => !reached.has(e)).map((e) => `t=${e.t} ${e.type}`);
      expect(unreachable, 'events that never fire through Simulation.step()').toEqual([]);
    });
  });
});

describe('review: full-mission decoy geometry', () => {
  it('releases its six decoys on the 300-800 m ring around contact 2 with near-parent velocity', () => {
    // Same check builtin.test.ts applies to decoy-swarm, which it skips for
    // full-mission. The parent's nominal position at release time is
    // pos + vel * t (its jitter random walk is sigma 2*sqrt(130) ~ 23 m, well
    // inside the 300-800 m ring tolerance). Velocity deltas are bounded at
    // 3 sigma of the world contract's N(0, 15) per axis.
    const s = getScenario('full-mission');
    const spawn = s.events.find((e): e is SpawnEvent => e.type === 'contacts.spawn')!;
    const ref = s.contacts.find((c: ContactSpec) => c.id === 2)!;
    const refPos: Vec2 = [ref.pos[0] + ref.vel[0] * spawn.t, ref.pos[1] + ref.vel[1] * spawn.t];
    expect(spawn.contacts).toHaveLength(6);
    for (const d of spawn.contacts) {
      const off = Math.hypot(d.pos[0] - refPos[0], d.pos[1] - refPos[1]);
      expect(off, `decoy ${d.id} ring offset`).toBeGreaterThanOrEqual(300);
      expect(off, `decoy ${d.id} ring offset`).toBeLessThanOrEqual(800);
      expect(Math.abs(d.vel[0] - ref.vel[0]), `decoy ${d.id} dvE`).toBeLessThanOrEqual(45);
      expect(Math.abs(d.vel[1] - ref.vel[1]), `decoy ${d.id} dvN`).toBeLessThanOrEqual(45);
      expect(d.spawnAt).toBe(spawn.t);
      expect(secondsToTick(d.despawnAt!)).toBeGreaterThan(secondsToTick(spawn.t));
    }
  });
});
