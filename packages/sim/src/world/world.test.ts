import { describe, expect, it } from 'vitest';
import { DEG, DT, wrapAngle } from '../core/constants';
import type { WorldContact } from '../core/interfaces';
import { Rng } from '../core/rng';
import type { ContactSpec, Scenario, SimEvent } from '../core/types';
import {
  DECOY_ID_BASE,
  DECOY_JITTER,
  DECOY_LIFETIME_MAX_S,
  DECOY_LIFETIME_MIN_S,
  DECOY_PD,
  DECOY_RING_MAX_M,
  DECOY_RING_MIN_M,
  DECOY_VEL_SIGMA,
  World,
} from './world';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED = 42;
const rng = (seed = SEED): Rng => Rng.fromLabel(seed, 'world');

function scenario(over: Partial<Scenario> = {}, platform: Partial<Scenario['platform']> = {}): Scenario {
  return {
    id: 'test',
    name: 'Test',
    description: 'unit test scenario',
    durationS: 120,
    seed: SEED,
    platform: { pos: [0, 0], vel: [0, 200], alt: 3000, ...platform },
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

function byId(world: World, id: number): WorldContact {
  const c = world.contacts.find((x) => x.spec.id === id);
  if (!c) throw new Error(`no contact ${id}`);
  return c;
}

/** Step ticks `from..to` inclusive. */
function run(world: World, from: number, to: number): void {
  for (let t = from; t <= to; t++) world.step(t);
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number));
}

function std(xs: number[]): number {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1));
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

