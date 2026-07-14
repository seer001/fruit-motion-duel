import { describe, expect, it } from 'vitest';

import {
  AUTO_PERFORMANCE_COOLDOWN_SAMPLES,
  AUTO_PERFORMANCE_QUALITY_HYSTERESIS_SAMPLES,
  AUTO_PERFORMANCE_RECOVERY_HYSTERESIS_SAMPLES,
  AUTO_PERFORMANCE_SAMPLE_WINDOW,
  AUTO_PERFORMANCE_STAGES,
  AutoPerformanceController,
  resolveEffectivePerformanceSettings,
} from './auto-performance';
import {
  getPerformancePresetSettings,
  type PerformanceHealthStatus,
  type PerformanceSettings,
} from './performance';

function feed(
  controller: AutoPerformanceController,
  status: PerformanceHealthStatus,
  count: number,
): ReturnType<AutoPerformanceController['observe']> {
  let snapshot = controller.snapshot;
  for (let index = 0; index < count; index += 1) snapshot = controller.observe(status);
  return snapshot;
}

function reachStageThree(controller: AutoPerformanceController): void {
  feed(controller, 'degraded', AUTO_PERFORMANCE_SAMPLE_WINDOW);
  feed(controller, 'degraded', AUTO_PERFORMANCE_COOLDOWN_SAMPLES);
  feed(controller, 'degraded', AUTO_PERFORMANCE_COOLDOWN_SAMPLES);
}

describe('Auto performance stage table', () => {
  it('defines Quality above the documented Balanced-to-vision reduction stages', () => {
    expect(AUTO_PERFORMANCE_STAGES).toEqual([
      {
        stage: 'quality',
        name: 'quality',
        gameRenderFps: 60,
        effectsQuality: 'high',
        poseOverlayRate: 30,
        inferenceTargetFps: 30,
        visionLoadReductionAllowed: false,
      },
      {
        stage: 0,
        name: 'balanced',
        gameRenderFps: 45,
        effectsQuality: 'medium',
        poseOverlayRate: 15,
        inferenceTargetFps: 20,
        visionLoadReductionAllowed: false,
      },
      {
        stage: 1,
        name: 'effects-reduced',
        gameRenderFps: 45,
        effectsQuality: 'low',
        poseOverlayRate: 10,
        inferenceTargetFps: 20,
        visionLoadReductionAllowed: false,
      },
      {
        stage: 2,
        name: 'render-reduced',
        gameRenderFps: 30,
        effectsQuality: 'low',
        poseOverlayRate: 10,
        inferenceTargetFps: 20,
        visionLoadReductionAllowed: false,
      },
      {
        stage: 3,
        name: 'vision-reduction-allowed',
        gameRenderFps: 30,
        effectsQuality: 'low',
        poseOverlayRate: 10,
        inferenceTargetFps: 15,
        visionLoadReductionAllowed: true,
      },
    ]);
    expect(AUTO_PERFORMANCE_RECOVERY_HYSTERESIS_SAMPLES)
      .toBeGreaterThan(AUTO_PERFORMANCE_SAMPLE_WINDOW);
    expect(AUTO_PERFORMANCE_QUALITY_HYSTERESIS_SAMPLES)
      .toBeGreaterThan(AUTO_PERFORMANCE_RECOVERY_HYSTERESIS_SAMPLES);
    expect(AUTO_PERFORMANCE_COOLDOWN_SAMPLES)
      .toBeGreaterThanOrEqual(AUTO_PERFORMANCE_SAMPLE_WINDOW);
  });
});

