import { describe, expect, it } from 'vitest';

import {
  assessPerformanceHealth,
  getPerformanceHealthPolicy,
  getPerformancePresetSettings,
  loadPerformanceSettings,
  normalizePerformanceSettings,
  PERFORMANCE_HEALTH_POLICIES,
  PERFORMANCE_PRESETS,
  PERFORMANCE_SETTINGS_STORAGE_KEY,
  restoreAutoPerformanceSettings,
  savePerformanceSettings,
  type PerformanceSettings,
  type PerformanceSettingsStorage,
} from './performance';

class MemoryStorage implements PerformanceSettingsStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function customSettings(
  overrides: Partial<Omit<PerformanceSettings, 'version' | 'preset'>> = {},
): PerformanceSettings {
  return {
    ...getPerformancePresetSettings('balanced'),
    preset: 'custom',
    ...overrides,
  };
}

describe('performance settings presets', () => {
  it('defines the documented performance, balanced and quality values', () => {
    expect(PERFORMANCE_PRESETS.performance).toMatchObject({
      modelPreference: 'lite',
      inferenceMaxDimension: 512,
      inferenceTargetFps: 15,
      maximumPoseCandidates: 2,
      gameRenderFps: 30,
      antialias: false,
      effectsQuality: 'low',
      poseOverlayRate: 10,
      cssBlur: false,
    });
    expect(PERFORMANCE_PRESETS.balanced).toMatchObject({
      modelPreference: 'auto',
      inferenceMaxDimension: 640,
      inferenceTargetFps: 20,
      maximumPoseCandidates: 2,
      gameRenderFps: 45,
      antialias: true,
      effectsQuality: 'medium',
      poseOverlayRate: 15,
    });
    expect(PERFORMANCE_PRESETS.quality).toMatchObject({
      modelPreference: 'full',
      inferenceMaxDimension: 768,
      inferenceTargetFps: 30,
      maximumPoseCandidates: 3,
      spectatorReserve: true,
      gameRenderFps: 60,
      antialias: true,
      effectsQuality: 'high',
      poseOverlayRate: 30,
    });
  });

  it('starts Auto from Balanced without sharing a mutable object', () => {
    expect(PERFORMANCE_PRESETS.auto).toMatchObject({
      preset: 'auto',
      modelPreference: 'auto',
      inferenceMaxDimension: 640,
      inferenceTargetFps: 20,
      maximumPoseCandidates: 2,
      gameRenderFps: 45,
    });
    const first = getPerformancePresetSettings('auto');
    const second = getPerformancePresetSettings('auto');
    first.showCameraBehindGame = false;
    expect(second.showCameraBehindGame).toBe(true);
  });
});

describe('performance settings normalization', () => {
  it('preserves a valid Custom configuration and normalizes a spectator slot', () => {
    const normalized = normalizePerformanceSettings(customSettings({
      modelPreference: 'lite',
      inferenceMaxDimension: 960,
      inferenceTargetFps: 24,
      maximumPoseCandidates: 2,
      spectatorReserve: true,
      gameRenderFps: 30,
      antialias: false,
      showCameraBehindGame: false,
      effectsQuality: 'off',
      poseOverlayRate: 0,
      cssBlur: false,
    }));

    expect(normalized).toEqual({
      version: 1,
      preset: 'custom',
      modelPreference: 'lite',
      inferenceMaxDimension: 960,
      inferenceTargetFps: 24,
      maximumPoseCandidates: 3,
      spectatorReserve: true,
      gameRenderFps: 30,
      antialias: false,
      showCameraBehindGame: false,
      effectsQuality: 'off',
      poseOverlayRate: 0,
      cssBlur: false,
    });
  });

  it('canonicalizes named presets while retaining the independent camera override', () => {
    const normalized = normalizePerformanceSettings({
      ...customSettings({ showCameraBehindGame: false }),
      preset: 'performance',
      effectsQuality: 'high',
      gameRenderFps: 60,
    });
    expect(normalized).toEqual({
      ...getPerformancePresetSettings('performance'),
      showCameraBehindGame: false,
    });
  });

  it.each([
    null,
    {},
    { ...customSettings(), version: 0 },
    { ...customSettings(), preset: 'turbo' },
    { ...customSettings(), inferenceMaxDimension: 1_024 },
    { ...customSettings(), inferenceTargetFps: 60 },
    { ...customSettings(), maximumPoseCandidates: 4 },
    { ...customSettings(), antialias: 'yes' },
    { ...customSettings(), poseOverlayRate: 24 },
  ])('falls back to Auto for malformed or old schema %#', (input) => {
    expect(normalizePerformanceSettings(input)).toEqual(
      getPerformancePresetSettings('auto'),
    );
  });
});

