/**
 * Reviewer probes for World: each test pins a behaviour that the orchestrator
 * (core/simulation.ts) or a sibling module relies on and that a stub could get
 * wrong without the main suite noticing.
 */
import { describe, expect, it } from 'vitest';
import { DEG, DT, secondsToTick, wrapAngle } from '../core/constants';
import { Rng } from '../core/rng';
import type { ContactSpec, Scenario } from '../core/types';
import { World } from './world';

const SEED = 7;
const rng = (): Rng => Rng.fromLabel(SEED, 'world');

function scenario(over: Partial<Scenario> = {}, platform: Partial<Scenario['platform']> = {}): Scenario {
  return {
    id: 'review',
    name: 'Review',
    description: 'reviewer probes',
    durationS: 300,
    seed: SEED,
    platform: { pos: [0, 0], vel: [0, 250], alt: 9000, ...platform },
    phases: [{ t: 0, name: 'start' }],
    contacts: [],
    events: [],
    ...over,
  };
}

function contact(over: Partial<ContactSpec> & { id: number }): ContactSpec {
  return {
    kind: 'vehicle',
    label: 'unknown',
    declared: false,
    pos: [0, 0],
    vel: [0, 0],
    elevationDeg: 0,
    jitter: 0,
    ...over,
  };
}

describe('World platform (review probes)', () => {
  it('matches the contract kinematics step for step under simultaneous turn and acceleration', () => {
    // Reference: the four contract lines evaluated in the contract's order,
    // with the same untilTick semantics (0 once tick >= untilTick).
    const w = new World(scenario({}, { pos: [1000, -500], vel: [150, 200], alt: 9000 }), rng());
    const rate = -2.5 * DEG;
    const accel = 1.5;
    const turnUntil = 900;
    const accelUntil = 1300;
    w.setTurn(rate, turnUntil);
    w.setAccel(accel, accelUntil);

    let heading = Math.atan2(150, 200);
    let speed = Math.hypot(150, 200);
    let pE = 1000;
    let pN = -500;
    for (let tick = 1; tick <= 2000; tick++) {
      const r = tick < turnUntil ? rate : 0;
      const a = tick < accelUntil ? accel : 0;
      heading += r * DT;
      speed = Math.max(0, speed + a * DT);
      const vE = speed * Math.sin(heading);
      const vN = speed * Math.cos(heading);
      pE += vE * DT;
      pN += vN * DT;
      w.step(tick);
      // Same operations in the same order: only last-ulp differences are
      // possible (the heading wrap is exact for |h| <= π), so 1e-9 m / 1e-12 rad
      // is far looser than needed yet catches any reordering or extra term.
      expect(Math.abs(w.platform.pos[0] - pE)).toBeLessThan(1e-9);
      expect(Math.abs(w.platform.pos[1] - pN)).toBeLessThan(1e-9);
      expect(Math.abs(w.platform.vel[0] - vE)).toBeLessThan(1e-9);
      expect(Math.abs(w.platform.vel[1] - vN)).toBeLessThan(1e-9);
      expect(Math.abs(wrapAngle(w.platform.heading - heading))).toBeLessThan(1e-12);
      expect(Math.abs(w.platform.speed - speed)).toBeLessThan(1e-9);
      expect(w.platform.turnRate).toBe(r);
      expect(w.platform.accel).toBe(a);
      expect(w.platform.alt).toBe(9000);
    }
  });

  it('turns for exactly durationS when driven the way the orchestrator drives it', () => {
    // baseline.json: platform.turn at t=50 for 15 s at 3°/s → +45° of heading.
    const w = new World(scenario(), rng());
    const start = secondsToTick(50);
    const until = secondsToTick(50 + 15);
    let h0 = NaN;
    for (let tick = 1; tick <= until + 100; tick++) {
      if (tick === start) {
        h0 = w.platform.heading;
        w.setTurn(3 * DEG, until); // applied before world.step(start), as simulation.ts does
      }
      w.step(tick);
    }
    // 1500 additions of 0.03° each round at ~1e-16 rad: 1e-9 is generous.
    expect(Math.abs(wrapAngle(w.platform.heading - h0) - 45 * DEG)).toBeLessThan(1e-9);
    expect(w.platform.turnRate).toBe(0);
  });
});

