/**
 * HUD entry point: creates the simulation worker, the DOM panels and the
 * canvas renderers, and wires them together. Also installs `window.__tracksim`
 * for e2e tests and the demo recorder.
 */
import type { Command, Snapshot } from '@tracksim/sim';
import type { ExportFormat, FrameMessage, HostMessage, HudView, ReadyMessage, TracksimTestApi, WorkerMessage } from './contracts';
import { GlobeRenderer, ScopeRenderer } from './render/index';
import { createHud } from './ui/index';
import './styles.css';

const params = new URLSearchParams(location.search);
const initialScenario = params.get('scenario') ?? 'baseline';
/** -1 tells the worker to use the scenario's default seed. */
const initialSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : -1;

const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });

function send(message: HostMessage): void {
  worker.postMessage(message);
}

let latestFrame: FrameMessage | null = null;
let ready: ReadyMessage | null = null;
let frameDirty = false;
let requestCounter = 0;
const pendingReplies = new Map<number, (snapshot: Snapshot) => void>();

let resolveReady: () => void = () => {};
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

const hud: HudView = createHud({
  play: () => send({ type: 'play' }),
  pause: () => send({ type: 'pause' }),
  setSpeed: (value) => send({ type: 'speed', value }),
  seek: (tick) => send({ type: 'seek', tick }),
  selectScenario: (id, seed) => {
    ready = null;
    send({ type: 'init', scenarioId: id, seed });
  },
  command: (command: Command) => send({ type: 'command', command }),
  exportAs: (format: ExportFormat) => send({ type: 'export', format }),
  loadRecording: (file: File) => {
    file
      .text()
      .then((text) => {
        const recording = JSON.parse(text);
        if (!recording || recording.version !== 1 || !Array.isArray(recording.commands)) {
          throw new Error('Not a tracksim recording');
        }
        send({ type: 'loadRecording', recording });
      })
      .catch((err: unknown) => hud.showError(err instanceof Error ? err.message : String(err)));
  },
  selectTrack: (trackId) => {
    hud.state.selectedTrackId = trackId;
    frameDirty = true;
  },
});

const globe = new GlobeRenderer(hud.globeCanvas);
const scope = new ScopeRenderer(hud.scopeCanvas);

function resizeAll(): void {
  globe.resize();
  scope.resize();
  frameDirty = true;
}

const observer = new ResizeObserver(() => resizeAll());
if (hud.globeCanvas.parentElement) observer.observe(hud.globeCanvas.parentElement);
if (hud.scopeCanvas.parentElement) observer.observe(hud.scopeCanvas.parentElement);
window.addEventListener('resize', resizeAll);
resizeAll();

hud.globeCanvas.addEventListener('click', (ev) => {
  if (!latestFrame) return;
  const rect = hud.globeCanvas.getBoundingClientRect();
  const id = globe.hitTest(ev.clientX - rect.left, ev.clientY - rect.top, latestFrame.snapshot);
  hud.state.selectedTrackId = id === hud.state.selectedTrackId ? null : id;
  frameDirty = true;
});

function download(filename: string, data: string | ArrayBuffer, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

worker.onmessage = (ev: MessageEvent<WorkerMessage>): void => {
  const msg = ev.data;
  switch (msg.type) {
    case 'ready':
      ready = msg;
      hud.setReady(msg);
      break;
    case 'frame':
      latestFrame = msg;
      frameDirty = true;
      hud.update(msg);
      if (ready) resolveReady();
      if (msg.replyTo !== undefined) {
        const resolve = pendingReplies.get(msg.replyTo);
        if (resolve) {
          pendingReplies.delete(msg.replyTo);
          resolve(msg.snapshot);
        }
      }
      break;
    case 'export': {
      const mime =
        msg.format === 'csv' ? 'text/csv' : msg.format === 'bin' ? 'application/octet-stream' : 'application/json';
      download(msg.filename, msg.data, mime);
      break;
    }
    case 'error':
      hud.showError(msg.message);
      break;
  }
};

worker.onerror = (ev): void => {
  hud.showError(`Worker error: ${ev.message}`);
};

function renderLoop(): void {
  // The globe caches its static layer, so a full redraw per animation frame is cheap and
  // also picks up drag-rotation without extra plumbing.
  if (latestFrame) {
    frameDirty = false;
    globe.render(latestFrame.snapshot, {
      showTruth: hud.state.showTruth,
      selectedTrackId: hud.state.selectedTrackId,
      labelFilter: hud.state.labelFilter,
    });
    scope.render(latestFrame.series, latestFrame.snapshot.sensors);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (latestFrame?.playing) send({ type: 'pause' });
    else send({ type: 'play' });
  }
});

function request(build: (requestId: number) => HostMessage): Promise<Snapshot> {
  const requestId = ++requestCounter;
  return new Promise<Snapshot>((resolve) => {
    pendingReplies.set(requestId, resolve);
    send(build(requestId));
  });
}

const testApi: TracksimTestApi = {
  ready: readyPromise,
  pause: () => send({ type: 'pause' }),
  play: () => send({ type: 'play' }),
  setSpeed: (value) => send({ type: 'speed', value }),
  step: (ticks) => request((requestId) => ({ type: 'step', ticks, requestId })),
  seek: (tick) => request((requestId) => ({ type: 'seek', tick, requestId })),
  snapshot: () => latestFrame?.snapshot ?? null,
  send: (command) => send({ type: 'command', command }),
};
window.__tracksim = testApi;

send({ type: 'init', scenarioId: initialScenario, seed: initialSeed });