describe('performance settings storage', () => {
  it('saves and reloads a normalized v1 configuration', () => {
    const storage = new MemoryStorage();
    const settings = customSettings({
      inferenceTargetFps: 24,
      showCameraBehindGame: false,
      effectsQuality: 'low',
    });

    expect(savePerformanceSettings(settings, storage)).toEqual(settings);
    expect(loadPerformanceSettings(storage)).toEqual(settings);
    expect(JSON.parse(storage.getItem(PERFORMANCE_SETTINGS_STORAGE_KEY) ?? '')).toEqual(settings);
  });

  it.each([
    '{broken json',
    JSON.stringify({ version: 0, preset: 'quality' }),
    JSON.stringify({ ...customSettings(), effectsQuality: 'ultra' }),
  ])('loads Auto when persisted settings are unusable', (serialized) => {
    const storage = new MemoryStorage();
    storage.setItem(PERFORMANCE_SETTINGS_STORAGE_KEY, serialized);
    expect(loadPerformanceSettings(storage)).toEqual(
      getPerformancePresetSettings('auto'),
    );
  });

  it('restores Auto by removing the device-local override', () => {
    const storage = new MemoryStorage();
    savePerformanceSettings(getPerformancePresetSettings('quality'), storage);

    expect(restoreAutoPerformanceSettings(storage)).toEqual(
      getPerformancePresetSettings('auto'),
    );
    expect(storage.getItem(PERFORMANCE_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadPerformanceSettings(storage)).toEqual(
      getPerformancePresetSettings('auto'),
    );
  });

  it('does not block startup when browser storage throws', () => {
    const throwingStorage: PerformanceSettingsStorage = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };

    expect(loadPerformanceSettings(throwingStorage)).toEqual(
      getPerformancePresetSettings('auto'),
    );
    expect(savePerformanceSettings(getPerformancePresetSettings('quality'), throwingStorage).preset)
      .toBe('quality');
    expect(restoreAutoPerformanceSettings(throwingStorage).preset).toBe('auto');
  });
});

describe('shared performance health policy', () => {
  it('uses the documented thresholds for each fixed preset', () => {
    expect(PERFORMANCE_HEALTH_POLICIES).toEqual({
      performance: {
        targetFps: 15,
        minimumUsableFps: 12,
        maximumInferenceP95Ms: 75,
        maximumPipelineP95Ms: 160,
        insufficientLatencyMultiplier: 1.5,
      },
      balanced: {
        targetFps: 20,
        minimumUsableFps: 16,
        maximumInferenceP95Ms: 60,
        maximumPipelineP95Ms: 130,
        insufficientLatencyMultiplier: 1.5,
      },
      quality: {
        targetFps: 30,
        minimumUsableFps: 20,
        maximumInferenceP95Ms: 45,
        maximumPipelineP95Ms: 100,
        insufficientLatencyMultiplier: 1.5,
      },
    });
    expect(getPerformanceHealthPolicy('auto')).toBe(PERFORMANCE_HEALTH_POLICIES.balanced);
    expect(getPerformanceHealthPolicy(customSettings({ inferenceTargetFps: 24 }))).toMatchObject({
      targetFps: 24,
      minimumUsableFps: 18,
    });
  });

  it.each([
    [{ fps: 20, inferenceP95Ms: 60, pipelineP95Ms: 130 }, 'good'],
    [{ fps: 18, inferenceP95Ms: 60, pipelineP95Ms: 130 }, 'degraded'],
    [{ fps: 20, inferenceP95Ms: 61, pipelineP95Ms: 130 }, 'degraded'],
    [{ fps: 15.9, inferenceP95Ms: 30, pipelineP95Ms: 70 }, 'insufficient'],
    [{ fps: 20, inferenceP95Ms: 91, pipelineP95Ms: 70 }, 'insufficient'],
    [{ fps: 20, inferenceP95Ms: 30, pipelineP95Ms: 196 }, 'insufficient'],
  ] as const)('classifies Balanced sample %# as %s', (metrics, expected) => {
    expect(assessPerformanceHealth(metrics, 'balanced').status).toBe(expected);
  });

  it('reports independent limiting factors without treating degradation as calibration failure', () => {
    expect(assessPerformanceHealth({
      fps: 18,
      inferenceP95Ms: 70,
      pipelineP95Ms: 120,
    }, 'balanced')).toMatchObject({
      status: 'degraded',
      limitingFactors: ['fps', 'inference'],
    });
  });

  it('fails safely for invalid timing data', () => {
    expect(assessPerformanceHealth({
      fps: Number.NaN,
      inferenceP95Ms: 30,
      pipelineP95Ms: 70,
    }, 'balanced').status).toBe('insufficient');
  });
});
