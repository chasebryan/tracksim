/**
 * Multi-target tracker: one constant-velocity Kalman filter per track in the
 * platform-relative frame, chi-square gating, greedy global-nearest-neighbour
 * association (confirmed tracks first), M-of-N confirmation and K-miss
 * deletion driven by the gate setting (see gates.ts). Needs no randomness;
 * tracks are iterated in creation order and association ties are broken by
 * index, so identical detection sequences yield identical tracks.
 */
import { DT, RAD } from '../core/constants';
import type { ITracker } from '../core/interfaces';
import type { Detection, GateSetting, SimEvent, TrackLabel, TrackSnapshot, TrackStatus, Vec2 } from '../core/types';
import { KalmanFilter, H_POSITION_2D, constantVelocity2D } from '../math/kalman';
import { Mat } from '../math/mat';
import { GATE_SETTINGS, GATE_TABLE } from './gates';
import type { GateParams } from './gates';

export interface TrackerConfig {
  /** Initial gate setting. */
  gate: GateSetting;
  /** White-noise acceleration σ of the constant-velocity model, m/s². */
  sigmaAccel: number;
  /**
   * Initial velocity σ of a new track, m/s. Tracks live in the platform-relative
   * frame, so relative speeds of several hundred m/s are routine; a prior much
   * tighter than that starves the velocity gain, biases every innovation and
   * makes the strict gate drop fast contacts repeatedly.
   */
  initVelSigma: number;
  /** Scans a dropped track stays listed in `tracks()` after dropping. */
  droppedRetainScans: number;
  /** Scans over which the hit ratio in `quality` is computed. */
  qualityWindow: number;
  /** Position σ (metres) at which the positional term of `quality` reaches 0. */
  qualitySigmaRef: number;
}

export const DEFAULT_TRACKER_CONFIG: Readonly<TrackerConfig> = {
  gate: 'normal',
  sigmaAccel: 8,
  initVelSigma: 200,
  droppedRetainScans: 10,
  qualityWindow: 10,
  qualitySigmaRef: 400,
};

type LabelSource = 'operator' | 'intel';

interface Track {
  id: number;
  kf: KalmanFilter;
  status: TrackStatus;
  /** True once M-of-N was met; never reverts (dropping ends the track instead). */
  confirmed: boolean;
  hits: number;
  misses: number;
  consecutiveMisses: number;
  ageScans: number;
  hitThisScan: boolean;
  /** 1/0 per scan, most recent last, capped at the window length. */
  window: number[];
  votes: Map<TrackLabel, number>;
  contacts: Map<number, number>;
  override: { label: TrackLabel; source: LabelSource } | null;
  /** Version of the intel mapping last applied to this track. */
  intelVersion: number;
  elevation: number;
  droppedScans: number;
}

interface Pair {
  ti: number;
  di: number;
  d2: number;
  /** 0 for confirmed tracks, 1 for tentative: confirmed tracks are assigned first. */
  tier: number;
}

/** Multi-target tracker with gated greedy nearest-neighbour association. */
export class Tracker implements ITracker {
  readonly config: Readonly<TrackerConfig>;
  private gateSetting: GateSetting;
  private params: Readonly<GateParams>;
  private readonly windowLength: number;
  private readonly trackList: Track[] = [];
  private nextId = 1;
  private readonly intel = new Map<number, { label: TrackLabel; version: number }>();
  private intelVersion = 0;
  private events: SimEvent[] = [];
  private model: { dt: number; F: Mat; Q: Mat } | null = null;

  constructor(config: Partial<TrackerConfig> = {}) {
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
    this.gateSetting = this.config.gate;
    this.params = GATE_TABLE[this.gateSetting];
    let longestN = 0;
    for (const g of GATE_SETTINGS) longestN = Math.max(longestN, GATE_TABLE[g].n);
    this.windowLength = Math.max(this.config.qualityWindow, longestN);
  }

  get gate(): GateSetting {
    return this.gateSetting;
  }

  get gateChi2(): number {
    return this.params.gateChi2;
  }

  setGate(g: GateSetting, tick: number): void {
    if (g === this.gateSetting) return;
    this.gateSetting = g;
    this.params = GATE_TABLE[g];
    const p = this.params;
    this.emit(
      tick,
      'info',
      `gate ${g}: chi2 ${p.gateChi2}, confirm ${p.m}/${p.n}, drop after ${p.kConfirmed}/${p.kTentative} misses`,
    );
  }

