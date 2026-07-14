import { describe, expect, it } from 'vitest';
import {
  AdaptiveVisionLoadController,
  type VisionAdaptationSample,
} from './vision-adaptation';

function feed(
  controller: AdaptiveVisionLoadController,
  count: number,
  sample: VisionAdaptationSample,
): void {
  for (let index = 0; index < count; index += 1) controller.observe(sample);
}

describe('AdaptiveVisionLoadController', () => {
  it('starts GPU on the full model with three candidates and CPU on Lite with two', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    expect(controller.profile).toMatchObject({
      mode: 'gpu-quality',
      modelTier: 'full',
      maxPoses: 3,
      maxDimension: 768,
    });
    expect(controller.setBackend('cpu')).toMatchObject({
      mode: 'cpu-balanced',
      modelTier: 'lite',
      maxPoses: 2,
      maxDimension: 640,
    });
  });

  it('classifies slow two-player inference as performance rather than recognition failure', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    let result = controller.observe({ inferenceMs: 100, pipelineMs: 150, poseCount: 1 });
    for (let index = 1; index < 12; index += 1) {
      result = controller.observe({ inferenceMs: 100, pipelineMs: 150, poseCount: 1 });
    }
    expect(result.diagnosis).toBe('performance-limited');
    expect(result.profileChanged).toBe(true);
    expect(result.profile).toMatchObject({ mode: 'gpu-balanced', maxPoses: 2, maxDimension: 640 });
  });

  it('raises input detail only when latency is healthy but the second expected pose stays missing', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    let result = controller.observe({ inferenceMs: 30, pipelineMs: 55, poseCount: 1 });
    for (let index = 1; index < 24; index += 1) {
      result = controller.observe({ inferenceMs: 30, pipelineMs: 55, poseCount: 1 });
    }
    expect(result.diagnosis).toBe('recognition-limited');
    expect(result.profileChanged).toBe(true);
    expect(result.profile).toMatchObject({
      mode: 'gpu-recognition-rescue',
      maxPoses: 3,
      maxDimension: 960,
      resizeQuality: 'high',
    });
  });

  it('escapes a prior performance downshift when healthy latency still misses player two', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    feed(controller, 12, { inferenceMs: 100, pipelineMs: 150, poseCount: 1 });
    expect(controller.profile.mode).toBe('gpu-balanced');

    // Respect the configuration cooldown, then restore quality/candidate
    // capacity instead of getting trapped forever in recognition-limited.
    feed(controller, 48, { inferenceMs: 30, pipelineMs: 55, poseCount: 1 });
    expect(controller.profile.mode).toBe('gpu-quality');
    feed(controller, 48, { inferenceMs: 30, pipelineMs: 55, poseCount: 1 });
    expect(controller.profile.mode).toBe('gpu-recognition-rescue');
  });

  it('does not carry a GPU configuration cooldown into CPU recovery', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    feed(controller, 12, { inferenceMs: 100, pipelineMs: 150, poseCount: 1 });
    expect(controller.profile.mode).toBe('gpu-balanced');

    controller.setBackend('cpu');
    feed(controller, 12, { inferenceMs: 100, pipelineMs: 150, poseCount: 1 });
    expect(controller.profile.mode).toBe('cpu-emergency');
  });

  it('does not interpret a single-player session as a missing second player', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(1);
    let result = controller.observe({ inferenceMs: 30, pipelineMs: 55, poseCount: 1 });
    for (let index = 1; index < 24; index += 1) {
      result = controller.observe({ inferenceMs: 30, pipelineMs: 55, poseCount: 1 });
    }
    expect(result.diagnosis).toBe('healthy');
    expect(result.profileChanged).toBe(false);
    expect(result.profile.mode).toBe('gpu-quality');
  });

  it('keeps at least two pose candidates even under sustained CPU pressure', () => {
    const controller = new AdaptiveVisionLoadController('cpu');
    controller.setExpectedPoseCount(2);
    feed(controller, 12, { inferenceMs: 110, pipelineMs: 160, poseCount: 2 });
    expect(controller.profile).toMatchObject({
      mode: 'cpu-emergency',
      maxPoses: 2,
      maxDimension: 512,
    });
  });

  it('downshifts when delivered result rate is below 20 FPS despite moderate stage latency', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    feed(controller, 12, {
      inferenceMs: 40,
      pipelineMs: 90,
      poseCount: 2,
      resultIntervalMs: 70,
    });
    expect(controller.profile.mode).toBe('gpu-balanced');
  });

  it('temporarily allows a third CPU Lite candidate when latency is healthy but a player is missing', () => {
    const controller = new AdaptiveVisionLoadController('cpu');
    controller.setExpectedPoseCount(2);
    feed(controller, 24, { inferenceMs: 30, pipelineMs: 55, poseCount: 1 });
    expect(controller.profile).toMatchObject({
      mode: 'cpu-recognition-rescue',
      modelTier: 'lite',
      maxPoses: 3,
      maxDimension: 768,
    });
  });

  it('rejects invalid timing samples', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    expect(() =>
      controller.observe({ inferenceMs: Number.NaN, pipelineMs: 50, poseCount: 2 }),
    ).toThrow(RangeError);
  });
});
