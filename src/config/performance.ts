export const PERFORMANCE_SETTINGS_VERSION = 1 as const;
export const PERFORMANCE_SETTINGS_STORAGE_KEY =
  'body-fruit-duel:performance-settings:v1';

export type PerformancePreset =
  | 'auto'
  | 'performance'
  | 'balanced'
  | 'quality'
  | 'custom';

export type VisionModelPreference = 'auto' | 'lite' | 'full';
export type EffectsQuality = 'off' | 'low' | 'medium' | 'high';
export type PoseOverlayRate = 0 | 10 | 15 | 30;

export interface PerformanceSettings {
  version: typeof PERFORMANCE_SETTINGS_VERSION;
  preset: PerformancePreset;
  modelPreference: VisionModelPreference;
  inferenceMaxDimension: 512 | 640 | 768 | 960;
  inferenceTargetFps: 15 | 20 | 24 | 30;
  maximumPoseCandidates: 2 | 3;
  spectatorReserve: boolean;
  gameRenderFps: 30 | 45 | 60;
  antialias: boolean;
  showCameraBehindGame: boolean;
  effectsQuality: EffectsQuality;
  poseOverlayRate: PoseOverlayRate;
  cssBlur: boolean;
}

type BuiltInPerformancePreset = Exclude<PerformancePreset, 'custom'>;

function frozenSettings(settings: PerformanceSettings): Readonly<PerformanceSettings> {
  return Object.freeze(settings);
}

/**
 * Canonical settings for selectable presets. Auto deliberately starts from
 * Balanced; its runtime controller may later move within the documented range.
 */
export const PERFORMANCE_PRESETS = Object.freeze({
  auto: frozenSettings({
    version: PERFORMANCE_SETTINGS_VERSION,
    preset: 'auto',
    modelPreference: 'auto',
    inferenceMaxDimension: 640,
    inferenceTargetFps: 20,
    maximumPoseCandidates: 2,
    spectatorReserve: false,
    gameRenderFps: 45,
    antialias: true,
    showCameraBehindGame: true,
    effectsQuality: 'medium',
    poseOverlayRate: 15,
    cssBlur: true,
  }),
  performance: frozenSettings({
    version: PERFORMANCE_SETTINGS_VERSION,
    preset: 'performance',
    modelPreference: 'lite',
    inferenceMaxDimension: 512,
    inferenceTargetFps: 15,
    maximumPoseCandidates: 2,
    spectatorReserve: false,
    gameRenderFps: 30,
    antialias: false,
    showCameraBehindGame: true,
    effectsQuality: 'low',
    poseOverlayRate: 10,
    cssBlur: false,
  }),
  balanced: frozenSettings({
    version: PERFORMANCE_SETTINGS_VERSION,
    preset: 'balanced',
    modelPreference: 'auto',
    inferenceMaxDimension: 640,
    inferenceTargetFps: 20,
    maximumPoseCandidates: 2,
    spectatorReserve: false,
    gameRenderFps: 45,
    antialias: true,
    showCameraBehindGame: true,
    effectsQuality: 'medium',
    poseOverlayRate: 15,
    cssBlur: true,
  }),
  quality: frozenSettings({
    version: PERFORMANCE_SETTINGS_VERSION,
    preset: 'quality',
    modelPreference: 'full',
    inferenceMaxDimension: 768,
    inferenceTargetFps: 30,
    maximumPoseCandidates: 3,
    spectatorReserve: true,
    gameRenderFps: 60,
    antialias: true,
    showCameraBehindGame: true,
    effectsQuality: 'high',
    poseOverlayRate: 30,
    cssBlur: true,
  }),
} satisfies Record<BuiltInPerformancePreset, Readonly<PerformanceSettings>>);

const PERFORMANCE_PRESET_VALUES = [
  'auto',
  'performance',
  'balanced',
  'quality',
  'custom',
] as const satisfies readonly PerformancePreset[];
const MODEL_PREFERENCE_VALUES = ['auto', 'lite', 'full'] as const;
const INFERENCE_DIMENSION_VALUES = [512, 640, 768, 960] as const;
const INFERENCE_FPS_VALUES = [15, 20, 24, 30] as const;
const MAXIMUM_POSE_CANDIDATE_VALUES = [2, 3] as const;
const GAME_RENDER_FPS_VALUES = [30, 45, 60] as const;
const EFFECTS_QUALITY_VALUES = ['off', 'low', 'medium', 'high'] as const;
const POSE_OVERLAY_RATE_VALUES = [0, 10, 15, 30] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T>(value: unknown, values: readonly T[]): value is T {
  return values.some((candidate) => candidate === value);
}