  update(tick: number, detections: Detection[], dtScan: number): void {
    // Dropped tracks linger for `droppedRetainScans` scans, then leave the list.
    for (let i = this.trackList.length - 1; i >= 0; i--) {
      const t = this.trackList[i] as Track;
      if (t.status !== 'dropped') continue;
      t.droppedScans++;
      if (t.droppedScans >= this.config.droppedRetainScans) this.trackList.splice(i, 1);
    }

    // 1. Predict every live track.
    const { F, Q } = this.modelFor(dtScan);
    const live: Track[] = [];
    for (const t of this.trackList) {
      if (t.status === 'dropped') continue;
      t.kf.predict(F, Q);
      t.ageScans++;
      t.hitThisScan = false;
      live.push(t);
    }

    // 2. Gate every (track, detection) pair on d² = yᵀ S⁻¹ y, S = H P Hᵀ + R.
    const gateChi2 = this.params.gateChi2;
    const pairs: Pair[] = [];
    for (let i = 0; i < live.length; i++) {
      const t = live[i] as Track;
      const P = t.kf.P.data;
      const x = t.kf.x.data;
      const p00 = P[0] as number;
      const p01 = P[1] as number;
      const p11 = P[5] as number;
      const xE = x[0] as number;
      const xN = x[1] as number;
      for (let j = 0; j < detections.length; j++) {
        const d = detections[j] as Detection;
        const s00 = p00 + d.cov[0];
        const s01 = p01 + 0.5 * (d.cov[1] + d.cov[2]);
        const s11 = p11 + d.cov[3];
        const det = s00 * s11 - s01 * s01;
        if (!(det > 0)) continue;
        const y0 = d.pos[0] - xE;
        const y1 = d.pos[1] - xN;
        const d2 = (s11 * y0 * y0 - 2 * s01 * y0 * y1 + s00 * y1 * y1) / det;
        if (d2 <= gateChi2) pairs.push({ ti: i, di: j, d2, tier: t.confirmed ? 0 : 1 });
      }
    }

    // 3. Greedy global nearest neighbour, best d² first, ties by track then detection index.
    //    Confirmed tracks get first pick: a tentative track spawned from a single gated-out
    //    detection carries S ≈ 2R and would otherwise out-compete the tight confirmed track
    //    for the next real detection, dropping it after a few steals.
    pairs.sort((a, b) => a.tier - b.tier || a.d2 - b.d2 || a.ti - b.ti || a.di - b.di);
    const trackAssigned = new Int32Array(live.length).fill(-1);
    const detAssigned = new Int32Array(detections.length).fill(-1);
    for (const pr of pairs) {
      if (trackAssigned[pr.ti] !== -1 || detAssigned[pr.di] !== -1) continue;
      trackAssigned[pr.ti] = pr.di;
      detAssigned[pr.di] = pr.ti;
    }

    // 4. Update assigned tracks, count misses on the rest.
    for (let i = 0; i < live.length; i++) {
      const t = live[i] as Track;
      const di = trackAssigned[i] as number;
      if (di >= 0) {
        const d = detections[di] as Detection;
        t.kf.update(Mat.col(d.pos), H_POSITION_2D, new Mat(2, 2, d.cov));
        t.hits++;
        t.consecutiveMisses = 0;
        t.hitThisScan = true;
        this.pushWindow(t, 1);
        this.recordDetection(t, d, tick);
      } else {
        t.misses++;
        t.consecutiveMisses++;
        this.pushWindow(t, 0);
      }
    }

    // 5. Unassigned detections start tentative tracks.
    for (let j = 0; j < detections.length; j++) {
      if (detAssigned[j] !== -1) continue;
      const t = this.spawn(detections[j] as Detection, tick);
      live.push(t);
    }

    // 6. Confirmation and deletion.
    for (const t of live) this.evaluate(t, tick);
  }

  setLabel(trackId: number, label: TrackLabel, tick: number): boolean {
    const t = this.trackList.find((x) => x.id === trackId);
    if (!t) return false;
    this.setOverride(t, label, 'operator', tick, null);
    return true;
  }

  applyIntel(contactId: number, label: TrackLabel, tick: number): void {
    this.intelVersion++;
    this.intel.set(contactId, { label, version: this.intelVersion });
    for (const t of this.trackList) {
      if (t.status === 'dropped' || !t.contacts.has(contactId)) continue;
      t.intelVersion = this.intelVersion;
      this.setOverride(t, label, 'intel', tick, contactId);
    }
  }

