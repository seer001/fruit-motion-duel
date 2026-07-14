import { describe, expect, it } from 'vitest';

import { getPerformancePresetSettings } from '../config/performance';
import {
  AdaptiveVisionLoadController,
  visionProfileForPerformanceSettings,
  type VisionAdaptationSample,
} from './vision-adaptation';

function feed(
  controller: AdaptiveVisionLoadController,
  count: number,
  sample: VisionAdaptationSample,
): ReturnType<AdaptiveVisionLoadController['observe']> {
  let result = controller.observe(sample);
  for (let index = 1; index < count; index += 1) result = controller.observe(sample);
  return result;
}

const HEALTHY_MISSING: VisionAdaptationSample = {
  inferenceMs: 30,
  pipelineMs: 55,
  poseCount: 1,
  resultIntervalMs: 50,
};

describe('AdaptiveVisionLoadController', () => {
  it('starts Auto from Balanced with two candidates on GPU and CPU', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    expect(controller.profile).toMatchObject({
      mode: 'gpu-balanced',
      modelTier: 'full',
      maxPoses: 2,
      maxDimension: 640,
    });
    expect(controller.setBackend('cpu')).toMatchObject({
      mode: 'cpu-balanced',
      modelTier: 'lite',
      maxPoses: 2,
      maxDimension: 640,
    });
  });

  it.each([
    ['performance', 'gpu', 'lite', 512, 2],
    ['balanced', 'gpu', 'full', 640, 2],
    ['quality', 'gpu', 'full', 768, 3],
    ['quality', 'cpu', 'lite', 768, 3],
  ] as const)(
    'maps %s on %s to its exact fixed profile',
    (preset, backend, modelTier, maxDimension, maxPoses) => {
      expect(visionProfileForPerformanceSettings(
        getPerformancePresetSettings(preset),
        backend,
      )).toMatchObject({ modelTier, maxDimension, maxPoses });
    },
  );

  it('uses the selected preset health policy instead of hard-coded thresholds', () => {
    const performance = new AdaptiveVisionLoadController(
      'gpu',
      getPerformancePresetSettings('performance'),
    );
    performance.setExpectedPoseCount(2);
    const relaxed = feed(performance, 12, {
      inferenceMs: 70,
      pipelineMs: 140,
      poseCount: 2,
      resultIntervalMs: 1_000 / 15,
    });
    expect(relaxed.performanceStatus).toBe('good');
    expect(relaxed.diagnosis).toBe('healthy');

    const quality = new AdaptiveVisionLoadController(
      'gpu',
      getPerformancePresetSettings('quality'),
    );
    quality.setExpectedPoseCount(2);
    const strict = feed(quality, 12, {
      inferenceMs: 70,
      pipelineMs: 140,
      poseCount: 2,
      resultIntervalMs: 1_000 / 30,
    });
    expect(strict.performanceStatus).toBe('insufficient');
    expect(strict.diagnosis).toBe('performance-limited');
  });

  it('downshifts Auto only after a sustained performance window', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    let result = feed(controller, 11, {
      inferenceMs: 100,
      pipelineMs: 170,
      poseCount: 2,
      resultIntervalMs: 80,
    });
    expect(result.diagnosis).toBe('warming-up');
    expect(result.profileChanged).toBe(false);

    result = controller.observe({
      inferenceMs: 100,
      pipelineMs: 170,
      poseCount: 2,
      resultIntervalMs: 80,
    });
    expect(result.diagnosis).toBe('performance-limited');
    expect(result.profile).toMatchObject({
      mode: 'gpu-emergency',
      maxPoses: 2,
      maxDimension: 512,
    });
  });

  it('does not reduce Vision load before the cross-layer Auto gate opens', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    controller.setAutoRuntimePolicy({
      targetFps: 20,
      visionLoadReductionAllowed: false,
    });
    const result = feed(controller, 24, {
      inferenceMs: 100,
      pipelineMs: 170,
      poseCount: 2,
      resultIntervalMs: 80,
    });
    expect(result.diagnosis).toBe('performance-limited');
    expect(result.profileChanged).toBe(false);
    expect(result.profile).toMatchObject({
      mode: 'gpu-balanced',
      maxDimension: 640,
      maxPoses: 2,
    });
  });

  it('uses the Auto runtime FPS target for shared health assessment', () => {
    const relaxed = new AdaptiveVisionLoadController('gpu');
    relaxed.setExpectedPoseCount(2);
    relaxed.setAutoRuntimePolicy({
      targetFps: 15,
      visionLoadReductionAllowed: false,
    });
    const relaxedResult = feed(relaxed, 12, {
      inferenceMs: 70,
      pipelineMs: 140,
      poseCount: 2,
      resultIntervalMs: 1_000 / 15,
    });
    expect(relaxed.targetFps).toBe(15);
    expect(relaxedResult.performanceStatus).toBe('good');

    const strict = new AdaptiveVisionLoadController('gpu');
    strict.setExpectedPoseCount(2);
    strict.setAutoRuntimePolicy({
      targetFps: 30,
      visionLoadReductionAllowed: false,
    });
    const strictResult = feed(strict, 12, {
      inferenceMs: 70,
      pipelineMs: 140,
      poseCount: 2,
      resultIntervalMs: 1_000 / 30,
    });
    expect(strict.targetFps).toBe(30);
    expect(strictResult.performanceStatus).toBe('insufficient');
  });

  it('keeps recognition rescue active while Vision load reduction is gated', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    controller.setAutoRuntimePolicy({
      targetFps: 20,
      visionLoadReductionAllowed: false,
    });
    const result = feed(controller, 24, HEALTHY_MISSING);
    expect(result.diagnosis).toBe('recognition-limited');
    expect(result.profile).toMatchObject({
      mode: 'gpu-quality',
      maxDimension: 768,
      maxPoses: 2,
    });
  });

  it('raises detail before candidates when effective player recognition is low', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    const detail = feed(controller, 24, HEALTHY_MISSING);
    expect(detail.diagnosis).toBe('recognition-limited');
    expect(detail.profile).toMatchObject({
      mode: 'gpu-quality',
      maxDimension: 768,
      maxPoses: 2,
    });

    const rescue = feed(controller, 48, HEALTHY_MISSING);
    expect(rescue.profile).toMatchObject({
      mode: 'gpu-recognition-rescue',
      maxDimension: 960,
      maxPoses: 2,
    });
  });

  it('uses three candidates only after sustained candidate pressure', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    feed(controller, 24, { ...HEALTHY_MISSING, candidatePressure: true });
    const rescue = feed(controller, 48, {
      ...HEALTHY_MISSING,
      candidatePressure: true,
    });
    expect(rescue.profile).toMatchObject({
      mode: 'gpu-recognition-rescue',
      maxDimension: 960,
      maxPoses: 3,
    });

    const pressureCleared = feed(controller, 48, HEALTHY_MISSING);
    expect(pressureCleared.profile).toMatchObject({
      mode: 'gpu-recognition-rescue',
      maxDimension: 960,
      maxPoses: 2,
    });
  });

  it('applies the same explicit candidate-pressure gate on CPU', () => {
    const withoutPressure = new AdaptiveVisionLoadController('cpu');
    withoutPressure.setExpectedPoseCount(2);
    const detailOnly = feed(withoutPressure, 24, HEALTHY_MISSING);
    expect(detailOnly.profile).toMatchObject({
      mode: 'cpu-recognition-rescue',
      maxDimension: 768,
      maxPoses: 2,
    });

    const withPressure = new AdaptiveVisionLoadController('cpu');
    withPressure.setExpectedPoseCount(2);
    const reserved = feed(withPressure, 24, {
      ...HEALTHY_MISSING,
      candidatePressure: true,
    });
    expect(reserved.profile).toMatchObject({
      mode: 'cpu-recognition-rescue',
      maxDimension: 768,
      maxPoses: 3,
    });

    const cleared = feed(withPressure, 48, HEALTHY_MISSING);
    expect(cleared.profile).toMatchObject({
      mode: 'cpu-recognition-rescue',
      maxPoses: 2,
    });
  });

  it('treats sustained calibration stall as recognition feedback', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    const result = feed(controller, 24, {
      inferenceMs: 30,
      pipelineMs: 55,
      poseCount: 2,
      resultIntervalMs: 50,
      calibrationStalled: true,
    });
    expect(result.diagnosis).toBe('recognition-limited');
    expect(result.calibrationStallRate).toBe(1);
    expect(result.profile).toMatchObject({ maxDimension: 768, maxPoses: 2 });
  });

  it('diagnoses but never mutates a fixed preset', () => {
    const controller = new AdaptiveVisionLoadController(
      'gpu',
      getPerformancePresetSettings('quality'),
    );
    controller.setExpectedPoseCount(2);
    const result = feed(controller, 24, {
      inferenceMs: 100,
      pipelineMs: 170,
      poseCount: 1,
      resultIntervalMs: 80,
      candidatePressure: true,
    });
    expect(result.diagnosis).toBe('performance-limited');
    expect(result.profileChanged).toBe(false);
    expect(result.profile).toMatchObject({ maxDimension: 768, maxPoses: 3 });
    controller.setAutoRuntimePolicy({
      targetFps: 15,
      visionLoadReductionAllowed: true,
    });
    expect(controller.targetFps).toBe(30);
  });

  it('does not interpret a single-player session as a missing second player', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(1);
    const result = feed(controller, 24, {
      ...HEALTHY_MISSING,
      poseCount: 1,
    });
    expect(result.diagnosis).toBe('healthy');
    expect(result.profileChanged).toBe(false);
    expect(result.profile.mode).toBe('gpu-balanced');
  });

  it('resets the sample window and profile when settings change', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    controller.setExpectedPoseCount(2);
    feed(controller, 12, {
      inferenceMs: 100,
      pipelineMs: 170,
      poseCount: 2,
    });
    expect(controller.profile.mode).toBe('gpu-emergency');

    expect(controller.setPerformanceSettings(
      getPerformancePresetSettings('quality'),
    )).toMatchObject({ maxDimension: 768, maxPoses: 3, modelTier: 'full' });
  });

  it('rejects invalid timing samples', () => {
    const controller = new AdaptiveVisionLoadController('gpu');
    expect(() =>
      controller.observe({ inferenceMs: Number.NaN, pipelineMs: 50, poseCount: 2 }),
    ).toThrow(RangeError);
  });
});
