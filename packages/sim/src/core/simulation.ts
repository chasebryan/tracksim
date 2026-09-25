/**
 * Simulation orchestrator — composes world, navigation, radar, tracker,
 * scenario player and telemetry into one deterministic fixed-step loop.
 *
 * See CONTRACTS.md "Tick pipeline" for the ordering guarantees. The only
 * clock is the tick; `now()` is used solely to *measure* compute cost.
 */
import { DEG, DT, TICK_HZ, secondsToTick } from './constants';
import { Rng } from './rng';
import type {
  Command,
  Recording,
  Scenario,
  ScenarioEvent,
  SensorId,
  SimEvent,
  Snapshot,
  TimedCommand,
} from './types';
import { SENSOR_IDS } from './types';
import { World } from '../world/index';
import { NavigationFilter } from '../nav/index';
import { Radar, Tracker } from '../tracking/index';
import { ScenarioPlayer, eventUntilTick } from '../scenario/index';
import { TELEMETRY_FIELDS, TelemetryRing, buildTelemetryRecord, formatTerminalLine } from '../telemetry/index';

export interface SimulationOptions {
  /** Overrides the scenario's default seed. */
  seed?: number;
  telemetryCapacity?: number;
  /** Millisecond clock used only to measure tick cost. Defaults to performance.now when present. */
  now?: () => number;
}

const SERIES_FIELDS = ['posError', 'posSigma', 'traceP', ...SENSOR_IDS.map((id) => `${id}_nis`)];

function defaultNow(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? () => perf.now() : () => 0;
}

export class Simulation {
  readonly scenario: Scenario;
  readonly seed: number;
  readonly endTick: number;
  tick = 0;

  private readonly world: World;
  private readonly nav: NavigationFilter;
  private readonly radar: Radar;
  private readonly tracker: Tracker;
  private readonly player: ScenarioPlayer;
  private readonly telemetry: TelemetryRing;
  private readonly now: () => number;

  /** Commands still to be applied, sorted by tick. */
  private pending: TimedCommand[] = [];
  /** Every command ever enqueued (the recording). */
  private commandLog: TimedCommand[] = [];
  private systemEvents: SimEvent[] = [];
  private lastSnapshot: Snapshot;

  constructor(scenario: Scenario, opts: SimulationOptions = {}) {
    this.scenario = scenario;
    this.seed = (opts.seed ?? scenario.seed) >>> 0;
    this.endTick = secondsToTick(scenario.durationS);
    this.now = opts.now ?? defaultNow();

    this.world = new World(scenario, Rng.fromLabel(this.seed, 'world'));
    this.nav = new NavigationFilter(this.world.platform, Rng.fromLabel(this.seed, 'nav'));
    this.radar = new Radar(Rng.fromLabel(this.seed, 'radar'));
    this.tracker = new Tracker();
    this.player = new ScenarioPlayer(scenario);
    this.telemetry = new TelemetryRing(TELEMETRY_FIELDS, opts.telemetryCapacity ?? 36_000, this.now);

    this.pushSystemEvent('system', 'info', `Simulation initialised: ${scenario.name} (seed ${this.seed})`);
    this.lastSnapshot = this.assemble(0, false, 0, 0);
  }

  /** Build a simulation positioned at tick 0 with a recording's command log loaded for replay. */
  static fromRecording(scenario: Scenario, recording: Recording, opts: SimulationOptions = {}): Simulation {
    if (recording.scenarioId !== scenario.id) {
      throw new Error(`Recording is for scenario "${recording.scenarioId}", not "${scenario.id}"`);
    }
    const sim = new Simulation(scenario, { ...opts, seed: recording.seed });
    const commands = [...recording.commands].sort((a, b) => a.tick - b.tick);
    sim.pending = commands.map((c) => ({ tick: c.tick, command: c.command }));
    sim.commandLog = commands.map((c) => ({ tick: c.tick, command: c.command }));
    return sim;
  }

  get time(): number {
    return this.tick * DT;
  }

  get telemetryRing(): TelemetryRing {
    return this.telemetry;
  }

