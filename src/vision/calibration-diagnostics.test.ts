import { describe, expect, it } from 'vitest';
import {
  assessCalibrationHealth,
  summarizeCalibrationPerformance,
  type CalibrationHealthInput,
  type CalibrationPerformanceSnapshot,
} from './calibration-diagnostics';

const GOOD_PERFORMANCE: CalibrationPerformanceSnapshot = {
  fps: 30,
  inferenceP95Ms: 30,
  pipelineP95Ms: 70,
  sampleCount: 30,
  ready: true,
  backend: 'gpu',
};

const HEALTHY_INPUT: CalibrationHealthInput = {
  expectedPlayers: 2,
  rawPoseCount: 2,
  acceptedCandidateCount: 2,
  assignedPlayerCount: 2,
  lockedPlayerCount: 2,
  recognizedHandCount: 2,
  calibrationStalled: false,
  performance: GOOD_PERFORMANCE,
};

describe('calibration diagnostics', () => {
  it('measures FPS from frame intervals without a startup false alarm', () => {
    const snapshot = summarizeCalibrationPerformance({
      inferenceSamples: Array.from({ length: 12 }, () => 28),
      pipelineSamples: Array.from({ length: 12 }, () => 62),
      inferenceTimestamps: Array.from({ length: 12 }, (_, index) => 1_000 + index * (1_000 / 30)),
      nowMs: 1_400,
      backend: 'gpu',
    });
    expect(snapshot.ready).toBe(true);
    expect(snapshot.fps).toBeCloseTo(30, 1);
    expect(snapshot.inferenceP95Ms).toBe(28);
    expect(snapshot.pipelineP95Ms).toBe(62);
  });

  it('reports severe low throughput instead of measuring forever', () => {
    const snapshot = summarizeCalibrationPerformance({
      inferenceSamples: [120, 120, 120],
      pipelineSamples: [500, 500, 500],
      inferenceTimestamps: [1_000, 1_500, 2_000],
      nowMs: 2_100,
      backend: 'cpu',
    });
    expect(snapshot.ready).toBe(true);
    expect(snapshot.fps).toBeCloseTo(2, 1);
    expect(assessCalibrationHealth({
      ...HEALTHY_INPUT,
      performance: snapshot,
    }).code).toBe('performance-insufficient');
  });

  it.each([
    [{ performance: { ...GOOD_PERFORMANCE, ready: false } }, 'measuring'],
    [{ performance: { ...GOOD_PERFORMANCE, fps: 14 } }, 'performance-insufficient'],
    [{ rawPoseCount: 1, acceptedCandidateCount: 1, assignedPlayerCount: 1, lockedPlayerCount: 1, recognizedHandCount: 1 }, 'only-one-person'],
    [{ assignedPlayerCount: 1, lockedPlayerCount: 1, recognizedHandCount: 1 }, 'pairing-not-locked'],
    [{ recognizedHandCount: 1 }, 'dominant-hand-missing'],
    [{ calibrationStalled: true }, 'calibration-threshold'],
    [{}, 'ready'],
  ] as const)('classifies %# as %s', (overrides, expectedCode) => {
    const result = assessCalibrationHealth({ ...HEALTHY_INPUT, ...overrides });
    expect(result.code).toBe(expectedCode);
    expect(result.instruction.length).toBeGreaterThan(8);
  });
});
