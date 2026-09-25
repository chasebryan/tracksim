// Core contracts and foundation
export * from './core/types';
export * from './core/constants';
export * from './core/interfaces';
export { Rng } from './core/rng';

// Math
export { Mat } from './math/mat';
export { KalmanFilter, constantVelocity2D, H_POSITION_2D, H_VELOCITY_2D } from './math/kalman';
export type { KalmanUpdateResult, KalmanUpdateOptions } from './math/kalman';
export { chi2Critical } from './math/chi2';
export type { Chi2Level } from './math/chi2';

// Modules (each directory owns its own index.ts)
export * from './world/index';
export * from './nav/index';
export * from './tracking/index';
export * from './scenario/index';
export * from './telemetry/index';
export * from './core/simulation';
