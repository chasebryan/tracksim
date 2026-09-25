/**
 * HUD-side contracts: the worker protocol and the interfaces the renderer,
 * UI panels and the main wiring agree on. Keep this file free of DOM code.
 */
import type { Command, Recording, SensorStatus, Snapshot } from '@tracksim/sim';

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

export type ExportFormat = 'jsonl' | 'csv' | 'bin' | 'recording';

export type HostMessage =
  | { type: 'init'; scenarioId: string; seed: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; value: number }
  | { type: 'seek'; tick: number; requestId?: number }
  | { type: 'step'; ticks: number; requestId?: number }
  | { type: 'command'; command: Command }
  | { type: 'export'; format: ExportFormat }
  | { type: 'loadRecording'; recording: Recording };

export interface ScenarioSummary {
  id: string;
  name: string;
  durationS: number;
  description: string;
}

export interface ReadyMessage {
  type: 'ready';
  scenarios: ScenarioSummary[];
  scenarioId: string;
  seed: number;
}

export interface FrameMessage {
  type: 'frame';
  snapshot: Snapshot;
  /** Last 24 telemetry records, formatted as fixed-width text lines, oldest first. */
  terminal: string[];
  /** Last 300 samples (oldest first) of posError, posSigma, traceP and `<ID>_nis` per sensor. */
  series: Record<string, Float32Array>;
  playing: boolean;
  speed: number;
  /** Ticks in the current scenario (durationS * TICK_HZ). */
  endTick: number;
  /** Echoes the requestId of the seek/step that produced this frame, if any. */
  replyTo?: number;
}

export interface ExportMessage {
  type: 'export';
  format: ExportFormat;
  /** Text for jsonl/csv/recording; ArrayBuffer for bin. */
  data: string | ArrayBuffer;
  filename: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerMessage = ReadyMessage | FrameMessage | ExportMessage | ErrorMessage;

// ---------------------------------------------------------------------------
// Renderers (packages/hud/src/render)
// ---------------------------------------------------------------------------

export interface GlobeRenderOptions {
  showTruth: boolean;
  selectedTrackId: number | null;
  /** Label filter applied to the track list; the globe dims tracks outside it. */
  labelFilter: 'all' | 'friendly' | 'unknown' | 'hostile' | 'decoy';
}

export interface IGlobeRenderer {
  /** Re-read the parent size and DPR; rebuild the static layer. */
  resize(): void;
  render(snapshot: Snapshot, opts: GlobeRenderOptions): void;
  /** Hit test in canvas CSS pixels; returns the nearest track id within 14 px, else null. */
  hitTest(x: number, y: number, snapshot: Snapshot): number | null;
}

export interface IScopeRenderer {
  resize(): void;
  render(series: Record<string, Float32Array>, sensors: SensorStatus[]): void;
}

// ---------------------------------------------------------------------------
// UI (packages/hud/src/ui)
// ---------------------------------------------------------------------------

export interface HudHandlers {
  play(): void;
  pause(): void;
  setSpeed(value: number): void;
  seek(tick: number): void;
  selectScenario(id: string, seed: number): void;
  command(command: Command): void;
  exportAs(format: ExportFormat): void;
  loadRecording(file: File): void;
  /** Track card clicked: select it (renderer highlights), second click on the same card deselects. */
  selectTrack(trackId: number | null): void;
}

export interface HudViewState {
  showTruth: boolean;
  selectedTrackId: number | null;
  labelFilter: GlobeRenderOptions['labelFilter'];
}

export interface HudView {
  readonly globeCanvas: HTMLCanvasElement;
  readonly scopeCanvas: HTMLCanvasElement;
  /** Current view-only state owned by the UI (toggles, selection, filter). */
  readonly state: HudViewState;
  setReady(ready: ReadyMessage): void;
  update(frame: FrameMessage): void;
  showError(message: string): void;
}

/** Test/automation hook installed on window by main.ts. */
export interface TracksimTestApi {
  ready: Promise<void>;
  pause(): void;
  play(): void;
  step(ticks: number): Promise<Snapshot>;
  seek(tick: number): Promise<Snapshot>;
  snapshot(): Snapshot | null;
  send(command: Command): void;
}

declare global {
  interface Window {
    __tracksim?: TracksimTestApi;
  }
}
