/** Simulation runs at a fixed step. All domain logic uses sim ticks, never wall-clock. */
export const TICK_HZ = 100;
export const DT = 1 / TICK_HZ;

/** Convert seconds to the tick index on which that instant is reached. */
export const secondsToTick = (s: number): number => Math.round(s * TICK_HZ);
export const tickToSeconds = (tick: number): number => tick * DT;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  else if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}