describe('World contacts (review probes)', () => {
  it('uses tick rounding for fractional spawn/despawn seconds (no float-noise off-by-one)', () => {
    // 0.29 s and 0.57 s are not exactly representable; 29 * DT !== 0.29 in IEEE754.
    const w = new World(scenario({ contacts: [contact({ id: 1, pos: [1000, 0], spawnAt: 0.29, despawnAt: 0.57 })] }), rng());
    const alive: number[] = [];
    for (let tick = 1; tick <= 80; tick++) {
      w.step(tick);
      if (w.contacts[0]?.alive) alive.push(tick);
    }
    expect(alive[0]).toBe(29);
    expect(alive[alive.length - 1]).toBe(56);
    expect(alive).toHaveLength(56 - 29 + 1);
    const events = w.drainEvents();
    expect(events.map((e) => e.tick)).toEqual([29, 57]);
  });

  it('spawn then despawn within one orchestrator tick emits one event each and does not resurrect', () => {
    // simulation.ts applies scenario events (spawn/despawn) and then world.step(T) for the same T.
    const w = new World(scenario(), rng());
    for (let tick = 1; tick <= 99; tick++) w.step(tick);
    const tick = 100;
    w.spawn(contact({ id: 5, pos: [3000, 4000], vel: [10, 0] }), tick);
    w.despawn(5, tick);
    w.step(tick);
    const c = w.contacts[0];
    expect(c?.alive).toBe(false);
    expect(c?.pos).toEqual([3000, 4000]); // never moved
    const events = w.drainEvents();
    expect(events.map((e) => e.tick)).toEqual([tick, tick]);
    expect(events[0]?.message).toMatch(/contact 5 .*spawned/);
    expect(events[1]?.message).toMatch(/contact 5 .*despawned/);
    for (let t = tick + 1; t <= tick + 200; t++) w.step(t);
    expect(c?.alive).toBe(false);
    expect(w.drainEvents()).toEqual([]);
  });

  it('jittered contacts still drift with their velocity (mean step = vel·DT)', () => {
    const N = 500;
    const STEPS = 40;
    const vel: [number, number] = [100, -50];
    const contacts: ContactSpec[] = [];
    for (let i = 0; i < N; i++) contacts.push(contact({ id: i + 1, pos: [i * 1000, 0], vel, jitter: 60 }));
    const w = new World(scenario({ contacts }), rng());
    let sumE = 0;
    let sumN = 0;
    for (let t = 1; t <= STEPS; t++) {
      const prev = w.contacts.map((c) => [c.pos[0], c.pos[1]]);
      w.step(t);
      w.contacts.forEach((c, i) => {
        sumE += c.pos[0] - (prev[i]?.[0] as number);
        sumN += c.pos[1] - (prev[i]?.[1] as number);
      });
    }
    const n = N * STEPS;
    // Per-step noise σ = 60·sqrt(0.01) = 6 m; the mean over 20 000 steps has
    // σ/√n ≈ 0.042 m, so a ±0.25 m (≈6σ) window around vel·DT = [1, -0.5] m is safe.
    expect(Math.abs(sumE / n - vel[0] * DT)).toBeLessThan(0.25);
    expect(Math.abs(sumN / n - vel[1] * DT)).toBeLessThan(0.25);
  });
});

describe('World.spawnDecoys (review probes)', () => {
  it('uses a named alive decoy as the reference (the kind filter applies only to the fallback)', () => {
    const w = new World(
      scenario({
        contacts: [
          contact({ id: 1, pos: [10000, 10000], vel: [0, 100] }),
          contact({ id: 2, kind: 'decoy', label: 'decoy', pos: [-30000, -30000], vel: [0, 0], jitter: 60, elevationDeg: 9 }),
        ],
      }),
      rng(),
    );
    for (let t = 1; t <= 10; t++) w.step(t);
    const ref = [...(w.contacts[1]?.pos as [number, number])];
    const ids = w.spawnDecoys(3, 10, 2);
    for (const id of ids) {
      const d = w.contacts.find((c) => c.spec.id === id);
      const r = Math.hypot((d?.pos[0] as number) - (ref[0] as number), (d?.pos[1] as number) - (ref[1] as number));
      expect(r).toBeGreaterThanOrEqual(300);
      expect(r).toBeLessThan(800);
      expect(d?.spec.elevationDeg).toBe(9);
    }
    expect(w.drainEvents()[0]?.message).toMatch(/near contact 2/);
  });

  it('decoy spawn and despawn ticks agree with spec.spawnAt/despawnAt through secondsToTick', () => {
    const w = new World(scenario({ contacts: [contact({ id: 1, pos: [5000, 5000], vel: [50, 50] })] }), rng());
    for (let t = 1; t <= 1234; t++) w.step(t);
    const ids = w.spawnDecoys(4, 1234, 1);
    w.drainEvents();
    const expectedDespawn = new Map<number, number>();
    for (const id of ids) {
      const d = w.contacts.find((c) => c.spec.id === id);
      expect(secondsToTick(d?.spec.spawnAt as number)).toBe(1234);
      expectedDespawn.set(id, secondsToTick(d?.spec.despawnAt as number));
    }
    for (let t = 1235; t <= 1234 + 4100; t++) {
      w.step(t);
      for (const e of w.drainEvents()) {
        const m = /contact (\d+) \(decoy\) despawned/.exec(e.message);
        expect(m).not.toBeNull();
        const id = Number(m?.[1]);
        expect(e.tick).toBe(expectedDespawn.get(id));
        expectedDespawn.delete(id);
      }
    }
    expect(expectedDespawn.size).toBe(0);
  });
});
