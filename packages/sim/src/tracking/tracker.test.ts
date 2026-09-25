import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import type { ContactSpec, Detection, GateSetting, SimEvent, TrackSnapshot, Vec2 } from '../core/types';
import { GATE_SETTINGS, GATE_TABLE } from './gates';
import { Radar } from './radar';
import { Tracker } from './tracker';
import { DT_SCAN, TICKS_PER_SCAN, TestWorld, contactSpec, detection, runScans } from './test-support';

const SEED = 77;

const isConfirmed = (t: TrackSnapshot): boolean => t.status === 'confirmed' || t.status === 'coasting';
const confirmEvents = (events: SimEvent[]): SimEvent[] => events.filter((e) => /^track \d+ confirmed/.test(e.message));
const dropEvents = (events: SimEvent[]): SimEvent[] => events.filter((e) => /^track \d+ dropped/.test(e.message));
const trackIdOf = (e: SimEvent): number => Number(/^track (\d+)/.exec(e.message)?.[1]);

/** Feed hand-built detections for `scans` scans starting at scan `first`; returns the last tick. */
function feed(tracker: Tracker, first: number, scans: number, make: (scan: number) => Detection[]): number {
  let tick = 0;
  for (let s = first; s < first + scans; s++) {
    tick = s * TICKS_PER_SCAN;
    tracker.update(tick, make(s), DT_SCAN);
  }
  return tick;
}

/** A contact moving in the relative frame, observed without noise. */
function mover(start: Vec2, vel: Vec2, over: Partial<Detection> = {}): (scan: number) => Detection[] {
  return (scan) => [detection([start[0] + vel[0] * scan * DT_SCAN, start[1] + vel[1] * scan * DT_SCAN], over)];
}

/** Three vehicles plus six decoys clustered 300–800 m around vehicle 2 (jitter 60, pd 0.65). */
function decoyScenario(seed: number): { world: TestWorld; radar: Radar } {
  const wrng = Rng.fromLabel(seed, 'world');
  const specs: ContactSpec[] = [
    contactSpec({ id: 1, pos: [-6000, 12_000], vel: [120, 30] }),
    contactSpec({ id: 2, pos: [9000, 18_000], vel: [-60, 140] }),
    contactSpec({ id: 3, pos: [3000, -14_000], vel: [80, -90] }),
  ];
  const ref = specs[1] as ContactSpec;
  for (let i = 0; i < 6; i++) {
    const angle = wrng.uniform(0, 2 * Math.PI);
    const dist = wrng.uniform(300, 800);
    specs.push(
      contactSpec({
        id: 9000 + i,
        kind: 'decoy',
        label: 'decoy',
        pos: [ref.pos[0] + dist * Math.sin(angle), ref.pos[1] + dist * Math.cos(angle)],
        vel: [ref.vel[0] + wrng.gaussian(0, 15), ref.vel[1] + wrng.gaussian(0, 15)],
        jitter: 60,
        pd: 0.65,
      }),
    );
  }
  return { world: new TestWorld(specs, wrng), radar: new Radar(Rng.fromLabel(seed, 'radar')) };
}

const isDecoy = (contactId: number | null): boolean => contactId !== null && contactId >= 9000;
const isVehicle = (contactId: number | null): boolean => contactId !== null && contactId < 9000;

describe('Tracker gate table', () => {
  it('matches the contract values', () => {
    expect(GATE_TABLE.loose).toEqual({ gateChi2: 13.816, m: 2, n: 4, kConfirmed: 8, kTentative: 3 });
    expect(GATE_TABLE.normal).toEqual({ gateChi2: 9.21, m: 3, n: 5, kConfirmed: 5, kTentative: 2 });
    expect(GATE_TABLE.strict).toEqual({ gateChi2: 5.991, m: 4, n: 6, kConfirmed: 3, kTentative: 2 });
    expect(GATE_SETTINGS).toEqual(['loose', 'normal', 'strict']);
  });

  it('exposes the active gate and switches with one event', () => {
    const tracker = new Tracker();
    expect(tracker.gate).toBe('normal');
    expect(tracker.gateChi2).toBe(9.21);
    tracker.setGate('strict', 120);
    expect(tracker.gate).toBe('strict');
    expect(tracker.gateChi2).toBe(5.991);
    tracker.setGate('strict', 130);
    const events = tracker.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tick: 120, time: 1.2, source: 'tracking', level: 'info' });
    expect(events[0]?.message).toMatch(/strict/);
    expect(new Tracker({ gate: 'loose' }).gateChi2).toBe(13.816);
  });
});