  /** Queue an operator command; it applies at the start of the next step and is recorded. */
  enqueue(command: Command): TimedCommand {
    const timed: TimedCommand = { tick: this.tick + 1, command };
    this.pending.push(timed);
    this.commandLog.push(timed);
    return timed;
  }

  getRecording(): Recording {
    return {
      version: 1,
      seed: this.seed,
      scenarioId: this.scenario.id,
      commands: this.commandLog.map((c) => ({ tick: c.tick, command: c.command })),
      endTick: this.tick,
    };
  }

  snapshot(): Snapshot {
    return this.lastSnapshot;
  }

  /** Advance one tick and return the new snapshot. */
  step(): Snapshot {
    const t0 = this.now();
    const tick = this.tick + 1;

    // 1. operator commands due now
    while (this.pending.length > 0 && (this.pending[0] as TimedCommand).tick <= tick) {
      const timed = this.pending.shift() as TimedCommand;
      this.applyCommand(timed.command, tick);
    }

    // 2. scenario events due now
    for (const event of this.player.eventsDue(tick)) this.applyScenarioEvent(event, tick);

    // 3. world, 4. nav
    this.world.step(tick);
    this.nav.step(tick, this.world.platform);

    // 5. radar + tracker on scan ticks
    let detections = 0;
    let clutter = 0;
    const scan = this.radar.isScanTick(tick);
    if (scan) {
      const dets = this.radar.scan(tick, this.world.platform, this.world.contacts);
      this.tracker.update(tick, dets, 1 / this.radar.status(tick, this.tracker.gate, this.tracker.gateChi2).scanHz);
      detections = dets.length;
      clutter = dets.filter((d) => d.contactId === null).length;
    }

    this.tick = tick;
    const micros = (this.now() - t0) * 1000;
    // 6 + 7. telemetry and snapshot
    this.lastSnapshot = this.assemble(micros, scan, detections, clutter);
    return this.lastSnapshot;
  }

  stepTo(tick: number): Snapshot {
    const target = Math.min(Math.max(0, Math.floor(tick)), this.endTick);
    while (this.tick < target) this.step();
    return this.lastSnapshot;
  }

  /** Last `count` telemetry records formatted for the terminal panel, oldest first. */
  terminalLines(count = 24): string[] {
    const n = Math.min(count, this.telemetry.length);
    const lines: string[] = [];
    for (let i = this.telemetry.length - n; i < this.telemetry.length; i++) {
      lines.push(formatTerminalLine(this.telemetry.get(i), this.telemetry.fields));
    }
    return lines;
  }

  /** Recent telemetry columns for the scope panel, oldest first. */
  series(count = 300): Record<string, Float32Array> {
    const out: Record<string, Float32Array> = {};
    for (const field of SERIES_FIELDS) out[field] = Float32Array.from(this.telemetry.column(field, count));
    return out;
  }

  // -------------------------------------------------------------------------

  private applyCommand(command: Command, tick: number): void {
    switch (command.type) {
      case 'gate':
        this.tracker.setGate(command.value, tick);
        this.pushSystemEvent('operator', 'info', `Gate set to ${command.value}`);
        break;
      case 'sensor.enable':
        this.nav.setSensorEnabled(command.sensor, command.enabled, tick);
        this.pushSystemEvent('operator', 'info', `${command.sensor} ${command.enabled ? 'enabled' : 'disabled'}`);
        break;
      case 'sensor.disturb':
        this.nav.setDisturbance(
          command.sensor,
          { noiseScale: command.noiseScale, bias: [command.bias[0], command.bias[1]], untilTick: tick + secondsToTick(command.durationS) },
          tick,
        );
        this.pushSystemEvent(
          'operator',
          'warn',
          `${command.sensor} disturbed: noise ×${command.noiseScale}, bias [${command.bias[0]}, ${command.bias[1]}] m for ${command.durationS}s`,
        );
        break;
      case 'sensor.clear':
        this.nav.clearDisturbance(command.sensor, tick);
        this.pushSystemEvent('operator', 'info', `${command.sensor} disturbance cleared`);
        break;
      case 'radar.clutter':
        this.radar.setClutterRate(command.rate, tick + secondsToTick(command.durationS));
        this.pushSystemEvent('operator', 'warn', `Clutter rate set to ${command.rate}/scan for ${command.durationS}s`);
        break;
      case 'contacts.spawnDecoys': {
        const ids = this.world.spawnDecoys(command.count, tick, command.nearContactId);
        this.pushSystemEvent('operator', 'warn', `Spawned ${ids.length} decoys (${ids.join(', ')})`);
        break;
      }
      case 'track.label': {
        const ok = this.tracker.setLabel(command.trackId, command.label, tick);
        this.pushSystemEvent('operator', ok ? 'info' : 'warn', ok ? `Track ${command.trackId} labelled ${command.label}` : `Track ${command.trackId} not found`);
        break;
      }
      case 'log':
        this.pushSystemEvent('operator', 'info', command.message);
        break;
    }
  }

