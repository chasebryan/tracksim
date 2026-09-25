/**
 * Simulation worker. Owns the `Simulation` instance and the run loop; the
 * main thread only ever sees `FrameMessage`s and sends `HostMessage`s.
 * See packages/hud/src/contracts.ts for the protocol.
 */
import { BUILTIN_SCENARIOS, Simulation, TICK_HZ, getScenario } from '@tracksim/sim';
import type { Recording, Scenario, SimEvent, Snapshot } from '@tracksim/sim';
import type { ExportFormat, FrameMessage, HostMessage, WorkerMessage } from '../contracts';

const FRAME_INTERVAL_MS = 16;
const MAX_BACKLOG_S = 0.5;
const MIN_SPEED = 0.25;
const MAX_SPEED = 8;

let scenario: Scenario | null = null;
let sim: Simulation | null = null;
let playing = false;
let speed = 1;
let accumulatorTicks = 0;
let lastLoopAt = 0;
let lastFrameAt = -Infinity;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
/** Events the worker itself generates (run-loop warnings); merged into the next frame. */
let workerEvents: SimEvent[] = [];

function post(message: WorkerMessage, transfer?: Transferable[]): void {
  if (transfer) (self as unknown as Worker).postMessage(message, transfer);
  else (self as unknown as Worker).postMessage(message);
}

function postError(message: string): void {
  post({ type: 'error', message });
}

function postReady(): void {
  if (!sim || !scenario) return;
  post({
    type: 'ready',
    scenarios: BUILTIN_SCENARIOS.map((s) => ({ id: s.id, name: s.name, durationS: s.durationS, description: s.description })),
    scenarioId: scenario.id,
    seed: sim.seed,
  });
}

function postFrame(replyTo?: number): void {
  if (!sim) return;
  const base = sim.snapshot();
  const snapshot: Snapshot = workerEvents.length > 0 ? { ...base, events: [...base.events, ...workerEvents] } : base;
  workerEvents = [];
  const frame: FrameMessage = {
    type: 'frame',
    snapshot,
    terminal: sim.terminalLines(24),
    series: sim.series(300),
    playing,
    speed,
    endTick: sim.endTick,
  };
  if (replyTo !== undefined) frame.replyTo = replyTo;
  post(frame);
  lastFrameAt = performance.now();
}

function build(nextScenario: Scenario, seed: number, recording?: Recording): void {
  scenario = nextScenario;
  sim = recording ? Simulation.fromRecording(nextScenario, recording) : new Simulation(nextScenario, { seed });
  accumulatorTicks = 0;
  workerEvents = [];
}

function stopLoop(): void {
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function startLoop(): void {
  stopLoop();
  lastLoopAt = performance.now();
  loopTimer = setTimeout(loop, 0);
}

function loop(): void {
  loopTimer = null;
  if (!sim || !playing) return;

  const now = performance.now();
  const elapsedS = (now - lastLoopAt) / 1000;
  lastLoopAt = now;
  accumulatorTicks += elapsedS * speed * TICK_HZ;

  const backlogLimit = MAX_BACKLOG_S * speed * TICK_HZ;
  if (accumulatorTicks > backlogLimit) {
    const droppedS = (accumulatorTicks - backlogLimit) / (speed * TICK_HZ);
    accumulatorTicks = backlogLimit;
    workerEvents.push({
      tick: sim.tick,
      time: sim.time,
      source: 'system',
      level: 'warn',
      message: `Run loop fell behind real time; dropped ${droppedS.toFixed(2)} s`,
    });
  }

  let ticks = Math.floor(accumulatorTicks);
  accumulatorTicks -= ticks;
  while (ticks > 0 && sim.tick < sim.endTick) {
    sim.step();
    ticks--;
  }

  if (sim.tick >= sim.endTick) {
    playing = false;
    postFrame();
    return;
  }

  if (now - lastFrameAt >= FRAME_INTERVAL_MS) postFrame();
  loopTimer = setTimeout(loop, 4);
}

function handleExport(format: ExportFormat): void {
  if (!sim || !scenario) return;
  const stem = `tracksim-${scenario.id}-seed${sim.seed}-t${sim.tick}`;
  switch (format) {
    case 'jsonl':
      post({ type: 'export', format, data: sim.telemetryRing.toJSONL(), filename: `${stem}.jsonl` });
      break;
    case 'csv':
      post({ type: 'export', format, data: sim.telemetryRing.toCSV(), filename: `${stem}.csv` });
      break;
    case 'bin': {
      const buf = sim.telemetryRing.toBinary();
      post({ type: 'export', format, data: buf, filename: `${stem}.tsim` }, [buf]);
      break;
    }
    case 'recording':
      post({ type: 'export', format, data: JSON.stringify(sim.getRecording(), null, 2), filename: `${stem}.recording.json` });
      break;
  }
}

self.onmessage = (ev: MessageEvent<HostMessage>): void => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        let next: Scenario;
        try {
          next = getScenario(msg.scenarioId);
        } catch {
          next = BUILTIN_SCENARIOS[0] as Scenario;
        }
        playing = false;
        stopLoop();
        build(next, msg.seed < 0 ? next.seed : msg.seed >>> 0);
        postReady();
        postFrame();
        break;
      }
      case 'play':
        if (!sim) return;
        if (sim.tick >= sim.endTick) return;
        if (!playing) {
          playing = true;
          startLoop();
          postFrame();
        }
        break;
      case 'pause':
        if (playing) {
          playing = false;
          stopLoop();
          postFrame();
        }
        break;
      case 'speed':
        speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, msg.value));
        postFrame();
        break;
      case 'seek': {
        if (!sim || !scenario) return;
        const wasPlaying = playing;
        playing = false;
        stopLoop();
        const recording = sim.getRecording();
        build(scenario, recording.seed, recording);
        sim.stepTo(msg.tick);
        postFrame(msg.requestId);
        if (wasPlaying && sim.tick < sim.endTick) {
          playing = true;
          startLoop();
        }
        break;
      }
      case 'step':
        if (!sim) return;
        if (playing) {
          playing = false;
          stopLoop();
        }
        sim.stepTo(sim.tick + Math.max(0, Math.floor(msg.ticks)));
        postFrame(msg.requestId);
        break;
      case 'command':
        if (!sim) return;
        sim.enqueue(msg.command);
        if (!playing) {
          // Apply immediately so a paused operator sees the effect.
          if (sim.tick < sim.endTick) sim.step();
          postFrame();
        }
        break;
      case 'export':
        handleExport(msg.format);
        break;
      case 'loadRecording': {
        const rec = msg.recording;
        const next = getScenario(rec.scenarioId);
        playing = false;
        stopLoop();
        build(next, rec.seed, rec);
        sim!.stepTo(rec.endTick);
        postReady();
        postFrame();
        break;
      }
    }
  } catch (err) {
    postError(err instanceof Error ? err.message : String(err));
  }
};

export {};
