/**
 * Platform panel: truth vs estimate (E/N/speed/heading), the errors the sim
 * can compute because it knows truth, and the filter-integrity readouts the
 * filter itself believes (position/velocity sigma, trace P).
 */
import type { FrameMessage } from '../contracts';
import { h, textEl, classCell, type TextCell, type FlagCell } from './dom';
import { degrees, fixed, metres, signedDegrees, speed } from './format';

/** Position sigma above which the integrity readout shows DEGRADED. */
export const INTEGRITY_DEGRADED_SIGMA_M = 50;
/** Position error above which the integrity readout shows DIVERGED (same threshold as tools/run-scenario). */
export const INTEGRITY_DIVERGED_ERROR_M = 200;

export interface PlatformPanel {
  update(frame: FrameMessage): void;
}

interface Stat {
  el: HTMLElement;
  value: TextCell;
}

function stat(label: string, testId: string): Stat {
  const value = textEl('dd', { class: 'num', 'data-testid': testId }, '--');
  return { el: h('div', { class: 'stat' }, [h('dt', {}, [label]), value.el]), value };
}

/** trace of a 4×4 row-major covariance; NaN when the array is not 4×4. */
export function traceOfCov(cov: ArrayLike<number>): number {
  if (cov.length !== 16) return NaN;
  return (cov[0] as number) + (cov[5] as number) + (cov[10] as number) + (cov[15] as number);
}

/**
 * Build the platform readouts into `root`. The integrity block (pos σ, vel σ,
 * trace P, status) goes into `integrityRoot`, which defaults to `root`.
 */
export function createPlatformPanel(root: HTMLElement, integrityRoot: HTMLElement = root): PlatformPanel {
  const cell = (testId: string): TextCell => textEl('td', { class: 'num', 'data-testid': testId }, '--');
  const truthE = cell('truth-e');
  const estE = cell('est-e');
  const truthN = cell('truth-n');
  const estN = cell('est-n');
  const truthSpeed = cell('truth-speed');
  const estSpeed = cell('est-speed');
  const truthHeading = cell('truth-heading');
  const estHeading = cell('est-heading');

  const row = (label: string, truth: TextCell, est: TextCell): HTMLElement =>
    h('tr', {}, [h('th', { scope: 'row' }, [label]), truth.el, est.el]);

  const table = h('table', { class: 'kv' }, [
    h('thead', {}, [h('tr', {}, [h('th', {}, ['']), h('th', {}, ['truth']), h('th', {}, ['estimate'])])]),
    h('tbody', {}, [
      row('E', truthE, estE),
      row('N', truthN, estN),
      row('speed', truthSpeed, estSpeed),
      row('heading', truthHeading, estHeading),
    ]),
  ]);

  const posError = stat('pos error', 'pos-error');
  const velError = stat('vel error', 'vel-error');
  const headingError = stat('hdg error', 'heading-error');
  const alt = stat('alt', 'platform-alt');
  const posSigma = stat('pos σ', 'pos-sigma');
  const velSigma = stat('vel σ', 'vel-sigma');
  const traceP = stat('trace P', 'trace-p');
  const status = textEl('span', { class: 'badge badge--ok', 'data-testid': 'filter-status' }, 'NOMINAL');
  const degraded: FlagCell = classCell(status.el, 'badge--warn');
  const diverged: FlagCell = classCell(status.el, 'badge--alert');
  const ok: FlagCell = classCell(status.el, 'badge--ok', true);

  root.append(table, h('dl', { class: 'stats stats--2' }, [posError.el, velError.el, headingError.el, alt.el]));
  integrityRoot.append(
    h('dl', { class: 'stats stats--2' }, [posSigma.el, velSigma.el, traceP.el]),
    h('div', { class: 'integrity-status' }, [h('span', { class: 'k' }, ['filter']), status.el]),
  );

  return {
    update(frame: FrameMessage): void {
      const { truth, nav } = frame.snapshot;
      truthE.set(metres(truth.pos[0], 1));
      estE.set(metres(nav.pos[0], 1));
      truthN.set(metres(truth.pos[1], 1));
      estN.set(metres(nav.pos[1], 1));
      truthSpeed.set(speed(truth.speed, 1));
      estSpeed.set(speed(nav.speed, 1));
      truthHeading.set(degrees(truth.heading, 1));
      estHeading.set(degrees(nav.heading, 1));
      posError.value.set(metres(nav.posError, 1));
      velError.value.set(speed(nav.velError, 2));
      headingError.value.set(signedDegrees(nav.headingError, 2));
      alt.value.set(metres(truth.alt, 0));
      posSigma.value.set(metres(nav.posSigma, 1));
      velSigma.value.set(speed(nav.velSigma, 2));
      traceP.value.set(fixed(traceOfCov(nav.cov), 1));

      const isDiverged = nav.posError > INTEGRITY_DIVERGED_ERROR_M;
      const isDegraded = !isDiverged && nav.posSigma > INTEGRITY_DEGRADED_SIGMA_M;
      status.set(isDiverged ? 'DIVERGED' : isDegraded ? 'DEGRADED' : 'NOMINAL');
      diverged.set(isDiverged);
      degraded.set(isDegraded);
      ok.set(!isDiverged && !isDegraded);
    },
  };
}