function cloneSettings(settings: Readonly<PerformanceSettings>): PerformanceSettings {
  return { ...settings };
}

export function getPerformancePresetSettings(
  preset: BuiltInPerformancePreset,
): PerformanceSettings {
  return cloneSettings(PERFORMANCE_PRESETS[preset]);
}

/**
 * Parses, validates and normalizes persisted or UI-produced settings in one
 * place. Invalid or old-version values fail closed to a fresh Auto preset.
 * Built-in presets are canonicalized, with the documented camera-background
 * option retained as an independent override.
 */
export function normalizePerformanceSettings(input: unknown): PerformanceSettings {
  const fallback = (): PerformanceSettings => getPerformancePresetSettings('auto');
  if (!isRecord(input) || input.version !== PERFORMANCE_SETTINGS_VERSION) return fallback();
  if (!isOneOf(input.preset, PERFORMANCE_PRESET_VALUES)) return fallback();
  if (!isOneOf(input.modelPreference, MODEL_PREFERENCE_VALUES)) return fallback();
  if (!isOneOf(input.inferenceMaxDimension, INFERENCE_DIMENSION_VALUES)) return fallback();
  if (!isOneOf(input.inferenceTargetFps, INFERENCE_FPS_VALUES)) return fallback();
  if (!isOneOf(input.maximumPoseCandidates, MAXIMUM_POSE_CANDIDATE_VALUES)) return fallback();
  if (typeof input.spectatorReserve !== 'boolean') return fallback();
  if (!isOneOf(input.gameRenderFps, GAME_RENDER_FPS_VALUES)) return fallback();
  if (typeof input.antialias !== 'boolean') return fallback();
  if (typeof input.showCameraBehindGame !== 'boolean') return fallback();
  if (!isOneOf(input.effectsQuality, EFFECTS_QUALITY_VALUES)) return fallback();
  if (!isOneOf(input.poseOverlayRate, POSE_OVERLAY_RATE_VALUES)) return fallback();
  if (typeof input.cssBlur !== 'boolean') return fallback();

  if (input.preset !== 'custom') {
    return {
      ...getPerformancePresetSettings(input.preset),
      showCameraBehindGame: input.showCameraBehindGame,
    };
  }

  return {
    version: PERFORMANCE_SETTINGS_VERSION,
    preset: 'custom',
    modelPreference: input.modelPreference,
    inferenceMaxDimension: input.inferenceMaxDimension,
    inferenceTargetFps: input.inferenceTargetFps,
    maximumPoseCandidates: input.spectatorReserve ? 3 : input.maximumPoseCandidates,
    spectatorReserve: input.spectatorReserve,
    gameRenderFps: input.gameRenderFps,
    antialias: input.antialias,
    showCameraBehindGame: input.showCameraBehindGame,
    effectsQuality: input.effectsQuality,
    poseOverlayRate: input.poseOverlayRate,
    cssBlur: input.cssBlur,
  };
}

export interface PerformanceSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): PerformanceSettingsStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadPerformanceSettings(
  storage: Pick<PerformanceSettingsStorage, 'getItem'> | null = getBrowserStorage(),
): PerformanceSettings {
  if (storage === null) return getPerformancePresetSettings('auto');
  try {
    const serialized = storage.getItem(PERFORMANCE_SETTINGS_STORAGE_KEY);
    if (serialized === null) return getPerformancePresetSettings('auto');
    return normalizePerformanceSettings(JSON.parse(serialized) as unknown);
  } catch {
    return getPerformancePresetSettings('auto');
  }
}