describe('AutoPerformanceController', () => {
  it('starts at Balanced and never reacts to a single degraded frame', () => {
    const controller = new AutoPerformanceController();
    expect(controller.snapshot).toMatchObject({
      preset: 'auto',
      autoEnabled: true,
      stage: 0,
      changed: false,
      runtime: {
        gameRenderFps: 45,
        effectsQuality: 'medium',
        poseOverlayRate: 15,
        inferenceTargetFps: 20,
        visionLoadReductionAllowed: false,
      },
    });

    expect(controller.observe('degraded')).toMatchObject({
      stage: 0,
      changed: false,
      sampleWindowCount: 1,
      pressureSampleCount: 1,
    });
  });

  it('reduces effects, renderer and vision load in order with cooldowns', () => {
    const controller = new AutoPerformanceController('auto');

    expect(feed(controller, 'degraded', AUTO_PERFORMANCE_SAMPLE_WINDOW - 1).stage).toBe(0);
    expect(controller.observe('degraded')).toMatchObject({
      stage: 1,
      changed: true,
      cooldownRemaining: AUTO_PERFORMANCE_COOLDOWN_SAMPLES,
      runtime: { effectsQuality: 'low', poseOverlayRate: 10, gameRenderFps: 45 },
    });

    expect(feed(controller, 'degraded', AUTO_PERFORMANCE_COOLDOWN_SAMPLES - 1).stage).toBe(1);
    expect(controller.observe('degraded')).toMatchObject({
      stage: 2,
      changed: true,
      runtime: { gameRenderFps: 30, inferenceTargetFps: 20 },
    });

    expect(feed(controller, 'insufficient', AUTO_PERFORMANCE_COOLDOWN_SAMPLES - 1).stage).toBe(2);
    expect(controller.observe('insufficient')).toMatchObject({
      stage: 3,
      changed: true,
      runtime: {
        gameRenderFps: 30,
        inferenceTargetFps: 15,
        visionLoadReductionAllowed: true,
      },
    });
  });

  it('requires longer good hysteresis and recovers one stage at a time through Quality', () => {
    const controller = new AutoPerformanceController();
    reachStageThree(controller);
    expect(controller.snapshot.stage).toBe(3);

    for (const expectedStage of [2, 1, 0] as const) {
      expect(feed(
        controller,
        'good',
        AUTO_PERFORMANCE_RECOVERY_HYSTERESIS_SAMPLES - 1,
      ).stage).not.toBe(expectedStage);
      expect(controller.observe('good')).toMatchObject({
        stage: expectedStage,
        changed: true,
      });
    }

    expect(feed(
      controller,
      'good',
      AUTO_PERFORMANCE_QUALITY_HYSTERESIS_SAMPLES - 1,
    ).stage).toBe(0);
    expect(controller.observe('good')).toMatchObject({
      stage: 'quality',
      changed: true,
      runtime: {
        gameRenderFps: 60,
        effectsQuality: 'high',
        poseOverlayRate: 30,
        inferenceTargetFps: 30,
        visionLoadReductionAllowed: false,
      },
    });

    expect(feed(controller, 'degraded', AUTO_PERFORMANCE_COOLDOWN_SAMPLES)).toMatchObject({
      stage: 0,
      changed: true,
    });
  });

  it('resets evidence on mixed health instead of treating it as sustained pressure', () => {
    const controller = new AutoPerformanceController();
    feed(controller, 'degraded', AUTO_PERFORMANCE_SAMPLE_WINDOW - 1);
    controller.observe('good');
    expect(feed(controller, 'degraded', AUTO_PERFORMANCE_SAMPLE_WINDOW - 1)).toMatchObject({
      stage: 0,
      changed: false,
    });
    expect(controller.observe('degraded').stage).toBe(1);
  });

  it.each(['performance', 'balanced', 'quality'] as const)(
    'never auto-adjusts the fixed %s preset',
    (preset) => {
      const settings = getPerformancePresetSettings(preset);
      const controller = new AutoPerformanceController(settings);
      const expectedRuntime = {
        gameRenderFps: settings.gameRenderFps,
        effectsQuality: settings.effectsQuality,
        poseOverlayRate: settings.poseOverlayRate,
        inferenceTargetFps: settings.inferenceTargetFps,
        visionLoadReductionAllowed: false,
      };

      expect(feed(
        controller,
        'insufficient',
        AUTO_PERFORMANCE_COOLDOWN_SAMPLES * 4,
      )).toMatchObject({
        preset,
        autoEnabled: false,
        stage: null,
        changed: false,
        runtime: expectedRuntime,
        sampleWindowCount: 0,
        goodStreak: 0,
      });
      expect(feed(
        controller,
        'good',
        AUTO_PERFORMANCE_QUALITY_HYSTERESIS_SAMPLES * 2,
      )).toMatchObject({ stage: null, changed: false, runtime: expectedRuntime });
    },
  );

  it('keeps full Custom settings fixed and supports setPreset/reset lifecycle', () => {
    const custom: PerformanceSettings = {
      ...getPerformancePresetSettings('balanced'),
      preset: 'custom',
      gameRenderFps: 60,
      effectsQuality: 'off',
      poseOverlayRate: 0,
      inferenceTargetFps: 24,
    };
    const controller = new AutoPerformanceController();
    feed(controller, 'degraded', AUTO_PERFORMANCE_SAMPLE_WINDOW);
    expect(controller.snapshot.stage).toBe(1);

    expect(controller.setPreset(custom)).toMatchObject({
      preset: 'custom',
      autoEnabled: false,
      stage: null,
      changed: true,
      runtime: {
        gameRenderFps: 60,
        effectsQuality: 'off',
        poseOverlayRate: 0,
        inferenceTargetFps: 24,
        visionLoadReductionAllowed: false,
      },
    });
    expect(feed(controller, 'insufficient', AUTO_PERFORMANCE_COOLDOWN_SAMPLES * 2).stage)
      .toBeNull();

    expect(controller.setPreset('auto')).toMatchObject({
      preset: 'auto',
      stage: 0,
      sampleWindowCount: 0,
      cooldownRemaining: 0,
    });
    feed(controller, 'degraded', AUTO_PERFORMANCE_SAMPLE_WINDOW);
    expect(controller.reset()).toMatchObject({
      stage: 0,
      changed: true,
      lastStatus: null,
      sampleWindowCount: 0,
      pressureSampleCount: 0,
      goodStreak: 0,
      cooldownRemaining: 0,
    });
  });

  it('resolves ephemeral Auto stages without rewriting the saved preset', () => {
    const settings = getPerformancePresetSettings('auto');
    const controller = new AutoPerformanceController(settings);
    feed(controller, 'degraded', AUTO_PERFORMANCE_SAMPLE_WINDOW);
    const stageOne = resolveEffectivePerformanceSettings(settings, controller.snapshot);
    expect(stageOne).toMatchObject({
      preset: 'auto',
      gameRenderFps: 45,
      effectsQuality: 'low',
      poseOverlayRate: 10,
      inferenceTargetFps: 20,
      antialias: true,
      cssBlur: false,
    });

    feed(controller, 'degraded', AUTO_PERFORMANCE_COOLDOWN_SAMPLES);
    const stageTwo = resolveEffectivePerformanceSettings(settings, controller.snapshot);
    expect(stageTwo).toMatchObject({
      preset: 'auto',
      gameRenderFps: 30,
      antialias: false,
      effectsQuality: 'low',
    });
    expect(settings).toEqual(getPerformancePresetSettings('auto'));
  });
});