describe('World platform', () => {
  it('derives the initial truth from scenario.platform', () => {
    const sc = scenario({}, { pos: [1500, -200], vel: [100, 100], alt: 4200 });
    const w = new World(sc, rng());
    const p = w.platform;
    expect(p.pos).toEqual([1500, -200]);
    expect(p.vel).toEqual([100, 100]);
    // atan2 and sqrt of exact inputs: only last-ulp rounding, so 1e-12 is generous.
    expect(p.heading).toBeCloseTo(Math.PI / 4, 12);
    expect(p.speed).toBeCloseTo(Math.sqrt(20000), 12);
    expect(p.alt).toBe(4200);
    expect(p.turnRate).toBe(0);
    expect(p.accel).toBe(0);
    // The world owns its copies: mutating the scenario afterwards has no effect.
    sc.platform.pos[0] = 999;
    sc.platform.vel[1] = 999;
    expect(w.platform.pos[0]).toBe(1500);
    expect(w.platform.vel[1]).toBe(100);
  });

  it('integrates straight flight exactly', () => {
    const vel: [number, number] = [120, -50];
    const w = new World(scenario({}, { pos: [1000, 2000], vel }), rng());
    const heading0 = w.platform.heading;
    const speed0 = w.platform.speed;
    run(w, 1, 1000);
    const t = 1000 * DT;
    // Per-tick rounding on a ~1e4 m position is ~2e-12; over 1000 ticks the sum
    // error stays far below 1e-6 m (the tolerance the contract asks for).
    expect(Math.abs(w.platform.pos[0] - (1000 + vel[0] * t))).toBeLessThan(1e-6);
    expect(Math.abs(w.platform.pos[1] - (2000 + vel[1] * t))).toBeLessThan(1e-6);
    expect(w.platform.heading).toBe(heading0);
    expect(w.platform.speed).toBe(speed0);
    expect(w.platform.vel[0]).toBeCloseTo(vel[0], 9);
    expect(w.platform.vel[1]).toBeCloseTo(vel[1], 9);
  });

  it('turns at 3°/s for 10 s, then resets turnRate at untilTick', () => {
    const w = new World(scenario({}, { pos: [0, 0], vel: [0, 200] }), rng());
    const rate = 3 * DEG;
    const start = 500;
    const until = start + 1000; // 10 s of turning: steps start..until-1
    let headingBefore = NaN;
    let headingAtEnd = NaN;
    let posBefore: [number, number] = [0, 0];
    let posAtEnd: [number, number] = [0, 0];
    for (let t = 1; t <= 2000; t++) {
      if (t === start) {
        headingBefore = w.platform.heading;
        posBefore = [w.platform.pos[0], w.platform.pos[1]];
        w.setTurn(rate, until);
        expect(w.platform.turnRate).toBe(rate);
      }
      w.step(t);
      if (t >= start && t < until) expect(w.platform.turnRate).toBe(rate);
      if (t >= until) expect(w.platform.turnRate).toBe(0);
      if (t === until - 1) {
        headingAtEnd = w.platform.heading;
        posAtEnd = [w.platform.pos[0], w.platform.pos[1]];
      }
    }
    // 1000 ticks × 0.03° = 30°; ±0.01° allows for accumulated fp rounding.
    expect(Math.abs(wrapAngle(headingAtEnd - headingBefore) - 30 * DEG)).toBeLessThan(0.01 * DEG);
    // No further heading change after expiry, and speed is untouched by a turn.
    expect(w.platform.heading).toBe(headingAtEnd);
    expect(w.platform.speed).toBeCloseTo(200, 9);
    // The path is a circular arc of radius v/ω. The per-tick Euler scheme is a
    // right-endpoint Riemann sum whose error is ≈ (DT/2)·|v(T) − v(0)| ≈
    // 0.005 × 200 × 2·sin(15°) ≈ 0.52 m, so 1 m is a tight but safe bound.
    const v = 200;
    const T = 1000 * DT;
    const h0 = headingBefore;
    const h1 = h0 + rate * T;
    const expE = posBefore[0] + (v / rate) * (Math.cos(h0) - Math.cos(h1));
    const expN = posBefore[1] + (v / rate) * (Math.sin(h1) - Math.sin(h0));
    expect(Math.abs(posAtEnd[0] - expE)).toBeLessThan(1);
    expect(Math.abs(posAtEnd[1] - expN)).toBeLessThan(1);
  });

  it('wraps heading into (-π, π] during a long turn', () => {
    const w = new World(scenario({}, { vel: [0, 200] }), rng());
    w.setTurn(10 * DEG, Infinity); // 10°/s: a full circle in 36 s
    run(w, 1, 6000);
    expect(w.platform.heading).toBeGreaterThan(-Math.PI);
    expect(w.platform.heading).toBeLessThanOrEqual(Math.PI);
    // 60 s × 10°/s = 600° ≡ 240° ≡ -120°; rounding over 6000 ticks is ≪ 1e-6 rad.
    expect(wrapAngle(w.platform.heading + 120 * DEG)).toBeCloseTo(0, 6);
  });

  it('accelerates until untilTick, then holds speed', () => {
    const w = new World(scenario({}, { vel: [0, 100] }), rng());
    w.setAccel(2, 1 + 500); // 5 s at 2 m/s² starting on step 1
    expect(w.platform.accel).toBe(2);
    run(w, 1, 500);
    expect(w.platform.accel).toBe(2);
    // 500 × 0.02 m/s: each add rounds at ~1e-14, so 1e-9 is ample.
    expect(w.platform.speed).toBeCloseTo(110, 9);
    w.step(501);
    expect(w.platform.accel).toBe(0);
    expect(w.platform.speed).toBeCloseTo(110, 9);
    run(w, 502, 1000);
    expect(w.platform.speed).toBeCloseTo(110, 9);
    // Velocity follows speed along the unchanged (north) heading.
    expect(w.platform.vel[0]).toBeCloseTo(0, 9);
    expect(w.platform.vel[1]).toBeCloseTo(110, 9);
  });

  it('clamps speed at zero under strong deceleration', () => {
    const w = new World(scenario({}, { vel: [0, 50] }), rng());
    w.setAccel(-20, Infinity);
    run(w, 1, 500); // 5 s: would reach -50 m/s without the clamp
    expect(w.platform.speed).toBe(0);
    expect(w.platform.vel[0]).toBeCloseTo(0, 12);
    expect(w.platform.vel[1]).toBeCloseTo(0, 12);
    const stopped = w.platform.pos[1];
    run(w, 501, 600);
    expect(w.platform.pos[1]).toBe(stopped);
  });

  it('yields a fresh platform object per step so retained references are stable', () => {
    const w = new World(scenario(), rng());
    const before = w.platform;
    w.step(1);
    expect(w.platform).not.toBe(before);
    expect(before.pos).toEqual([0, 0]);
    w.setTurn(0.1, 100);
    expect(before.turnRate).toBe(0);
    expect(w.platform.turnRate).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

describe('World contacts', () => {
  it('are alive only inside [spawnAt, despawnAt) and move only while alive', () => {
    const sc = scenario({
      contacts: [contact({ id: 7, pos: [5000, 0], vel: [100, 0], spawnAt: 1.0, despawnAt: 2.0 })],
    });
    const w = new World(sc, rng());
    expect(byId(w, 7).alive).toBe(false);
    run(w, 1, 99);
    expect(byId(w, 7).alive).toBe(false);
    expect(byId(w, 7).pos).toEqual([5000, 0]);
    expect(w.drainEvents()).toEqual([]);

    w.step(100); // time 1.0: spawns and takes its first step
    expect(byId(w, 7).alive).toBe(true);
    expect(byId(w, 7).pos[0]).toBeCloseTo(5001, 9);
    const spawnEvents = w.drainEvents();
    expect(spawnEvents).toHaveLength(1);
    expect(spawnEvents[0]).toMatchObject({ tick: 100, source: 'scenario', level: 'info' });
    expect(spawnEvents[0]?.time).toBeCloseTo(1.0, 12);
    expect(spawnEvents[0]?.message).toMatch(/contact 7 .*spawned/);

    run(w, 101, 199);
    expect(byId(w, 7).alive).toBe(true);
    // 100 steps of 1 m: accumulated rounding ~1e-12.
    expect(byId(w, 7).pos[0]).toBeCloseTo(5100, 9);
    expect(w.drainEvents()).toEqual([]);

    w.step(200); // time 2.0: despawned, frozen where it was
    expect(byId(w, 7).alive).toBe(false);
    expect(byId(w, 7).pos[0]).toBeCloseTo(5100, 9);
    const despawnEvents = w.drainEvents();
    expect(despawnEvents).toHaveLength(1);
    expect(despawnEvents[0]?.message).toMatch(/contact 7 .*despawned/);
    expect(despawnEvents[0]?.time).toBeCloseTo(2.0, 12);

    run(w, 201, 400);
    expect(byId(w, 7).alive).toBe(false);
    expect(byId(w, 7).pos[0]).toBeCloseTo(5100, 9);
    expect(w.drainEvents()).toEqual([]);
  });

  it('treats a missing spawnAt as 0 and a missing despawnAt as forever', () => {
    const w = new World(scenario({ contacts: [contact({ id: 1, pos: [1, 1] })] }), rng());
    expect(byId(w, 1).alive).toBe(true);
    run(w, 1, 20000);
    expect(byId(w, 1).alive).toBe(true);
    expect(w.drainEvents()).toEqual([]);
  });

  it('spawn() registers contacts at runtime with absolute spawn windows', () => {
    const w = new World(scenario(), rng());
    run(w, 1, 300);
    w.spawn(contact({ id: 11, pos: [100, 100], vel: [10, 0] }), 300); // no spawnAt: alive now
    w.spawn(contact({ id: 12, pos: [200, 200], spawnAt: 5.0 }), 300); // future: waits
    w.spawn(contact({ id: 13, pos: [300, 300], spawnAt: 1.0 }), 300); // past: alive now
    expect(byId(w, 11).alive).toBe(true);
    expect(byId(w, 12).alive).toBe(false);
    expect(byId(w, 13).alive).toBe(true);
    const events = w.drainEvents();
    expect(events.map((e) => e.tick)).toEqual([300, 300]);
    expect(events[0]?.message).toMatch(/contact 11 .*spawned/);
    expect(events[1]?.message).toMatch(/contact 13 .*spawned/);
    expect(w.contacts.map((c) => c.spec.id)).toEqual([11, 12, 13]);

    run(w, 301, 499);
    expect(byId(w, 12).alive).toBe(false);
    expect(w.drainEvents()).toEqual([]);
    w.step(500);
    expect(byId(w, 12).alive).toBe(true);
    expect(w.drainEvents().map((e) => e.message)).toEqual([expect.stringMatching(/contact 12 .*spawned/)]);
    // Runtime spawns get their own copies of the spec arrays.
    const spec = contact({ id: 14, pos: [1, 2] });
    w.spawn(spec, 500);
    spec.pos[0] = 999;
    expect(byId(w, 14).pos[0]).toBe(1);
    expect(byId(w, 14).spec.pos[0]).toBe(1);
  });

  it('despawn() kills an alive contact once and emits one event', () => {
    const w = new World(scenario({ contacts: [contact({ id: 3, pos: [10, 10], vel: [5, 5] })] }), rng());
    run(w, 1, 50);
    w.despawn(3, 50);
    expect(byId(w, 3).alive).toBe(false);
    const events = w.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tick: 50, source: 'scenario', level: 'info' });
    expect(events[0]?.message).toMatch(/contact 3 .*despawned/);
    const pos = [...byId(w, 3).pos];
    run(w, 51, 100);
    expect(byId(w, 3).alive).toBe(false);
    expect(byId(w, 3).pos).toEqual(pos);
    w.despawn(3, 100);
    w.despawn(404, 100);
    expect(w.drainEvents()).toEqual([]);
  });

  it('jitter random walk is deterministic for a seed and has std jitter·sqrt(DT) per step', () => {
    const N = 500;
    const STEPS = 40;
    const jitter = 60;
    const contacts: ContactSpec[] = [];
    for (let i = 0; i < N; i++) contacts.push(contact({ id: i + 1, pos: [i * 1000, 0], vel: [0, 0], jitter }));
    const sc = scenario({ contacts });
    const a = new World(sc, rng());
    const b = new World(sc, rng());
    const c = new World(sc, rng(SEED + 1));
    const dE: number[] = [];
    const dN: number[] = [];
    for (let t = 1; t <= STEPS; t++) {
      const prev = a.contacts.map((x) => [x.pos[0], x.pos[1]]);
      a.step(t);
      b.step(t);
      c.step(t);
      a.contacts.forEach((x, i) => {
        dE.push(x.pos[0] - (prev[i]?.[0] as number));
        dN.push(x.pos[1] - (prev[i]?.[1] as number));
      });
    }
    // Same seed → bit-identical; different seed → different.
    expect(a.contacts.map((x) => x.pos)).toEqual(b.contacts.map((x) => x.pos));
    expect(a.contacts.map((x) => x.pos)).not.toEqual(c.contacts.map((x) => x.pos));
    // 20 000 samples per axis: the sample std has ~0.5% relative error, so
    // ±15% around jitter·sqrt(DT) = 6 m is a comfortable margin.
    const expected = jitter * Math.sqrt(DT);
    expect(std(dE)).toBeGreaterThan(expected * 0.85);
    expect(std(dE)).toBeLessThan(expected * 1.15);
    expect(std(dN)).toBeGreaterThan(expected * 0.85);
    expect(std(dN)).toBeLessThan(expected * 1.15);
    // Zero-mean: |mean| ≲ 4σ/√n ≈ 0.17 m; bound at 0.3 m.
    expect(Math.abs(dE.reduce((s, x) => s + x, 0) / dE.length)).toBeLessThan(0.3);
    expect(Math.abs(dN.reduce((s, x) => s + x, 0) / dN.length)).toBeLessThan(0.3);
  });

  it('contacts without jitter do not consume random draws', () => {
    const jittered = contact({ id: 1, pos: [0, 0], vel: [50, 0], jitter: 30 });
    const withPlain = new World(scenario({ contacts: [jittered, contact({ id: 2, pos: [9, 9], vel: [1, 1] })] }), rng());
    const alone = new World(scenario({ contacts: [jittered] }), rng());
    run(withPlain, 1, 100);
    run(alone, 1, 100);
    expect(byId(withPlain, 1).pos).toEqual(byId(alone, 1).pos);
    expect(byId(withPlain, 2).pos[0]).toBeCloseTo(10, 9);
  });
});

// ---------------------------------------------------------------------------
// Decoys
// ---------------------------------------------------------------------------

describe('World.spawnDecoys', () => {
  const swarmScenario = (): Scenario =>
    scenario(
      {
        contacts: [
          contact({ id: 1, kind: 'decoy', label: 'decoy', pos: [-8000, -8000], jitter: 60 }),
          contact({ id: 2, pos: [20000, 20000], vel: [100, 0], spawnAt: 100 }), // not yet alive
          contact({ id: 3, pos: [10000, 5000], vel: [50, -20], elevationDeg: 2 }),
          contact({ id: 4, kind: 'beacon', label: 'friendly', declared: true, pos: [-3000, 2000], vel: [0, 80], elevationDeg: 5 }),
        ],
      },
      { pos: [0, 0], vel: [0, 200] },
    );

  it('spawns the requested count around the named alive contact', () => {
    const w = new World(swarmScenario(), rng());
    run(w, 1, 500);
    w.drainEvents();
    const before = w.contacts.length;
    const ref = byId(w, 4);
    const refPos = [...ref.pos];
    const refVel = [...ref.vel];
    const ids = w.spawnDecoys(6, 500, 4);
    expect(ids).toEqual([9000, 9001, 9002, 9003, 9004, 9005]);
    expect(ids[0]).toBe(DECOY_ID_BASE);
    expect(w.contacts).toHaveLength(before + 6);
    for (const id of ids) {
      const d = byId(w, id);
      expect(d.alive).toBe(true);
      expect(d.spec.kind).toBe('decoy');
      expect(d.spec.label).toBe('decoy');
      expect(d.spec.declared).toBe(false);
      expect(d.spec.jitter).toBe(DECOY_JITTER);
      expect(d.spec.pd).toBe(DECOY_PD);
      expect(d.spec.elevationDeg).toBe(5);
      const r = dist(d.pos, refPos);
      expect(r).toBeGreaterThanOrEqual(DECOY_RING_MIN_M);
      expect(r).toBeLessThan(DECOY_RING_MAX_M);
      expect(d.spec.spawnAt).toBeCloseTo(5, 12);
      const life = (d.spec.despawnAt as number) - (d.spec.spawnAt as number);
      // uniform(20, 40) is [20, 40); the subtraction adds ~1e-14 of rounding.
      expect(life).toBeGreaterThanOrEqual(DECOY_LIFETIME_MIN_S - 1e-9);
      expect(life).toBeLessThan(DECOY_LIFETIME_MAX_S);
      // Velocity = reference + N(0, 15): 6σ bound per axis.
      expect(Math.abs(d.vel[0] - (refVel[0] as number))).toBeLessThan(6 * DECOY_VEL_SIGMA);
      expect(Math.abs(d.vel[1] - (refVel[1] as number))).toBeLessThan(6 * DECOY_VEL_SIGMA);
    }
    const events = w.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tick: 500, source: 'scenario', level: 'info' });
    expect(events[0]?.message).toMatch(/6 decoys/);
    expect(events[0]?.message).toMatch(/contact 4/);
  });

  it('falls back to the first alive non-decoy contact, then to the platform', () => {
    const w = new World(swarmScenario(), rng());
    run(w, 1, 500);
    const ref3 = [...byId(w, 3).pos];
    const noName = w.spawnDecoys(3, 500);
    expect(noName).toEqual([9000, 9001, 9002]);
    for (const id of noName) {
      const r = dist(byId(w, id).pos, ref3);
      expect(r).toBeGreaterThanOrEqual(DECOY_RING_MIN_M);
      expect(r).toBeLessThan(DECOY_RING_MAX_M);
      expect(byId(w, id).spec.elevationDeg).toBe(2);
    }
    // Named but not alive (id 2 spawns at t=100) and unknown ids fall back too.
    for (const id of [...w.spawnDecoys(2, 500, 2), ...w.spawnDecoys(2, 500, 99)]) {
      const r = dist(byId(w, id).pos, ref3);
      expect(r).toBeGreaterThanOrEqual(DECOY_RING_MIN_M);
      expect(r).toBeLessThan(DECOY_RING_MAX_M);
    }
    expect(w.contacts.filter((c) => c.spec.id >= DECOY_ID_BASE).map((c) => c.spec.id)).toEqual([
      9000, 9001, 9002, 9003, 9004, 9005, 9006,
    ]);
    expect(w.drainEvents()).toHaveLength(3);

    const empty = new World(scenario({}, { pos: [4000, -1000], vel: [30, 40] }), rng());
    run(empty, 1, 10);
    const ids = empty.spawnDecoys(4, 10);
    expect(ids).toHaveLength(4);
    const platformPos = [...empty.platform.pos];
    for (const id of ids) {
      const d = byId(empty, id);
      const r = dist(d.pos, platformPos);
      expect(r).toBeGreaterThanOrEqual(DECOY_RING_MIN_M);
      expect(r).toBeLessThan(DECOY_RING_MAX_M);
      expect(d.spec.elevationDeg).toBe(0);
      expect(Math.abs(d.vel[0] - 30)).toBeLessThan(6 * DECOY_VEL_SIGMA);
      expect(Math.abs(d.vel[1] - 40)).toBeLessThan(6 * DECOY_VEL_SIGMA);
    }
    expect(empty.drainEvents()[0]?.message).toMatch(/near platform/);
  });

  it('returns nothing and emits nothing for a non-positive count', () => {
    const w = new World(swarmScenario(), rng());
    expect(w.spawnDecoys(0, 1)).toEqual([]);
    expect(w.spawnDecoys(-3, 1)).toEqual([]);
    expect(w.drainEvents()).toEqual([]);
  });

  it('draws velocity noise with the documented sigma', () => {
    const w = new World(scenario({ contacts: [contact({ id: 1, pos: [10000, 0], vel: [0, 0] })] }), rng());
    const ids = w.spawnDecoys(300, 1, 1);
    const vs: number[] = [];
    for (const id of ids) vs.push(byId(w, id).vel[0], byId(w, id).vel[1]);
    // 600 samples: sample std has ~3% relative error; ±15% is a safe window.
    expect(std(vs)).toBeGreaterThan(DECOY_VEL_SIGMA * 0.85);
    expect(std(vs)).toBeLessThan(DECOY_VEL_SIGMA * 1.15);
  });

  it('decoys jitter while alive and despawn 20–40 s later with one event each', () => {
    const w = new World(swarmScenario(), rng());
    run(w, 1, 500);
    const ids = w.spawnDecoys(6, 500, 3);
    w.drainEvents();
    const start = ids.map((id) => [...byId(w, id).pos]);
    run(w, 500, 1000); // 5 s: all still alive, all moved
    ids.forEach((id, i) => {
      expect(byId(w, id).alive).toBe(true);
      expect(dist(byId(w, id).pos, start[i] as number[])).toBeGreaterThan(0);
    });
    run(w, 1001, 500 + 20 * 100 - 1); // just short of the earliest possible despawn
    expect(ids.every((id) => byId(w, id).alive)).toBe(true);
    expect(w.drainEvents()).toEqual([]);
    run(w, 500 + 20 * 100, 500 + 40 * 100); // by t+40 s every decoy has despawned
    expect(ids.every((id) => !byId(w, id).alive)).toBe(true);
    const events = w.drainEvents();
    const despawns = events.filter((e) => /despawned/.test(e.message));
    expect(despawns).toHaveLength(6);
    for (const id of ids) expect(despawns.some((e) => e.message.includes(`contact ${id} `))).toBe(true);
    // Despawn ticks land inside the 20–40 s window after the spawn tick.
    for (const e of despawns) {
      expect(e.tick).toBeGreaterThanOrEqual(500 + 2000);
      expect(e.tick).toBeLessThanOrEqual(500 + 4000);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = new World(swarmScenario(), rng());
    const b = new World(swarmScenario(), rng());
    run(a, 1, 100);
    run(b, 1, 100);
    a.spawnDecoys(5, 100, 3);
    b.spawnDecoys(5, 100, 3);
    run(a, 101, 600);
    run(b, 101, 600);
    expect(a.contactSnapshots()).toEqual(b.contactSnapshots());
    expect(a.drainEvents()).toEqual(b.drainEvents());
  });
});

// ---------------------------------------------------------------------------
// Snapshots and events
// ---------------------------------------------------------------------------

describe('World.contactSnapshots', () => {
  it('reports range, bearing, elevation and relative kinematics for every contact', () => {
    const sc = scenario(
      {
        contacts: [
          contact({ id: 1, pos: [2000, 2000], vel: [10, 200], elevationDeg: 5 }), // due east
          contact({ id: 2, kind: 'beacon', label: 'friendly', pos: [1000, 3000] }), // due north
          contact({ id: 3, pos: [1000, 1000] }), // due south
          contact({ id: 4, pos: [0, 2000], spawnAt: 50 }), // due west, not alive yet
        ],
      },
      { pos: [1000, 2000], vel: [0, 200] },
    );
    const w = new World(sc, rng());
    const snaps = w.contactSnapshots();
    expect(snaps.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    const [east, north, south, west] = snaps;
    // Pure arithmetic on exact inputs; atan2 of exact axes is exact.
    expect(east?.range).toBeCloseTo(1000, 9);
    expect(east?.bearing).toBeCloseTo(Math.PI / 2, 12);
    expect(east?.pos).toEqual([1000, 0]);
    expect(east?.vel).toEqual([10, 0]);
    expect(east?.elevation).toBeCloseTo(5 * DEG, 12);
    expect(east?.alive).toBe(true);
    expect(east).toMatchObject({ kind: 'vehicle', label: 'unknown' });
    expect(north?.range).toBeCloseTo(1000, 9);
    expect(north?.bearing).toBeCloseTo(0, 12);
    expect(north).toMatchObject({ kind: 'beacon', label: 'friendly' });
    expect(south?.bearing).toBeCloseTo(Math.PI, 12);
    expect(west?.bearing).toBeCloseTo(-Math.PI / 2, 12);
    expect(west?.alive).toBe(false);
    expect(west?.range).toBeCloseTo(1000, 9);
    // Snapshots are copies: mutating one leaves the world untouched.
    (east as { pos: [number, number] }).pos[0] = 0;
    expect(w.contactSnapshots()[0]?.pos[0]).toBe(1000);
  });

  it('follows the platform as it moves', () => {
    const w = new World(scenario({ contacts: [contact({ id: 1, pos: [0, 10000] })] }, { vel: [0, 100] }), rng());
    run(w, 1, 1000); // platform 1 km north after 10 s
    const s = w.contactSnapshots()[0];
    expect(s?.range).toBeCloseTo(9000, 6);
    expect(s?.bearing).toBeCloseTo(0, 12);
    expect(s?.vel[1]).toBeCloseTo(-100, 9);
  });
});

describe('World.drainEvents', () => {
  it('returns events since the previous drain and clears them', () => {
    const w = new World(scenario({ contacts: [contact({ id: 1, spawnAt: 0.5 }), contact({ id: 2, despawnAt: 0.7 })] }), rng());
    run(w, 1, 100);
    const first: SimEvent[] = w.drainEvents();
    expect(first.map((e) => e.tick)).toEqual([50, 70]);
    expect(first[0]?.message).toMatch(/contact 1 .*spawned/);
    expect(first[1]?.message).toMatch(/contact 2 .*despawned/);
    for (const e of first) {
      expect(e.source).toBe('scenario');
      expect(e.level).toBe('info');
      expect(e.time).toBeCloseTo(e.tick * DT, 12);
    }
    expect(w.drainEvents()).toEqual([]);
    w.spawnDecoys(2, 100);
    const second = w.drainEvents();
    expect(second).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(w.drainEvents()).toEqual([]);
  });
});
