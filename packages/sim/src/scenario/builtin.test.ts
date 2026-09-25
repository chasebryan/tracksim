import { describe, expect, it } from 'vitest';
import { DEG, DT, secondsToTick } from '../core/constants';
import type { ContactSpec, Scenario, ScenarioEvent, Vec2 } from '../core/types';
import { BUILTIN_SCENARIOS, BUILTIN_SCENARIO_IDS, getScenario } from './builtin';
import { ScenarioPlayer } from './player';

const EXPECTED: Record<string, number> = {
  baseline: 120,
  'sensor-degradation': 180,
  'decoy-swarm': 150,
  'full-mission': 300,
};

type SpawnEvent = Extract<ScenarioEvent, { type: 'contacts.spawn' }>;

/** Every contact spec in a scenario with the time it enters the world. */
function allContacts(s: Scenario): { spec: ContactSpec; spawnT: number; fromEvent: boolean }[] {
  const out = s.contacts.map((spec) => ({ spec, spawnT: spec.spawnAt ?? 0, fromEvent: false }));
  for (const e of s.events) {
    if (e.type !== 'contacts.spawn') continue;
    for (const spec of e.contacts) out.push({ spec, spawnT: Math.max(e.t, spec.spawnAt ?? 0), fromEvent: true });
  }
  return out;
}

/**
 * Platform truth position per tick, integrated exactly as CONTRACTS.md "world/"
 * specifies (heading += turnRate*DT, speed += accel*DT, pos += vel*DT) with the
 * scenario's platform.turn / platform.accel events applied on their tick and
 * reset once tick >= untilTick. Contacts do not affect it, so this is enough
 * to know where the platform is when anything spawns.
 */
function platformTrack(s: Scenario): Vec2[] {
  const player = new ScenarioPlayer(s);
  let pos: Vec2 = [s.platform.pos[0], s.platform.pos[1]];
  let heading = Math.atan2(s.platform.vel[0], s.platform.vel[1]);
  let speed = Math.hypot(s.platform.vel[0], s.platform.vel[1]);
  let turnRate = 0;
  let turnUntil = 0;
  let accel = 0;
  let accelUntil = 0;
  const track: Vec2[] = [[pos[0], pos[1]]];
  const end = secondsToTick(s.durationS);
  for (let tick = 1; tick <= end; tick++) {
    for (const e of player.eventsDue(tick)) {
      if (e.type === 'platform.turn') {
        turnRate = e.rateDegS * DEG;
        turnUntil = secondsToTick(e.t + e.durationS);
      } else if (e.type === 'platform.accel') {
        accel = e.mps2;
        accelUntil = secondsToTick(e.t + e.durationS);
      }
    }
    if (tick >= turnUntil) turnRate = 0;
    if (tick >= accelUntil) accel = 0;
    heading += turnRate * DT;
    speed = Math.max(0, speed + accel * DT);
    pos = [pos[0] + speed * Math.sin(heading) * DT, pos[1] + speed * Math.cos(heading) * DT];
    track.push([pos[0], pos[1]]);
  }
  return track;
}

/** Time at which a contact leaves the world: despawnAt, a contact.despawn event, or scenario end. */
function despawnTime(s: Scenario, spec: ContactSpec): number {
  let t = Math.min(spec.despawnAt ?? Infinity, s.durationS);
  for (const e of s.events) if (e.type === 'contact.despawn' && e.id === spec.id) t = Math.min(t, e.t);
  return t;
}