describe('Tracker with one steady vehicle', () => {
  it('confirms within 6 scans and converges in position and relative velocity', () => {
    // Contact at 8 km: cross-range noise r·σb = 42 m, range noise 30 m. After 30 scans the
    // KF position σ is ~13 m and velocity σ under 10 m/s, so 200 m / 15 m/s leave wide margin.
    const world = new TestWorld([contactSpec({ id: 1, pos: [4800, 6400], vel: [-40, 150], pd: 0.95 })], Rng.fromLabel(SEED, 'world'));
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'));
    const tracker = new Tracker();
    let confirmedAt = -1;
    runScans(30, world, radar, tracker, (scan) => {
      if (confirmedAt < 0 && tracker.tracks().some((t) => t.contactId === 1 && t.status === 'confirmed')) confirmedAt = scan;
    });
    expect(confirmedAt).toBeGreaterThan(0);
    expect(confirmedAt).toBeLessThanOrEqual(6);
    const track = tracker.tracks().find((t) => t.contactId === 1 && isConfirmed(t)) as TrackSnapshot;
    expect(track).toBeDefined();
    const [pE, pN] = world.relPos(1);
    const [vE, vN] = world.relVel(1);
    expect(Math.hypot(track.pos[0] - pE, track.pos[1] - pN)).toBeLessThan(200);
    expect(Math.hypot(track.vel[0] - vE, track.vel[1] - vN)).toBeLessThan(15);
    expect(track.range).toBeCloseTo(Math.hypot(pE, pN), -2);
    expect(track.bearing).toBeCloseTo(Math.atan2(pE, pN), 1);
    expect(track.ageScans).toBe(30);
    expect(track.hits + track.misses).toBe(30);
    expect(track.quality).toBeGreaterThan(0.8);
    expect(track.label).toBe('unknown');
    expect(track.labelConfidence).toBe(0);
  });
});

describe('Tracker with clutter only', () => {
  it('confirms nothing from clutter at rate 2 under the normal gate', () => {
    const world = new TestWorld([], Rng.fromLabel(SEED, 'world'));
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 2 });
    const tracker = new Tracker({ gate: 'normal' });
    let confirmed = 0;
    let tentativeSeen = 0;
    runScans(200, world, radar, tracker, () => {
      for (const t of tracker.tracks()) {
        if (isConfirmed(t)) confirmed++;
        if (t.status === 'tentative') tentativeSeen++;
        expect(t.contactId).toBeNull();
      }
      confirmed += confirmEvents(tracker.drainEvents()).length;
    });
    expect(confirmed).toBe(0);
    expect(tentativeSeen).toBeGreaterThan(100);
    // Tentative clutter tracks die silently after K_tentative misses: no drop warnings either.
    expect(dropEvents(tracker.drainEvents())).toHaveLength(0);
  });
});

describe('Tracker with decoys', () => {
  const runs = new Map<GateSetting, { decoyDrops: number; vehicleQuality: number; decoyQuality: number; final: TrackSnapshot[] }>();
  for (const gate of GATE_SETTINGS) {
    const { world, radar } = decoyScenario(SEED);
    const tracker = new Tracker({ gate });
    const contactOfTrack = new Map<number, number | null>();
    let decoyDrops = 0;
    const quality = { vehicle: [] as number[], decoy: [] as number[] };
    runScans(400, world, radar, tracker, (scan) => {
      for (const t of tracker.tracks()) {
        contactOfTrack.set(t.id, t.contactId);
        if (scan > 100 && t.status !== 'dropped') {
          if (isVehicle(t.contactId)) quality.vehicle.push(t.quality);
          else if (isDecoy(t.contactId)) quality.decoy.push(t.quality);
        }
      }
      for (const e of dropEvents(tracker.drainEvents())) if (isDecoy(contactOfTrack.get(trackIdOf(e)) ?? null)) decoyDrops++;
    });
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    runs.set(gate, { decoyDrops, vehicleQuality: mean(quality.vehicle), decoyQuality: mean(quality.decoy), final: tracker.tracks() });
  }

  it.each(GATE_SETTINGS)('keeps every vehicle confirmed at the end under %s', (gate) => {
    const run = runs.get(gate);
    expect(run).toBeDefined();
    for (const id of [1, 2, 3]) {
      expect(run?.final.some((t) => t.contactId === id && isConfirmed(t))).toBe(true);
    }
  });

  it.each(GATE_SETTINGS)('rates decoy tracks below vehicle tracks under %s', (gate) => {
    const run = runs.get(gate);
    expect(run?.decoyQuality).toBeLessThan(run?.vehicleQuality as number);
  });

  it('drops decoys more often under strict than under loose', () => {
    const strict = runs.get('strict')?.decoyDrops as number;
    const loose = runs.get('loose')?.decoyDrops as number;
    expect(strict).toBeGreaterThan(loose);
    expect(strict).toBeGreaterThan(20);
  });
});

