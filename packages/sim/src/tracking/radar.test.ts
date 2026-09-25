import { describe, expect, it } from 'vitest';
import { DEG } from '../core/constants';
import type { WorldContact } from '../core/interfaces';
import { Rng } from '../core/rng';
import type { Detection, PlatformTruth } from '../core/types';
import { DEFAULT_RADAR_CONFIG, Radar } from './radar';
import { TICKS_PER_SCAN, TestWorld, contactSpec } from './test-support';

const SEED = 4242;

/** Stationary platform at the origin: contact positions are then relative positions. */
function platform(): PlatformTruth {
  return { pos: [0, 0], vel: [0, 0], heading: 0, speed: 0, alt: 3000, turnRate: 0, accel: 0 };
}

function contact(over: Parameters<typeof contactSpec>[0], alive = true): WorldContact {
  const spec = contactSpec(over);
  return { spec, pos: [spec.pos[0], spec.pos[1]], vel: [spec.vel[0], spec.vel[1]], alive };
}

/** Run `scans` scans against a static world and collect every detection. */
function collect(radar: Radar, contacts: WorldContact[], scans: number): Detection[][] {
  const out: Detection[][] = [];
  const p = platform();
  for (let s = 1; s <= scans; s++) out.push(radar.scan(s * TICKS_PER_SCAN, p, contacts));
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

describe('Radar scan cadence', () => {
  it('scans every 10 ticks, never on tick 0', () => {
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'));
    expect(radar.isScanTick(0)).toBe(false);
    expect(radar.isScanTick(10)).toBe(true);
    expect(radar.isScanTick(20)).toBe(true);
    expect(radar.isScanTick(5)).toBe(false);
    expect(radar.isScanTick(11)).toBe(false);
    let count = 0;
    for (let tick = 0; tick <= 1000; tick++) if (radar.isScanTick(tick)) count++;
    expect(count).toBe(100);
  });

  it('rejects a scan rate that does not divide the tick rate', () => {
    expect(() => new Radar(Rng.fromLabel(SEED, 'radar'), { scanHz: 7 })).toThrow(/scanHz/);
  });
});

describe('Radar detection probability', () => {
  it('detects each kind at its pd over 2000 scans (±3%)', () => {
    // Binomial σ of a proportion over 2000 scans is ≤ sqrt(0.5·0.5/2000) = 0.011 and only
    // 0.005 at pd 0.95, so ±0.03 is at least 2.7σ for the worst case and 6σ for a vehicle.
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const contacts = [
      contact({ id: 1, kind: 'vehicle', pos: [0, 20_000] }),
      contact({ id: 2, kind: 'beacon', pos: [15_000, 0] }),
      contact({ id: 3, kind: 'decoy', pos: [-10_000, -10_000] }),
      contact({ id: 4, kind: 'vehicle', pos: [5000, -20_000], pd: 0.5 }),
    ];
    const scans = collect(radar, contacts, 2000);
    const rate = (id: number): number => scans.filter((d) => d.some((x) => x.contactId === id)).length / 2000;
    expect(Math.abs(rate(1) - DEFAULT_RADAR_CONFIG.pdByKind.vehicle)).toBeLessThan(0.03);
    expect(Math.abs(rate(2) - 0.98)).toBeLessThan(0.03);
    expect(Math.abs(rate(3) - 0.7)).toBeLessThan(0.03);
    expect(Math.abs(rate(4) - 0.5)).toBeLessThan(0.03);
    // A contact is reported at most once per scan.
    for (const d of scans) expect(d.filter((x) => x.contactId === 1).length).toBeLessThanOrEqual(1);
  });

  it('never detects contacts beyond maxRange or dead contacts', () => {
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const contacts = [
      contact({ id: 1, pos: [0, 61_000] }),
      contact({ id: 2, pos: [30_000, 30_000] }, false),
      contact({ id: 3, pos: [0, 59_000] }),
    ];
    const scans = collect(radar, contacts, 500);
    const all = scans.flat();
    expect(all.some((d) => d.contactId === 1)).toBe(false);
    expect(all.some((d) => d.contactId === 2)).toBe(false);
    // Sanity: the in-range contact at 59 km is seen.
    expect(all.filter((d) => d.contactId === 3).length).toBeGreaterThan(400);
  });

  it('carries declaredLabel only for declared contacts', () => {
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const contacts = [
      contact({ id: 1, kind: 'beacon', label: 'friendly', declared: true, pos: [0, 10_000] }),
      contact({ id: 2, kind: 'vehicle', label: 'hostile', declared: false, pos: [10_000, 0] }),
    ];
    const all = collect(radar, contacts, 200).flat();
    const beacon = all.filter((d) => d.contactId === 1);
    const vehicle = all.filter((d) => d.contactId === 2);
    expect(beacon.length).toBeGreaterThan(150);
    expect(vehicle.length).toBeGreaterThan(150);
    for (const d of beacon) expect(d.declaredLabel).toBe('friendly');
    for (const d of vehicle) expect(d.declaredLabel).toBeNull();
  });

  it('setPd scales pd with an upper clamp of 1 and expires at untilTick', () => {
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const contacts = [contact({ id: 1, pos: [0, 20_000] })];
    radar.setPd(2, 200 * TICKS_PER_SCAN);
    const boosted = collect(radar, contacts, 200);
    // 0.95 × 2 clamps to 1: every scan sees the contact.
    expect(boosted.every((d) => d.length === 1)).toBe(true);
    // Expired at tick 2000: back to the nominal 0.95 (±3%, 6σ over 2000 scans).
    expect(radar.status(2000, 'normal', 9.21).pd).toBe(1);
    const p = platform();
    let hits = 0;
    for (let s = 201; s <= 2200; s++) if (radar.scan(s * TICKS_PER_SCAN, p, contacts).length === 1) hits++;
    expect(Math.abs(hits / 2000 - 0.95)).toBeLessThan(0.03);
    // A multiplier of 0.5 halves the vehicle pd.
    radar.setPd(0.5, Infinity);
    let halved = 0;
    for (let s = 2201; s <= 4200; s++) if (radar.scan(s * TICKS_PER_SCAN, p, contacts).length === 1) halved++;
    expect(Math.abs(halved / 2000 - 0.475)).toBeLessThan(0.03);
  });
});

describe('Radar measurement model', () => {
  it('orients the covariance along range/bearing for a contact due north', () => {
    // For a contact due north the cross-range (bearing) axis is east and the range axis is
    // north, so var(E) = (r σb)² and var(N) = σr². The covariance is evaluated at the measured
    // range/bearing: σr/r = 0.15% shifts var(E) by 0.3% and a 0.3° bearing error leaks
    // sin²(0.3°) = 3e-5 of one axis into the other, so averaging 1000 detections lands well
    // inside 2%.
    const r = 20_000;
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const dets = collect(radar, [contact({ id: 1, pos: [0, r] })], 1100).flat();
    expect(dets.length).toBeGreaterThan(1000);
    const cross = r * DEFAULT_RADAR_CONFIG.sigmaBearing;
    const c00 = mean(dets.map((d) => d.cov[0]));
    const c11 = mean(dets.map((d) => d.cov[3]));
    const c01 = mean(dets.map((d) => Math.abs(d.cov[1])));
    expect(Math.abs(c00 / (cross * cross) - 1)).toBeLessThan(0.02);
    expect(Math.abs(c11 / (30 * 30) - 1)).toBeLessThan(0.02);
    expect(c01).toBeLessThan(0.02 * c00);
    for (const d of dets) expect(d.cov[1]).toBe(d.cov[2]);
  });

  it('swaps the axes for a contact due east', () => {
    const r = 20_000;
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const dets = collect(radar, [contact({ id: 1, pos: [r, 0] })], 1100).flat();
    const cross = r * DEFAULT_RADAR_CONFIG.sigmaBearing;
    expect(Math.abs(mean(dets.map((d) => d.cov[3])) / (cross * cross) - 1)).toBeLessThan(0.02);
    expect(Math.abs(mean(dets.map((d) => d.cov[0])) / (30 * 30) - 1)).toBeLessThan(0.02);
  });

  it('scatters positions with the advertised range and cross-range sigmas', () => {
    // Sample std over ~1050 detections has relative error 1/sqrt(2n) ≈ 2.2%; 10% is 4.5σ.
    const r = 20_000;
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const dets = collect(radar, [contact({ id: 1, pos: [0, r] })], 1100).flat();
    const cross = r * DEFAULT_RADAR_CONFIG.sigmaBearing;
    expect(Math.abs(std(dets.map((d) => d.pos[0])) / cross - 1)).toBeLessThan(0.1);
    expect(Math.abs(std(dets.map((d) => d.pos[1])) / 30 - 1)).toBeLessThan(0.1);
    expect(Math.abs(mean(dets.map((d) => d.pos[1])) - r)).toBeLessThan(5);
    expect(Math.abs(mean(dets.map((d) => d.pos[0])))).toBeLessThan(15);
  });

  it('reports the contact elevation with 0.2° noise', () => {
    // Mean of ~1050 samples of N(3°, 0.2°) has σ = 0.006°; 0.05° is 8σ.
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'), { clutterRate: 0 });
    const dets = collect(radar, [contact({ id: 1, pos: [0, 10_000], elevationDeg: 3 })], 1100).flat();
    const el = dets.map((d) => d.elevation);
    expect(Math.abs(mean(el) - 3 * DEG)).toBeLessThan(0.05 * DEG);
    expect(Math.abs(std(el) / (0.2 * DEG) - 1)).toBeLessThan(0.1);
  });
});

describe('Radar clutter', () => {
  it('produces Poisson(clutterRate) false detections per scan (mean ±5%)', () => {
    // σ of the mean of 4000 Poisson(2) draws is sqrt(2/4000) = 0.022; ±0.1 is 4.5σ.
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'));
    const scans = collect(radar, [], 4000);
    const counts = scans.map((d) => d.length);
    expect(Math.abs(mean(counts) - 2)).toBeLessThan(0.1);
    // Poisson: variance ≈ mean (loose 15% check on the sample variance).
    expect(Math.abs(std(counts) ** 2 / 2 - 1)).toBeLessThan(0.15);
    for (const d of scans.flat()) {
      expect(d.contactId).toBeNull();
      expect(d.declaredLabel).toBeNull();
      expect(Math.hypot(d.pos[0], d.pos[1])).toBeLessThanOrEqual(DEFAULT_RADAR_CONFIG.maxRange);
      expect(Math.abs(d.elevation)).toBeLessThanOrEqual(5 * DEG);
    }
  });

  it('spreads clutter uniformly over the disc', () => {
    // For a uniform disc, mean(r²) = R²/2 and range fractions are uniform in [0, 1]
    // (r = R√u). With ~8000 samples the mean of r²/R² has σ ≈ 0.003; 0.02 is ~6σ.
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'));
    const dets = collect(radar, [], 4000).flat();
    const R = DEFAULT_RADAR_CONFIG.maxRange;
    const frac = dets.map((d) => (d.pos[0] ** 2 + d.pos[1] ** 2) / (R * R));
    expect(Math.abs(mean(frac) - 0.5)).toBeLessThan(0.02);
    const east = dets.filter((d) => d.pos[0] > 0).length / dets.length;
    expect(Math.abs(east - 0.5)).toBeLessThan(0.02);
  });

  it('honours setClutterRate until its tick, then restores the nominal rate with events', () => {
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'));
    radar.setClutterRate(10, 1000);
    const burst = collect(radar, [], 99);
    expect(Math.abs(mean(burst.map((d) => d.length)) - 10)).toBeLessThan(1.5);
    expect(radar.status(990, 'normal', 9.21).clutterRate).toBe(10);
    const events = radar.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe('radar');
    expect(events[0]?.message).toMatch(/clutter rate set to 10/);
    expect(events[0]?.tick).toBe(10);
    // Tick 1000 reaches untilTick: back to 2.
    expect(radar.isScanTick(1000)).toBe(true);
    expect(radar.status(1000, 'normal', 9.21).clutterRate).toBe(2);
    const restore = radar.drainEvents();
    expect(restore).toHaveLength(1);
    expect(restore[0]?.message).toMatch(/restored/);
    expect(restore[0]?.tick).toBe(1000);
    expect(radar.drainEvents()).toHaveLength(0);
  });
});

describe('Radar status', () => {
  it('reports the last scan counts, ticks since scan and the tracker gate', () => {
    const radar = new Radar(Rng.fromLabel(SEED, 'radar'));
    const contacts = [contact({ id: 1, pos: [0, 10_000], pd: 1 })];
    const dets = radar.scan(10, platform(), contacts);
    const s = radar.status(13, 'strict', 5.991);
    expect(s.scanHz).toBe(10);
    expect(s.maxRange).toBe(60_000);
    expect(s.detectionsLastScan).toBe(dets.length);
    expect(s.clutterLastScan).toBe(dets.length - 1);
    expect(s.ticksSinceScan).toBe(3);
    expect(s.gate).toBe('strict');
    expect(s.gateChi2).toBe(5.991);
    expect(s.pd).toBe(1);
  });
});

describe('Radar determinism', () => {
  it('reproduces identical detections for the same seed and diverges for another', () => {
    const run = (seed: number): string => {
      const world = new TestWorld(
        [contactSpec({ id: 1, pos: [3000, 15_000], vel: [50, -80], jitter: 20 }), contactSpec({ id: 2, pos: [-9000, 4000], vel: [120, 60] })],
        Rng.fromLabel(seed, 'world'),
      );
      const radar = new Radar(Rng.fromLabel(seed, 'radar'));
      const out: Detection[][] = [];
      for (let s = 1; s <= 100; s++) {
        world.advance(0.1);
        out.push(radar.scan(s * TICKS_PER_SCAN, world.platform, world.contacts));
      }
      return JSON.stringify(out);
    };
    const a = run(SEED);
    expect(run(SEED)).toBe(a);
    expect(run(SEED + 1)).not.toBe(a);
  });
});