describe('BUILTIN_SCENARIOS', () => {
  it('contains exactly the four contracted scenarios with unique ids and durations', () => {
    expect(BUILTIN_SCENARIOS).toHaveLength(4);
    expect(BUILTIN_SCENARIO_IDS).toEqual(['baseline', 'sensor-degradation', 'decoy-swarm', 'full-mission']);
    expect(new Set(BUILTIN_SCENARIO_IDS).size).toBe(4);
    for (const s of BUILTIN_SCENARIOS) expect(s.durationS).toBe(EXPECTED[s.id]);
  });

  it('full-mission lasts 300 s', () => {
    expect(getScenario('full-mission').durationS).toBe(300);
  });

  describe.each(BUILTIN_SCENARIOS.map((s) => [s.id, s] as const))('%s', (_id, s) => {
    it('has a name, a description and 4-5 named phases starting at 0 with strictly increasing times', () => {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.phases.length).toBeGreaterThanOrEqual(4);
      expect(s.phases.length).toBeLessThanOrEqual(5);
      expect(s.phases[0]!.t).toBe(0);
      for (let i = 1; i < s.phases.length; i++) {
        expect(s.phases[i]!.t).toBeGreaterThan(s.phases[i - 1]!.t);
        expect(s.phases[i]!.t).toBeLessThan(s.durationS);
      }
      for (const p of s.phases) expect(p.name.trim().length).toBeGreaterThan(0);
      expect(new Set(s.phases.map((p) => p.name)).size).toBe(s.phases.length);
    });

    it('starts the platform at the origin at 250 m/s', () => {
      expect(s.platform.pos).toEqual([0, 0]);
      // hypot of the authored velocity is exactly 250 for [0, 250]; allow float slack for other headings
      expect(Math.hypot(s.platform.vel[0], s.platform.vel[1])).toBeCloseTo(250, 6);
      expect(s.platform.alt).toBeGreaterThan(0);
    });

    it('schedules every event within [0, durationS]', () => {
      expect(s.events.length).toBeGreaterThan(0);
      for (const e of s.events) {
        expect(e.t).toBeGreaterThanOrEqual(0);
        expect(e.t).toBeLessThanOrEqual(s.durationS);
        if ('durationS' in e && e.durationS !== undefined) {
          expect(e.durationS).toBeGreaterThan(0);
          expect(e.t + e.durationS).toBeLessThanOrEqual(s.durationS);
        }
      }
    });

    it('numbers contacts 1..n across contacts and spawn events', () => {
      const ids = allContacts(s).map((c) => c.spec.id);
      expect(ids).toEqual(ids.map((_, i) => i + 1));
    });

    it('has exactly one declared friendly beacon and no other declared contacts', () => {
      const declared = allContacts(s).filter((c) => c.spec.declared);
      expect(declared).toHaveLength(1);
      expect(declared[0]!.spec.kind).toBe('beacon');
      expect(declared[0]!.spec.label).toBe('friendly');
    });

    it('places every contact 5-45 km from the platform at spawn, moving at 50-300 m/s, elevation -5..20 deg', () => {
      const track = platformTrack(s);
      for (const { spec, spawnT } of allContacts(s)) {
        const plat = track[secondsToTick(spawnT)]!;
        const range = Math.hypot(spec.pos[0] - plat[0], spec.pos[1] - plat[1]);
        const speed = Math.hypot(spec.vel[0], spec.vel[1]);
        expect(range, `contact ${spec.id} range at spawn`).toBeGreaterThanOrEqual(5000);
        expect(range, `contact ${spec.id} range at spawn`).toBeLessThanOrEqual(45000);
        expect(speed, `contact ${spec.id} speed`).toBeGreaterThanOrEqual(50);
        expect(speed, `contact ${spec.id} speed`).toBeLessThanOrEqual(300);
        expect(spec.elevationDeg).toBeGreaterThanOrEqual(-5);
        expect(spec.elevationDeg).toBeLessThanOrEqual(20);
        expect(spec.jitter).toBeGreaterThanOrEqual(0);
      }
    });

    it('keeps every contact inside the 60 km radar horizon for its whole life', () => {
      // Contacts follow their authored velocity plus a random walk of sigma
      // jitter*sqrt(t): at most 60*sqrt(40) ~ 380 m for a decoy and 3*sqrt(300)
      // ~ 52 m for a vehicle, so a 2 km margin below maxRange = 60 km is ample.
      const track = platformTrack(s);
      for (const { spec, spawnT } of allContacts(s)) {
        const t0 = secondsToTick(spawnT);
        const t1 = secondsToTick(despawnTime(s, spec));
        let worst = 0;
        for (let tick = t0; tick <= t1; tick++) {
          const dt = (tick - t0) * DT;
          const plat = track[tick]!;
          const r = Math.hypot(spec.pos[0] + spec.vel[0] * dt - plat[0], spec.pos[1] + spec.vel[1] * dt - plat[1]);
          if (r > worst) worst = r;
        }
        expect(worst, `contact ${spec.id} max range`).toBeLessThan(58000);
      }
    });

    it('references only existing contact ids from contact.despawn and intel events', () => {
      const ids = new Set(allContacts(s).map((c) => c.spec.id));
      let refs = 0;
      for (const e of s.events) {
        if (e.type === 'contact.despawn') {
          refs++;
          expect(ids.has(e.id), `despawn of ${e.id}`).toBe(true);
        }
        if (e.type === 'intel') {
          refs++;
          expect(ids.has(e.contactId), `intel on ${e.contactId}`).toBe(true);
        }
      }
      if (s.id === 'baseline' || s.id === 'full-mission') expect(refs).toBeGreaterThan(0);
    });

    it('authors decoys exactly as the world contract expects', () => {
      for (const { spec, fromEvent } of allContacts(s)) {
        if (spec.kind !== 'decoy') {
          expect(spec.label).not.toBe('decoy');
          continue;
        }
        expect(fromEvent).toBe(true);
        expect(spec.label).toBe('decoy');
        expect(spec.declared).toBe(false);
        expect(spec.jitter).toBe(60);
        expect(spec.pd).toBe(0.65);
        expect(spec.spawnAt).toBeDefined();
        expect(spec.despawnAt).toBeDefined();
        expect(spec.despawnAt!).toBeGreaterThan(spec.spawnAt!);
        expect(spec.despawnAt! - spec.spawnAt!).toBeGreaterThanOrEqual(20);
        expect(spec.despawnAt! - spec.spawnAt!).toBeLessThanOrEqual(40);
      }
    });

    it('plays through a ScenarioPlayer with every event reachable and a phase on every tick', () => {
      // Mirrors Simulation.step: the sim starts at tick 0 and each step
      // produces tick T >= 1, so nothing is ever due at tick 0. The loop must
      // start at 1, not 0, or an event authored at t = 0 would look reachable.
      const player = new ScenarioPlayer(s);
      let seen = 0;
      let unnamedTicks = 0;
      expect(player.eventsDue(0)).toEqual([]);
      for (let tick = 1; tick <= secondsToTick(s.durationS); tick++) {
        seen += player.eventsDue(tick).length;
        if (player.phaseAt(tick * DT).length === 0) unnamedTicks++;
      }
      expect(seen).toBe(s.events.length);
      expect(unnamedTicks).toBe(0);
      expect(player.phaseAt(0)).toBe(s.phases[0]!.name);
      expect(player.phaseAt(s.durationS)).toBe(s.phases[s.phases.length - 1]!.name);
    });

    it('announces itself with a log line on tick 1, the first tick Simulation.step produces', () => {
      const player = new ScenarioPlayer(s);
      const opening = player.eventsDue(1).filter((e) => e.type === 'log');
      expect(opening).toHaveLength(1);
      expect(opening[0]).toMatchObject({ t: 0.01, level: 'info' });
    });

    it('releases every decoy on the 300-800 m ring around an alive non-decoy contact with near-parent velocity', () => {
      // Mirrors World.spawnDecoys: pos = parent pos + uniform ring 300-800 m,
      // vel = parent vel + N(0, 15) per axis (3 sigma = 45 m/s). The parent is
      // the nearest non-decoy contact alive at release, at its nominal
      // pos + vel * (t - spawnAt); its jitter random walk (sigma at most
      // 3*sqrt(300) ~ 52 m) is well inside the ring tolerance.
      const candidates = allContacts(s).filter((c) => c.spec.kind !== 'decoy');
      let decoys = 0;
      for (const e of s.events) {
        if (e.type !== 'contacts.spawn') continue;
        const alive = candidates.filter((c) => c.spawnT <= e.t && e.t < despawnTime(s, c.spec));
        expect(alive.length, `alive parents at t=${e.t}`).toBeGreaterThan(0);
        for (const d of e.contacts) {
          if (d.kind !== 'decoy') continue;
          decoys++;
          let parent = alive[0]!;
          let off = Infinity;
          for (const c of alive) {
            const dt = e.t - c.spawnT;
            const r = Math.hypot(d.pos[0] - (c.spec.pos[0] + c.spec.vel[0] * dt), d.pos[1] - (c.spec.pos[1] + c.spec.vel[1] * dt));
            if (r < off) {
              off = r;
              parent = c;
            }
          }
          const tag = `decoy ${d.id} vs contact ${parent.spec.id}`;
          expect(off, `${tag} ring offset`).toBeGreaterThanOrEqual(300);
          expect(off, `${tag} ring offset`).toBeLessThanOrEqual(800);
          expect(Math.abs(d.vel[0] - parent.spec.vel[0]), `${tag} dvE`).toBeLessThanOrEqual(45);
          expect(Math.abs(d.vel[1] - parent.spec.vel[1]), `${tag} dvN`).toBeLessThanOrEqual(45);
          expect(d.spawnAt, `${tag} spawnAt`).toBe(e.t);
        }
      }
      if (s.id === 'decoy-swarm' || s.id === 'full-mission') expect(decoys).toBe(6);
      else expect(decoys).toBe(0);
    });
  });
});