describe('Tracker track lifecycle', () => {
  it('coasts then drops a confirmed track after K_confirmed misses and lists it dropped for exactly 10 scans', () => {
    const tracker = new Tracker({ gate: 'normal' });
    const make = mover([5000, 5000], [20, -10], { contactId: 3 });
    feed(tracker, 1, 20, make);
    let [track] = tracker.tracks();
    expect(track?.status).toBe('confirmed');
    expect(track?.hits).toBe(20);
    expect(track?.consecutiveMisses).toBe(0);
    const id = track?.id as number;

    // Misses 1..4 coast, miss 5 (K_confirmed = 5) drops.
    const k = GATE_TABLE.normal.kConfirmed;
    for (let miss = 1; miss < k; miss++) {
      tracker.update((20 + miss) * TICKS_PER_SCAN, [], DT_SCAN);
      [track] = tracker.tracks();
      expect(track?.status).toBe('coasting');
      expect(track?.consecutiveMisses).toBe(miss);
      expect(track?.misses).toBe(miss);
    }
    expect(dropEvents(tracker.drainEvents())).toHaveLength(0);
    const dropTick = (20 + k) * TICKS_PER_SCAN;
    tracker.update(dropTick, [], DT_SCAN);
    [track] = tracker.tracks();
    expect(track?.status).toBe('dropped');
    expect(track?.consecutiveMisses).toBe(k);
    const drops = dropEvents(tracker.drainEvents());
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ tick: dropTick, level: 'warn', source: 'tracking' });
    expect(trackIdOf(drops[0] as SimEvent)).toBe(id);

    // Listed as dropped after the drop scan and the next 9 scans, gone on the 10th after.
    for (let extra = 1; extra < 10; extra++) {
      tracker.update((20 + k + extra) * TICKS_PER_SCAN, [], DT_SCAN);
      expect(tracker.tracks().map((t) => [t.id, t.status])).toEqual([[id, 'dropped']]);
    }
    tracker.update((20 + k + 10) * TICKS_PER_SCAN, [], DT_SCAN);
    expect(tracker.tracks()).toEqual([]);
    expect(tracker.drainEvents()).toEqual([]);
  });

  it('drops a track for a contact that despawns from radar within K_confirmed scans', () => {
    const world = new TestWorld([contactSpec({ id: 5, pos: [-7000, 9000], vel: [60, 20], despawnAt: 5 })], Rng.fromLabel(SEED, 'world'));
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const tracker = new Tracker({ gate: 'normal' });
    const history: string[] = [];
    runScans(80, world, radar, tracker, () => {
      const t = tracker.tracks().find((x) => x.contactId === 5);
      history.push(t ? t.status : 'gone');
    });
    // Alive for scans 1..49 (time < 5 s at scan 49, 5.0 s at scan 50): confirmed by scan 6.
    expect(history.slice(5, 49).every((s) => s === 'confirmed' || s === 'coasting')).toBe(true);
    const firstDropped = history.indexOf('dropped');
    expect(firstDropped).toBeGreaterThanOrEqual(49);
    expect(firstDropped).toBeLessThanOrEqual(49 + GATE_TABLE.normal.kConfirmed);
    expect(history.slice(firstDropped, firstDropped + 10).every((s) => s === 'dropped')).toBe(true);
    expect(history[firstDropped + 10]).toBe('gone');
  });

  it('kills a tentative track silently after K_tentative misses', () => {
    const tracker = new Tracker({ gate: 'normal' });
    tracker.update(10, [detection([1000, 2000])], DT_SCAN);
    tracker.update(20, [], DT_SCAN);
    expect(tracker.tracks()[0]?.status).toBe('tentative');
    tracker.update(30, [], DT_SCAN);
    expect(tracker.tracks()[0]?.status).toBe('dropped');
    expect(tracker.drainEvents()).toEqual([]);
  });

  it('confirms by M-of-N over the hit window, counting the initiating detection', () => {
    // strict is 4 of 6: hit, miss, hit, hit, hit → 4 hits in 5 scans confirms on scan 5.
    const tracker = new Tracker({ gate: 'strict' });
    const make = mover([3000, 4000], [10, 10]);
    const pattern = [1, 0, 1, 1, 1];
    const statuses: string[] = [];
    pattern.forEach((hit, i) => {
      tracker.update((i + 1) * TICKS_PER_SCAN, hit ? make(i + 1) : [], DT_SCAN);
      statuses.push(tracker.tracks()[0]?.status as string);
    });
    expect(statuses).toEqual(['tentative', 'tentative', 'tentative', 'tentative', 'confirmed']);
    const confirmations = confirmEvents(tracker.drainEvents());
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.message).toMatch(/5\.0 km brg 037°/);
    expect(confirmations[0]?.tick).toBe(50);
  });

  it('associates each detection with its nearest track and starts new tracks outside every gate', () => {
    const tracker = new Tracker({ gate: 'normal' });
    const a = mover([10_000, 0], [0, 0]);
    const b = mover([10_000, 300], [0, 0]);
    for (let s = 1; s <= 5; s++) tracker.update(s * TICKS_PER_SCAN, [...a(s), ...b(s)], DT_SCAN);
    let tracks = tracker.tracks();
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.status)).toEqual(['confirmed', 'confirmed']);
    expect(tracks[0]?.pos[1]).toBeCloseTo(0, 6);
    expect(tracks[1]?.pos[1]).toBeCloseTo(300, 6);
    // A detection 5 km away is outside both gates and spawns a third, tentative track.
    tracker.update(60, [...a(6), ...b(6), detection([15_000, 0])], DT_SCAN);
    tracks = tracker.tracks();
    expect(tracks).toHaveLength(3);
    expect(tracks[2]).toMatchObject({ id: 3, status: 'tentative', hits: 1, ageScans: 1 });
  });
});

