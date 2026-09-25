/**
 * Association gate and track-management thresholds per gate setting
 * (CONTRACTS.md "tracking/"). The chi-square values are the 2-dof critical
 * values from math/chi2 so the table cannot drift from the shared table.
 */
import type { GateSetting } from '../core/types';
import { chi2Critical } from '../math/chi2';

export interface GateParams {
  /** Chi-square gate on the Mahalanobis distance d² = yᵀ S⁻¹ y (2 dof). */
  gateChi2: number;
  /** A tentative track is confirmed once it has `m` hits within its last `n` scans. */
  m: number;
  n: number;
  /** Consecutive misses that drop a confirmed track. */
  kConfirmed: number;
  /** Consecutive misses that drop a tentative track. */
  kTentative: number;
}

/** Gate settings in display order. */
export const GATE_SETTINGS: readonly GateSetting[] = ['loose', 'normal', 'strict'];

export const GATE_TABLE: Readonly<Record<GateSetting, Readonly<GateParams>>> = {
  loose: { gateChi2: chi2Critical(2, 0.999), m: 2, n: 4, kConfirmed: 8, kTentative: 3 },
  normal: { gateChi2: chi2Critical(2, 0.99), m: 3, n: 5, kConfirmed: 5, kTentative: 2 },
  strict: { gateChi2: chi2Critical(2, 0.95), m: 4, n: 6, kConfirmed: 3, kTentative: 2 },
};