  private applyScenarioEvent(event: ScenarioEvent, tick: number): void {
    const until = eventUntilTick(event);
    switch (event.type) {
      case 'sensor.noise':
        this.nav.setDisturbance(event.sensor, { noiseScale: event.scale, bias: [0, 0], untilTick: until }, tick);
        break;
      case 'sensor.bias':
        this.nav.setDisturbance(event.sensor, { noiseScale: 1, bias: [event.bias[0], event.bias[1]], untilTick: until }, tick);
        break;
      case 'sensor.enable':
        this.nav.setSensorEnabled(event.sensor, event.enabled, tick);
        break;
      case 'platform.turn':
        this.world.setTurn(event.rateDegS * DEG, until);
        break;
      case 'platform.accel':
        this.world.setAccel(event.mps2, until);
        break;
      case 'radar.clutter':
        this.radar.setClutterRate(event.rate, until);
        break;
      case 'radar.pd':
        this.radar.setPd(event.pd, until);
        break;
      case 'contacts.spawn':
        for (const spec of event.contacts) this.world.spawn(spec, tick);
        break;
      case 'contact.despawn':
        this.world.despawn(event.id, tick);
        break;
      case 'intel':
        this.tracker.applyIntel(event.contactId, event.label, tick);
        break;
      case 'log':
        this.pushSystemEvent('scenario', event.level ?? 'info', event.message);
        break;
    }
  }

  private pushSystemEvent(source: SimEvent['source'], level: SimEvent['level'], message: string): void {
    this.systemEvents.push({ tick: this.tick, time: this.tick * DT, source, level, message });
  }

  private assemble(tickMicros: number, radarScan: boolean, detections: number, clutter: number): Snapshot {
    const tick = this.tick;
    const truth = { ...this.world.platform, pos: [...this.world.platform.pos] as [number, number], vel: [...this.world.platform.vel] as [number, number] };
    const nav = this.nav.estimate(truth);
    const sensors = this.nav.sensorStatuses();
    const radar = this.radar.status(tick, this.tracker.gate, this.tracker.gateChi2);
    const tracks = this.tracker.tracks();
    const contacts = this.world.contactSnapshots();
    const tracksConfirmed = tracks.filter((t) => t.status === 'confirmed' || t.status === 'coasting').length;
    const tracksTotal = tracks.filter((t) => t.status !== 'dropped').length;

    this.telemetry.push(
      buildTelemetryRecord({
        tick,
        time: tick * DT,
        truth,
        nav,
        sensors,
        tracksTotal,
        tracksConfirmed,
        detections,
        clutter,
        radarScan,
        tickMicros,
      }),
      tick,
    );

    const events = [
      ...this.world.drainEvents(),
      ...this.nav.drainEvents(),
      ...this.radar.drainEvents(),
      ...this.tracker.drainEvents(),
      ...this.systemEvents,
    ];
    this.systemEvents = [];

    return {
      tick,
      time: tick * DT,
      seed: this.seed,
      scenarioId: this.scenario.id,
      scenarioName: this.scenario.name,
      durationS: this.scenario.durationS,
      phase: this.player.phaseAt(tick * DT),
      truth,
      nav,
      sensors,
      radar,
      tracks,
      contacts,
      events,
      telemetry: this.telemetry.metrics(tick),
      tickMicros,
    };
  }
}

export const SIM_TICK_HZ = TICK_HZ;
export type { SensorId };