describe('scenario-specific content', () => {
  it('baseline: beacon + two undeclared vehicles, intel hostile at 40, 3 deg/s turn for 15 s at 50', () => {
    const s = getScenario('baseline');
    expect(s.contacts).toHaveLength(3);
    expect(s.contacts.filter((c) => c.kind === 'vehicle' && !c.declared)).toHaveLength(2);
    const intel = s.events.find((e) => e.type === 'intel');
    expect(intel).toMatchObject({ t: 40, label: 'hostile' });
    const target = s.contacts.find((c) => c.id === (intel as { contactId: number }).contactId);
    expect(target?.kind).toBe('vehicle');
    expect(s.events.find((e) => e.type === 'platform.turn')).toMatchObject({ t: 50, rateDegS: 3, durationS: 15 });
  });

  it('sensor-degradation: TERRAIN x10 at 30 for 40 s, STAR off 60-100, SWARM bias at 90 for 50 s, each logged', () => {
    const s = getScenario('sensor-degradation');
    expect(s.events.find((e) => e.type === 'sensor.noise')).toMatchObject({ t: 30, sensor: 'TERRAIN', scale: 10, durationS: 40 });
    const enables = s.events.filter((e) => e.type === 'sensor.enable');
    expect(enables).toEqual([
      { t: 60, type: 'sensor.enable', sensor: 'STAR', enabled: false },
      { t: 100, type: 'sensor.enable', sensor: 'STAR', enabled: true },
    ]);
    expect(s.events.find((e) => e.type === 'sensor.bias')).toMatchObject({ t: 90, sensor: 'SWARM', bias: [400, -150], durationS: 50 });
    const logTimes = new Set(s.events.filter((e) => e.type === 'log').map((e) => e.t));
    for (const t of [30, 60, 90, 100]) expect(logTimes.has(t), `log at t=${t}`).toBe(true);
  });

  it('decoy-swarm: three vehicles, six decoys around contact 2 at 40 despawning near 75, clutter 10 at 70 for 40 s', () => {
    const s = getScenario('decoy-swarm');
    expect(s.contacts.filter((c) => c.kind === 'vehicle')).toHaveLength(3);
    const spawn = s.events.find((e): e is SpawnEvent => e.type === 'contacts.spawn');
    expect(spawn?.t).toBe(40);
    expect(spawn?.contacts).toHaveLength(6);
    const ref = s.contacts.find((c) => c.id === 2)!;
    const refPos: Vec2 = [ref.pos[0] + ref.vel[0] * 40, ref.pos[1] + ref.vel[1] * 40];
    for (const d of spawn!.contacts) {
      // decoys are released in a 300-800 m ring around the parent, like World.spawnDecoys
      const off = Math.hypot(d.pos[0] - refPos[0], d.pos[1] - refPos[1]);
      expect(off).toBeGreaterThanOrEqual(300);
      expect(off).toBeLessThanOrEqual(800);
      // and inherit its velocity within a few sigma of the contract's N(0, 15) per axis
      expect(Math.abs(d.vel[0] - ref.vel[0])).toBeLessThanOrEqual(45);
      expect(Math.abs(d.vel[1] - ref.vel[1])).toBeLessThanOrEqual(45);
      expect(d.spawnAt).toBe(40);
      expect(Math.abs(d.despawnAt! - 75)).toBeLessThanOrEqual(3);
    }
    expect(s.events.find((e) => e.type === 'radar.clutter')).toMatchObject({ t: 70, rate: 10, durationS: 40 });
  });

  it('full-mission: combines sensor faults, decoys, clutter, a turn and an acceleration over five phases', () => {
    const s = getScenario('full-mission');
    expect(s.phases).toHaveLength(5);
    const types = new Set(s.events.map((e) => e.type));
    for (const t of ['intel', 'sensor.noise', 'sensor.enable', 'sensor.bias', 'contacts.spawn', 'radar.clutter', 'platform.turn', 'platform.accel', 'log']) {
      expect(types.has(t as ScenarioEvent['type']), t).toBe(true);
    }
    const turn = s.events.find((e) => e.type === 'platform.turn') as Extract<ScenarioEvent, { type: 'platform.turn' }>;
    const accel = s.events.find((e) => e.type === 'platform.accel') as Extract<ScenarioEvent, { type: 'platform.accel' }>;
    expect(turn.t + turn.durationS).toBeLessThanOrEqual(300);
    expect(accel.t + accel.durationS).toBeLessThanOrEqual(300);
    // the manoeuvre must not decelerate the platform to a stop or spin it more than a full turn
    expect(accel.mps2 * accel.durationS).toBeGreaterThan(-250);
    expect(Math.abs(turn.rateDegS * turn.durationS)).toBeLessThan(360);
    const spawn = s.events.find((e): e is SpawnEvent => e.type === 'contacts.spawn')!;
    expect(spawn.contacts).toHaveLength(6);
  });
});

describe('getScenario', () => {
  it('returns a scenario equal to the BUILTIN_SCENARIOS entry but as a fresh copy', () => {
    for (const s of BUILTIN_SCENARIOS) {
      const got = getScenario(s.id);
      expect(got).toEqual(s);
      expect(got).not.toBe(s);
      expect(getScenario(s.id)).not.toBe(got);
    }
  });

  it('mutating a returned scenario does not affect later lookups', () => {
    const a = getScenario('baseline');
    a.platform.pos[0] = 12345;
    a.contacts[0]!.pos[0] = -1;
    a.events.length = 0;
    const b = getScenario('baseline');
    expect(b.platform.pos[0]).toBe(0);
    expect(b.contacts[0]!.pos[0]).toBe(-5000);
    expect(b.events.length).toBeGreaterThan(0);
    expect(BUILTIN_SCENARIOS[0]!.platform.pos[0]).toBe(0);
  });

  it('throws for unknown ids and lists the known ones', () => {
    expect(() => getScenario('nope')).toThrow(/Unknown scenario id 'nope'/);
    expect(() => getScenario('nope')).toThrow(/baseline, sensor-degradation, decoy-swarm, full-mission/);
    expect(() => getScenario('')).toThrow();
  });
});