describe('Tracker labels', () => {
  it('labels a declared friendly with confidence 1 after 3 hits', () => {
    const tracker = new Tracker();
    const make = mover([2000, 9000], [0, -50], { contactId: 7, declaredLabel: 'friendly' });
    feed(tracker, 1, 3, make);
    const [t] = tracker.tracks();
    expect(t?.hits).toBe(3);
    expect(t?.label).toBe('friendly');
    expect(t?.labelConfidence).toBe(1);
    expect(t?.contactId).toBe(7);
    expect(t?.status).toBe('confirmed');
  });

  it('takes the majority vote with confidence = majority / hits', () => {
    const tracker = new Tracker();
    const make = mover([2000, 9000], [0, 0]);
    tracker.update(10, [detection(make(1)[0]?.pos as Vec2, { declaredLabel: 'friendly', contactId: 1 })], DT_SCAN);
    tracker.update(20, [detection(make(2)[0]?.pos as Vec2, { declaredLabel: 'friendly', contactId: 1 })], DT_SCAN);
    tracker.update(30, [detection(make(3)[0]?.pos as Vec2, { declaredLabel: 'hostile', contactId: 1 })], DT_SCAN);
    tracker.update(40, [detection(make(4)[0]?.pos as Vec2, { contactId: 1 })], DT_SCAN);
    const [t] = tracker.tracks();
    expect(t?.label).toBe('friendly');
    expect(t?.labelConfidence).toBeCloseTo(2 / 4, 12);
  });

  it('applies intel to associated tracks now and to future associations', () => {
    const tracker = new Tracker();
    const make = mover([2000, 9000], [0, -50], { contactId: 7 });
    feed(tracker, 1, 3, make);
    expect(tracker.tracks()[0]?.label).toBe('unknown');
    tracker.drainEvents();
    tracker.applyIntel(7, 'hostile', 40);
    let [t] = tracker.tracks();
    expect(t?.label).toBe('hostile');
    expect(t?.labelConfidence).toBe(1);
    const events = tracker.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tick: 40, level: 'info', source: 'tracking' });
    expect(events[0]?.message).toMatch(/intel on contact 7/);
    // Intel declared before a contact is ever seen labels its track on first association.
    tracker.applyIntel(8, 'decoy', 40);
    tracker.update(40, [...make(4), detection([-8000, -8000], { contactId: 8 })], DT_SCAN);
    [t] = tracker.tracks();
    const decoyTrack = tracker.tracks()[1];
    expect(t?.label).toBe('hostile');
    expect(decoyTrack?.label).toBe('decoy');
    expect(decoyTrack?.labelConfidence).toBe(1);
    // Intel applies once per mapping: an operator override afterwards sticks.
    expect(tracker.setLabel(t?.id as number, 'friendly', 50)).toBe(true);
    tracker.update(50, make(5), DT_SCAN);
    expect(tracker.tracks()[0]?.label).toBe('friendly');
    // A new intel mapping for the same contact does override the operator.
    tracker.applyIntel(7, 'hostile', 60);
    expect(tracker.tracks()[0]?.label).toBe('hostile');
  });

  it('setLabel overrides votes and returns false for unknown ids', () => {
    const tracker = new Tracker();
    feed(tracker, 1, 3, mover([2000, 9000], [0, -50], { contactId: 7, declaredLabel: 'friendly' }));
    tracker.drainEvents();
    const id = tracker.tracks()[0]?.id as number;
    expect(tracker.setLabel(id, 'hostile', 35)).toBe(true);
    expect(tracker.tracks()[0]).toMatchObject({ label: 'hostile', labelConfidence: 1 });
    const events = tracker.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toMatch(/track 1 labelled hostile \(operator\)/);
    expect(tracker.setLabel(999, 'hostile', 35)).toBe(false);
    expect(tracker.drainEvents()).toEqual([]);
  });
});