export function savePerformanceSettings(
  input: unknown,
  storage: Pick<PerformanceSettingsStorage, 'setItem'> | null = getBrowserStorage(),
): PerformanceSettings {
  const settings = normalizePerformanceSettings(input);
  try {
    storage?.setItem(PERFORMANCE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts;
    // the normalized in-memory setting is still safe to apply for this run.
  }
  return settings;
}

export function restoreAutoPerformanceSettings(
  storage: Pick<PerformanceSettingsStorage, 'removeItem'> | null = getBrowserStorage(),
): PerformanceSettings {
  try {
    storage?.removeItem(PERFORMANCE_SETTINGS_STORAGE_KEY);
  } catch {
    // Resetting the in-memory value must remain possible when storage fails.
  }
  return getPerformancePresetSettings('auto');
}

export interface PerformanceHealthPolicy {
  readonly targetFps: number;
  readonly minimumUsableFps: number;
  readonly maximumInferenceP95Ms: number;
  readonly maximumPipelineP95Ms: number;
  readonly insufficientLatencyMultiplier: number;
}

type FixedHealthPreset = 'performance' | 'balanced' | 'quality';

export const PERFORMANCE_HEALTH_POLICIES = Object.freeze({
  performance: Object.freeze({
    targetFps: 15,
    minimumUsableFps: 12,
    maximumInferenceP95Ms: 75,
    maximumPipelineP95Ms: 160,
    insufficientLatencyMultiplier: 1.5,
  }),
  balanced: Object.freeze({
    targetFps: 20,
    minimumUsableFps: 16,
    maximumInferenceP95Ms: 60,
    maximumPipelineP95Ms: 130,
    insufficientLatencyMultiplier: 1.5,
  }),
  quality: Object.freeze({
    targetFps: 30,
    minimumUsableFps: 20,
    maximumInferenceP95Ms: 45,
    maximumPipelineP95Ms: 100,
    insufficientLatencyMultiplier: 1.5,
  }),
} satisfies Record<FixedHealthPreset, PerformanceHealthPolicy>);

const CUSTOM_HEALTH_POLICY_BY_FPS = Object.freeze({
  15: PERFORMANCE_HEALTH_POLICIES.performance,
  20: PERFORMANCE_HEALTH_POLICIES.balanced,
  24: Object.freeze({
    targetFps: 24,
    minimumUsableFps: 18,
    maximumInferenceP95Ms: 54,
    maximumPipelineP95Ms: 118,
    insufficientLatencyMultiplier: 1.5,
  }),
  30: PERFORMANCE_HEALTH_POLICIES.quality,
} satisfies Record<PerformanceSettings['inferenceTargetFps'], PerformanceHealthPolicy>);

export function getPerformanceHealthPolicy(
  settingsOrPreset: PerformanceSettings | PerformancePreset,
): PerformanceHealthPolicy {
  if (typeof settingsOrPreset === 'string') {
    if (
      settingsOrPreset === 'performance' ||
      settingsOrPreset === 'balanced' ||
      settingsOrPreset === 'quality'
    ) {
      return PERFORMANCE_HEALTH_POLICIES[settingsOrPreset];
    }
    return PERFORMANCE_HEALTH_POLICIES.balanced;
  }
  if (
    settingsOrPreset.preset === 'performance' ||
    settingsOrPreset.preset === 'balanced' ||
    settingsOrPreset.preset === 'quality'
  ) {
    return PERFORMANCE_HEALTH_POLICIES[settingsOrPreset.preset];
  }
  return CUSTOM_HEALTH_POLICY_BY_FPS[settingsOrPreset.inferenceTargetFps];
}

export interface PerformanceHealthMetrics {
  fps: number;
  inferenceP95Ms: number;
  pipelineP95Ms: number;
}

export type PerformanceHealthStatus = 'good' | 'degraded' | 'insufficient';
export type PerformanceHealthLimitingFactor = 'fps' | 'inference' | 'pipeline';

export interface PerformanceHealthAssessment {
  status: PerformanceHealthStatus;
  policy: PerformanceHealthPolicy;
  limitingFactors: PerformanceHealthLimitingFactor[];
}

export function assessPerformanceHealth(
  metrics: PerformanceHealthMetrics,
  settingsOrPreset: PerformanceSettings | PerformancePreset,
): PerformanceHealthAssessment {
  const policy = getPerformanceHealthPolicy(settingsOrPreset);
  const values = [metrics.fps, metrics.inferenceP95Ms, metrics.pipelineP95Ms];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return {
      status: 'insufficient',
      policy,
      limitingFactors: ['fps', 'inference', 'pipeline'],
    };
  }

  const limitingFactors: PerformanceHealthLimitingFactor[] = [];
  if (metrics.fps < policy.targetFps) limitingFactors.push('fps');
  if (metrics.inferenceP95Ms > policy.maximumInferenceP95Ms) {
    limitingFactors.push('inference');
  }
  if (metrics.pipelineP95Ms > policy.maximumPipelineP95Ms) {
    limitingFactors.push('pipeline');
  }

  const latencyIsInsufficient =
    metrics.inferenceP95Ms >
      policy.maximumInferenceP95Ms * policy.insufficientLatencyMultiplier ||
    metrics.pipelineP95Ms >
      policy.maximumPipelineP95Ms * policy.insufficientLatencyMultiplier;
  const status: PerformanceHealthStatus =
    metrics.fps < policy.minimumUsableFps || latencyIsInsufficient
      ? 'insufficient'
      : limitingFactors.length === 0
        ? 'good'
        : 'degraded';

  return { status, policy, limitingFactors };
}
