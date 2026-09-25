/**
 * Chi-square critical values used for innovation gating (NIS tests).
 * Indexed by degrees of freedom (1..6) and confidence level.
 */
export type Chi2Level = 0.9 | 0.95 | 0.99 | 0.999;

const TABLE: Record<number, Record<Chi2Level, number>> = {
  1: { 0.9: 2.706, 0.95: 3.841, 0.99: 6.635, 0.999: 10.828 },
  2: { 0.9: 4.605, 0.95: 5.991, 0.99: 9.21, 0.999: 13.816 },
  3: { 0.9: 6.251, 0.95: 7.815, 0.99: 11.345, 0.999: 16.266 },
  4: { 0.9: 7.779, 0.95: 9.488, 0.99: 13.277, 0.999: 18.467 },
  5: { 0.9: 9.236, 0.95: 11.07, 0.99: 15.086, 0.999: 20.515 },
  6: { 0.9: 10.645, 0.95: 12.592, 0.99: 16.812, 0.999: 22.458 },
};

export function chi2Critical(dof: number, level: Chi2Level): number {
  const row = TABLE[dof];
  if (!row) throw new Error(`chi2Critical: unsupported dof ${dof}`);
  return row[level];
}
