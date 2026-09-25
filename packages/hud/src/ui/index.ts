/**
 * HUD view: binds the panel modules to the static layout in index.html and
 * exposes one `HudView` (see ../contracts.ts). `update(frame)` fans the frame
 * out to every panel; each panel caches its elements and writes only what
 * changed, so a frame costs a few hundred string compares and no node churn.
 */
import type { HudHandlers, HudView, HudViewState, FrameMessage, ReadyMessage } from '../contracts';
import { createTopBar } from './top-bar';
import { createPlatformPanel } from './platform-panel';
import { createSensorPanel } from './sensor-panel';
import { createTrackerPanel } from './tracker-panel';
import { createTrackList } from './track-list';
import { createTelemetryDock } from './telemetry-dock';

/** Element ids `createHud` expects to find in index.html. */
export const HUD_CONTAINER_IDS = {
  topBar: 'top-bar',
  platform: 'platform-panel',
  integrity: 'integrity-panel',
  sensors: 'sensor-panel',
  tracker: 'tracker-panel',
  tracks: 'track-panel',
  dock: 'dock',
  globe: 'globe',
  scope: 'scope',
  error: 'error-banner',
} as const;

/**
 * Create the HUD over the static layout under `root` (defaults to `document`).
 * Throws with the missing id when index.html does not provide a container.
 */
export function createHud(handlers: HudHandlers, root: ParentNode = document): HudView {
  const find = (id: string): HTMLElement => {
    const el = root.querySelector(`#${id}`);
    if (!el) throw new Error(`createHud: index.html has no element with id="${id}"`);
    return el as HTMLElement;
  };

  const state: HudViewState = { showTruth: false, selectedTrackId: null, labelFilter: 'all' };

  const globeCanvas = find(HUD_CONTAINER_IDS.globe) as HTMLCanvasElement;
  const scopeCanvas = find(HUD_CONTAINER_IDS.scope) as HTMLCanvasElement;
  const errorBanner = find(HUD_CONTAINER_IDS.error);
  errorBanner.addEventListener('click', () => {
    errorBanner.hidden = true;
  });

  const topBar = createTopBar(find(HUD_CONTAINER_IDS.topBar), handlers);
  const platform = createPlatformPanel(find(HUD_CONTAINER_IDS.platform), find(HUD_CONTAINER_IDS.integrity));
  const sensors = createSensorPanel(find(HUD_CONTAINER_IDS.sensors), handlers);
  const tracker = createTrackerPanel(find(HUD_CONTAINER_IDS.tracker), handlers, state);
  const tracks = createTrackList(find(HUD_CONTAINER_IDS.tracks), handlers, state);
  const dock = createTelemetryDock(find(HUD_CONTAINER_IDS.dock), handlers);

  return {
    globeCanvas,
    scopeCanvas,
    state,
    setReady(ready: ReadyMessage): void {
      topBar.setReady(ready);
      dock.reset();
      errorBanner.hidden = true;
    },
    update(frame: FrameMessage): void {
      topBar.update(frame);
      platform.update(frame);
      sensors.update(frame);
      tracker.update(frame);
      tracks.update(frame);
      dock.update(frame);
    },
    showError(message: string): void {
      errorBanner.textContent = message;
      errorBanner.hidden = message === '';
    },
  };
}

export { createTopBar, SPEEDS } from './top-bar';
export type { TopBar } from './top-bar';
export { createPlatformPanel, traceOfCov, INTEGRITY_DEGRADED_SIGMA_M, INTEGRITY_DIVERGED_ERROR_M } from './platform-panel';
export type { PlatformPanel } from './platform-panel';
export { createSensorPanel, SENSOR_ORDER, hasDisturbance } from './sensor-panel';
export type { SensorPanel } from './sensor-panel';
export { createTrackerPanel, DISTURBANCES, GATES, NOMINAL_CLUTTER_RATE, countConfirmed, countTotal } from './tracker-panel';
export type { TrackerPanel, DisturbanceButton } from './tracker-panel';
export { createTrackList, FILTERS, LABELS, LABEL_TAGS } from './track-list';
export type { TrackList, LabelFilter } from './track-list';
export { createTelemetryDock, EXPORTS, TERMINAL_ROWS, EVENT_LOG_LIMIT } from './telemetry-dock';
export type { TelemetryDock } from './telemetry-dock';
export * as format from './format';
export { h, button, textCell, textEl, pressedCell, hiddenCell, classCell, attrCell, barCell } from './dom';
export type { TextCell, FlagCell, AttrCell, BarCell, Child } from './dom';
