import { describe, expect, it } from 'vitest';
import { SENSOR_IDS } from '../core/types';
import { TICK_HZ } from '../core/constants';
import { chi2Critical } from '../math/chi2';
import {
  NAV_BIAS_WALK_MARGIN,
  NAV_EMA_ALPHA,
  NAV_GATE_CHI2,
  NAV_INIT_P_DIAG,
  NAV_INIT_STATE_SIGMA,
  NAV_SIGMA_ACCEL,
  NAV_STATE_DIM,
  SENSOR_CONFIGS,
  SENSOR_CONFIG_LIST,
  isSensorDue,
  isolationThreshold,
  sensorPeriodTicks,
} from './sensors';

describe('sensor table', () => {
  it('lists the five contract sensors with their names, rates and nominal sigmas', () => {
    expect(SENSOR_CONFIG_LIST.map((c) => c.id)).toEqual([...SENSOR_IDS]);
    expect(SENSOR_CONFIGS.INS).toMatchObject({ name: 'Inertial (speed/heading)', rateHz: 100, kind: 'ins', sigma: [0.5, 0.003] });
    expect(SENSOR_CONFIGS.STAR).toMatchObject({ name: 'Star tracker (position fix)', rateHz: 20, kind: 'position', sigma: [12, 12] });
    expect(SENSOR_CONFIGS.MAGGRAV).toMatchObject({
      name: 'Magnetic/gravity map match',
      rateHz: 50,
      kind: 'position',
      sigma: [60, 60],
    });
    expect(SENSOR_CONFIGS.TERRAIN).toMatchObject({ name: 'Terrain-contour radar fix', rateHz: 10, kind: 'position', sigma: [8, 8] });
    expect(SENSOR_CONFIGS.SWARM).toMatchObject({ name: 'Swarm-relative mesh fix', rateHz: 100, kind: 'position', sigma: [35, 35] });
  });

  it('gives only the INS a bias random walk, at the contract rates', () => {
    expect(SENSOR_CONFIGS.INS.biasWalkSigma).toEqual([0.02, 0.0002]);
    for (const id of SENSOR_IDS) {
      if (id === 'INS') continue;
      expect(SENSOR_CONFIGS[id].biasWalkSigma).toEqual([0, 0]);
    }
  });

  it('has integer tick periods that divide the tick rate', () => {
    for (const cfg of SENSOR_CONFIG_LIST) {
      const period = sensorPeriodTicks(cfg);
      expect(Number.isInteger(period)).toBe(true);
      expect(period * cfg.rateHz).toBe(TICK_HZ);
    }
    expect(sensorPeriodTicks(SENSOR_CONFIGS.INS)).toBe(1);
    expect(sensorPeriodTicks(SENSOR_CONFIGS.STAR)).toBe(5);
    expect(sensorPeriodTicks(SENSOR_CONFIGS.MAGGRAV)).toBe(2);
    expect(sensorPeriodTicks(SENSOR_CONFIGS.TERRAIN)).toBe(10);
    expect(sensorPeriodTicks(SENSOR_CONFIGS.SWARM)).toBe(1);
  });

  it('is due when tick % (TICK_HZ / rateHz) === 0', () => {
    expect(isSensorDue(SENSOR_CONFIGS.TERRAIN, 0)).toBe(true);
    expect(isSensorDue(SENSOR_CONFIGS.TERRAIN, 10)).toBe(true);
    expect(isSensorDue(SENSOR_CONFIGS.TERRAIN, 15)).toBe(false);
    expect(isSensorDue(SENSOR_CONFIGS.STAR, 25)).toBe(true);
    expect(isSensorDue(SENSOR_CONFIGS.STAR, 26)).toBe(false);
    // Over one second every sensor is due exactly rateHz times.
    for (const cfg of SENSOR_CONFIG_LIST) {
      let due = 0;
      for (let tick = 1; tick <= TICK_HZ; tick++) if (isSensorDue(cfg, tick)) due++;
      expect(due).toBe(cfg.rateHz);
    }
  });

  it('isolates after half a second of consecutive rejections', () => {
    expect(isolationThreshold(SENSOR_CONFIGS.INS)).toBe(50);
    expect(isolationThreshold(SENSOR_CONFIGS.STAR)).toBe(10);
    expect(isolationThreshold(SENSOR_CONFIGS.MAGGRAV)).toBe(25);
    expect(isolationThreshold(SENSOR_CONFIGS.TERRAIN)).toBe(5);
    expect(isolationThreshold(SENSOR_CONFIGS.SWARM)).toBe(50);
  });

  it('fixes the filter constants from the contract', () => {
    expect(NAV_GATE_CHI2).toBe(chi2Critical(2, 0.99));
    expect(NAV_GATE_CHI2).toBe(9.21);
    expect(NAV_EMA_ALPHA).toBe(0.05);
    expect(NAV_INIT_STATE_SIGMA).toEqual([20, 20, 2, 2]);
    expect(NAV_INIT_P_DIAG).toEqual([10000, 10000, 100, 100]);
    expect(NAV_STATE_DIM).toBe(6);
    // Process-noise tuning: must cover the scripted 3°/s turn at 250 m/s (13 m/s² centripetal)
    // without exceeding what keeps the INS NIS nominal (see navigation-filter.test.ts).
    expect(NAV_SIGMA_ACCEL).toBeGreaterThanOrEqual(13);
    expect(NAV_SIGMA_ACCEL).toBeLessThanOrEqual(20);
    expect(NAV_BIAS_WALK_MARGIN).toBeGreaterThanOrEqual(1);
  });
});