describe('Tracker events', () => {
  it('emits one confirmation per track and one drop per confirmed-track drop, nothing per scan', () => {
    const world = new TestWorld(
      [contactSpec({ id: 1, pos: [-5000, 11_000], vel: [90, 40] }), contactSpec({ id: 2, pos: [8000, -6000], vel: [-30, 160], despawnAt: 20 })],
      Rng.fromLabel(SEED, 'world'),
    );
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'));
    const tracker = new Tracker();
    const confirmedIds = new Set<number>();
    const confirmationsById = new Map<number, number>();
    let dropTransitions = 0;
    let dropEventCount = 0;
    let otherEvents = 0;
    let prev = new Map<number, string>();
    runScans(400, world, radar, tracker, (scan, tick) => {
      const now = new Map<number, string>();
      for (const t of tracker.tracks()) {
        now.set(t.id, t.status);
        if (isConfirmed(t)) confirmedIds.add(t.id);
        const before = prev.get(t.id);
        if (t.status === 'dropped' && (before === 'confirmed' || before === 'coasting')) dropTransitions++;
      }
      prev = now;
      for (const e of tracker.drainEvents()) {
        expect(e.tick).toBe(tick);
        expect(e.time).toBeCloseTo(tick / 100, 9);
        expect(e.source).toBe('tracking');
        if (/confirmed/.test(e.message)) {
          expect(e.level).toBe('info');
          expect(e.message).toMatch(/^track \d+ confirmed at \d+\.\d km brg \d{3}°$/);
          confirmationsById.set(trackIdOf(e), (confirmationsById.get(trackIdOf(e)) ?? 0) + 1);
        } else if (/dropped/.test(e.message)) {
          expect(e.level).toBe('warn');
          dropEventCount++;
        } else {
          otherEvents++;
        }
      }
    });
    expect(confirmedIds.size).toBeGreaterThanOrEqual(2);
    expect([...confirmationsById.keys()].sort((a, b) => a - b)).toEqual([...confirmedIds].sort((a, b) => a - b));
    for (const n of confirmationsById.values()) expect(n).toBe(1);
    expect(dropTransitions).toBeGreaterThanOrEqual(1);
    expect(dropEventCount).toBe(dropTransitions);
    expect(otherEvents).toBe(0);
  });
});

describe('Tracker determinism', () => {
  it('produces identical tracks and events for identical detection sequences', () => {
    const { world, radar } = decoyScenario(SEED);
    const scans: Detection[][] = [];
    for (let s = 1; s <= 150; s++) {
      world.advance(DT_SCAN);
      scans.push(radar.scan(s * TICKS_PER_SCAN, world.platform, world.contacts));
    }
    const run = (): { tracks: string[]; events: string } => {
      const tracker = new Tracker({ gate: 'normal' });
      const tracks: string[] = [];
      scans.forEach((d, i) => {
        tracker.update((i + 1) * TICKS_PER_SCAN, d.map((x) => ({ ...x, pos: [...x.pos] as Vec2, cov: [...x.cov] as Detection['cov'] })), DT_SCAN);
        tracks.push(JSON.stringify(tracker.tracks()));
      });
      return { tracks, events: JSON.stringify(tracker.drainEvents()) };
    };
    const a = run();
    const b = run();
    expect(b.tracks).toEqual(a.tracks);
    expect(b.events).toBe(a.events);
    expect(a.tracks[149]?.length).toBeGreaterThan(100);
  });

  it('has no hidden state across instances', () => {
    const a = new Tracker();
    const b = new Tracker();
    a.update(10, [detection([1000, 1000])], DT_SCAN);
    expect(b.tracks()).toEqual([]);
    b.update(10, [detection([1000, 1000])], DT_SCAN);
    expect(b.tracks()[0]?.id).toBe(1);
  });
});
