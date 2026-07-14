import { describe, expect, it } from 'vitest';

import {
  inferenceIntervalMs,
  shouldSubmitInferenceFrame,
  type InferenceTargetFps,
} from './inference-scheduler';

describe('inference cadence', () => {
  it.each([
    [15, 1_000 / 15],
    [20, 50],
    [24, 1_000 / 24],
    [30, 1_000 / 30],
  ] as const)('maps %i FPS to the configured interval', (fps, interval) => {
    expect(inferenceIntervalMs(fps)).toBeCloseTo(interval, 8);
  });

  it.each([15, 20, 24, 30] as const)(
    'never submits a second frame before the %i FPS interval',
    (fps: InferenceTargetFps) => {
      const interval = inferenceIntervalMs(fps);
      expect(shouldSubmitInferenceFrame(interval - 0.001, 0, fps)).toBe(false);
      expect(shouldSubmitInferenceFrame(interval, 0, fps)).toBe(true);
    },
  );
});