  tracks(): TrackSnapshot[] {
    return this.trackList.map((t) => this.snapshot(t));
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private modelFor(dt: number): { F: Mat; Q: Mat } {
    if (!this.model || this.model.dt !== dt) {
      const { F, Q } = constantVelocity2D(dt, this.config.sigmaAccel);
      this.model = { dt, F, Q };
    }
    return this.model;
  }

  private spawn(d: Detection, tick: number): Track {
    const v = this.config.initVelSigma * this.config.initVelSigma;
    const P = Mat.fromRows([
      [d.cov[0], d.cov[1], 0, 0],
      [d.cov[2], d.cov[3], 0, 0],
      [0, 0, v, 0],
      [0, 0, 0, v],
    ]);
    const t: Track = {
      id: this.nextId++,
      kf: new KalmanFilter(Mat.col([d.pos[0], d.pos[1], 0, 0]), P),
      status: 'tentative',
      confirmed: false,
      hits: 1,
      misses: 0,
      consecutiveMisses: 0,
      ageScans: 1,
      hitThisScan: true,
      window: [1],
      votes: new Map(),
      contacts: new Map(),
      override: null,
      intelVersion: 0,
      elevation: d.elevation,
      droppedScans: 0,
    };
    this.trackList.push(t);
    this.recordDetection(t, d, tick);
    return t;
  }

  /** Bookkeeping shared by track creation and association: votes, contact tally, intel. */
  private recordDetection(t: Track, d: Detection, tick: number): void {
    t.elevation = d.elevation;
    if (d.declaredLabel !== null) t.votes.set(d.declaredLabel, (t.votes.get(d.declaredLabel) ?? 0) + 1);
    if (d.contactId !== null) {
      t.contacts.set(d.contactId, (t.contacts.get(d.contactId) ?? 0) + 1);
      const intel = this.intel.get(d.contactId);
      if (intel && t.intelVersion < intel.version) {
        t.intelVersion = intel.version;
        this.setOverride(t, intel.label, 'intel', tick, d.contactId);
      }
    }
  }

  private pushWindow(t: Track, hit: number): void {
    t.window.push(hit);
    if (t.window.length > this.windowLength) t.window.shift();
  }

  private evaluate(t: Track, tick: number): void {
    const p = this.params;
    if (!t.confirmed && sumLast(t.window, p.n) >= p.m) {
      t.confirmed = true;
      const x = t.kf.x.data;
      const range = Math.hypot(x[0] as number, x[1] as number);
      const bearing = (Math.atan2(x[0] as number, x[1] as number) * RAD + 360) % 360;
      this.emit(
        tick,
        'info',
        `track ${t.id} confirmed at ${(range / 1000).toFixed(1)} km brg ${bearing.toFixed(0).padStart(3, '0')}°`,
      );
    }
    const k = t.confirmed ? p.kConfirmed : p.kTentative;
    if (t.consecutiveMisses >= k) {
      t.status = 'dropped';
      t.droppedScans = 0;
      if (t.confirmed) this.emit(tick, 'warn', `track ${t.id} dropped after ${t.consecutiveMisses} missed scans`);
    } else if (t.confirmed) {
      t.status = t.hitThisScan ? 'confirmed' : 'coasting';
    } else {
      t.status = 'tentative';
    }
  }

  private setOverride(t: Track, label: TrackLabel, source: LabelSource, tick: number, contactId: number | null): void {
    const before = this.resolveLabel(t).label;
    t.override = { label, source };
    if (source === 'operator' || before !== label) {
      const via = source === 'intel' ? `intel on contact ${contactId}` : 'operator';
      this.emit(tick, 'info', `track ${t.id} labelled ${label} (${via})`);
    }
  }

  private resolveLabel(t: Track): { label: TrackLabel; confidence: number } {
    if (t.override) return { label: t.override.label, confidence: 1 };
    let best: TrackLabel | null = null;
    let bestVotes = 0;
    for (const [label, n] of t.votes) {
      if (n > bestVotes) {
        best = label;
        bestVotes = n;
      }
    }
    if (best === null) return { label: 'unknown', confidence: 0 };
    return { label: best, confidence: Math.min(1, bestVotes / Math.max(1, t.hits)) };
  }

  private snapshot(t: Track): TrackSnapshot {
    const x = t.kf.x.data;
    const P = t.kf.P.data;
    const pos: Vec2 = [x[0] as number, x[1] as number];
    const vel: Vec2 = [x[2] as number, x[3] as number];
    const posSigma = Math.sqrt(0.5 * ((P[0] as number) + (P[5] as number)));
    const recent = t.window.slice(-this.config.qualityWindow);
    const hitRatio = recent.length > 0 ? sumLast(recent, recent.length) / recent.length : 0;
    const certainty = Math.min(1, Math.max(0, 1 - posSigma / this.config.qualitySigmaRef));
    const { label, confidence } = this.resolveLabel(t);
    return {
      id: t.id,
      status: t.status,
      label,
      labelConfidence: confidence,
      quality: 0.6 * hitRatio + 0.4 * certainty,
      pos,
      vel,
      range: Math.hypot(pos[0], pos[1]),
      bearing: Math.atan2(pos[0], pos[1]),
      elevation: t.elevation,
      speed: Math.hypot(vel[0], vel[1]),
      ageScans: t.ageScans,
      hits: t.hits,
      misses: t.misses,
      consecutiveMisses: t.consecutiveMisses,
      posSigma,
      contactId: dominantContact(t.contacts),
    };
  }

  private emit(tick: number, level: SimEvent['level'], message: string): void {
    this.events.push({ tick, time: tick * DT, source: 'tracking', level, message });
  }
}

/** Sum of the last `n` entries of `window` (fewer if the window is shorter). */
function sumLast(window: readonly number[], n: number): number {
  let s = 0;
  for (let i = Math.max(0, window.length - n); i < window.length; i++) s += window[i] as number;
  return s;
}

/** Most frequently associated contact id (first inserted wins ties), or null. */
function dominantContact(counts: ReadonlyMap<number, number>): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const [id, n] of counts) {
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  }
  return best;
}
