import {
  assessPerformanceHealth,
  getPerformanceHealthPolicy,
  getPerformancePresetSettings,
  normalizePerformanceSettings,
  type PerformanceHealthStatus,
  type PerformanceSettings,
} from '../config/performance';
import type { PoseBackend } from './pose-backend';

export type VisionDiagnosis =
  | 'warming-up'
  | 'healthy'
  | 'performance-limited'
  | 'recognition-limited';

export type VisionAdaptiveMode =
  | 'gpu-quality'
  | 'gpu-recognition-rescue'
  | 'gpu-balanced'
  | 'gpu-emergency'
  | 'cpu-balanced'
  | 'cpu-recognition-rescue'
  | 'cpu-emergency';

export type VisionModelTier = 'lite' | 'full';
export type VisionResizeQuality = 'low' | 'medium' | 'high';

export interface VisionAdaptiveProfile {
  mode: VisionAdaptiveMode;
  modelTier: VisionModelTier;
  maxPoses: 2 | 3;
  maxDimension: 512 | 640 | 768 | 960;
  resizeQuality: VisionResizeQuality;
}

export interface VisionAdaptationSample {
  inferenceMs: number;
  pipelineMs: number;
  /** Effective registered players, not merely raw model candidates. */
  poseCount: number;
  /** Main-thread interval between delivered results; omitted for the first result. */
  resultIntervalMs?: number;
  /** True when player calibration is not advancing despite delivered poses. */
  calibrationStalled?: boolean;
  /** True only when full candidate slots may be occupied by another person. */
  candidatePressure?: boolean;
}

export interface VisionAdaptationSnapshot {
  profile: VisionAdaptiveProfile;
  diagnosis: VisionDiagnosis;
  performanceStatus: PerformanceHealthStatus | 'measuring';
  profileChanged: boolean;
  inferenceP95: number;
  pipelineP95: number;
  expectedPoseHitRate: number | null;
  calibrationStallRate: number;
  candidatePressureRate: number;
  resultFps: number | null;
  sampleCount: number;
}

export interface AutoVisionRuntimePolicy {
  targetFps: PerformanceSettings['inferenceTargetFps'];
  visionLoadReductionAllowed: boolean;
}

/**
 * Auto owns only vision-side load changes. It begins at Balanced on both
 * backends and never adds a third candidate merely because a player is
 * missing. A separate candidate-pressure signal is required for that step.
 */
const AUTO_PROFILES: Record<VisionAdaptiveMode, Readonly<VisionAdaptiveProfile>> = {
  'gpu-quality': {
    mode: 'gpu-quality',
    modelTier: 'full',
    maxPoses: 2,
    maxDimension: 768,
    resizeQuality: 'high',
  },
  'gpu-recognition-rescue': {
    mode: 'gpu-recognition-rescue',
    modelTier: 'full',
    maxPoses: 2,
    maxDimension: 960,
    resizeQuality: 'high',
  },
  'gpu-balanced': {
    mode: 'gpu-balanced',
    modelTier: 'full',
    maxPoses: 2,
    maxDimension: 640,
    resizeQuality: 'medium',
  },
  'gpu-emergency': {
    mode: 'gpu-emergency',
    modelTier: 'full',
    maxPoses: 2,
    maxDimension: 512,
    resizeQuality: 'low',
  },
  'cpu-balanced': {
    mode: 'cpu-balanced',
    modelTier: 'lite',
    maxPoses: 2,
    maxDimension: 640,
    resizeQuality: 'medium',
  },
  'cpu-recognition-rescue': {
    mode: 'cpu-recognition-rescue',
    modelTier: 'lite',
    maxPoses: 2,
    maxDimension: 768,
    resizeQuality: 'high',
  },
  'cpu-emergency': {
    mode: 'cpu-emergency',
    modelTier: 'lite',
    maxPoses: 2,
    maxDimension: 512,
    resizeQuality: 'low',
  },
};

const WINDOW_SIZE = 24;
const MINIMUM_PERFORMANCE_SAMPLES = 12;
const CHANGE_COOLDOWN_SAMPLES = 48;
const RECOVERY_SAMPLES = 72;
const RECOGNITION_HIT_RATE = 0.55;
const CALIBRATION_STALL_RATE = 0.5;
const CANDIDATE_PRESSURE_RATE = 0.5;

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function initialMode(backend: PoseBackend): VisionAdaptiveMode {
  return backend === 'gpu' ? 'gpu-balanced' : 'cpu-balanced';
}

function lowerLoadMode(mode: VisionAdaptiveMode): VisionAdaptiveMode {
  switch (mode) {
    case 'gpu-recognition-rescue':
    case 'gpu-quality':
      return 'gpu-balanced';
    case 'gpu-balanced':
      return 'gpu-emergency';
    case 'cpu-recognition-rescue':
      return 'cpu-balanced';
    case 'cpu-balanced':
      return 'cpu-emergency';
    default:
      return mode;
  }
}

function recoverMode(mode: VisionAdaptiveMode): VisionAdaptiveMode {
  switch (mode) {
    case 'gpu-emergency':
    case 'gpu-quality':
    case 'gpu-recognition-rescue':
      return 'gpu-balanced';
    case 'cpu-emergency':
    case 'cpu-recognition-rescue':
      return 'cpu-balanced';
    default:
      return mode;
  }
}

function recognitionRescueMode(mode: VisionAdaptiveMode): VisionAdaptiveMode {
  switch (mode) {
    case 'gpu-emergency':
      return 'gpu-balanced';
    case 'gpu-balanced':
      return 'gpu-quality';
    case 'gpu-quality':
      return 'gpu-recognition-rescue';
    case 'cpu-emergency':
      return 'cpu-balanced';
    case 'cpu-balanced':
      return 'cpu-recognition-rescue';
    default:
      return mode;
  }
}

function resizeQuality(maxDimension: PerformanceSettings['inferenceMaxDimension']): VisionResizeQuality {
  if (maxDimension <= 512) return 'low';
  if (maxDimension <= 640) return 'medium';
  return 'high';
}

function fixedMode(
  backend: PoseBackend,
  settings: PerformanceSettings,
): VisionAdaptiveMode {
  if (backend === 'cpu') {
    if (settings.inferenceMaxDimension <= 512) return 'cpu-emergency';
    if (settings.inferenceMaxDimension >= 768 || settings.maximumPoseCandidates === 3) {
      return 'cpu-recognition-rescue';
    }
    return 'cpu-balanced';
  }
  if (settings.inferenceMaxDimension <= 512) return 'gpu-emergency';
  if (settings.inferenceMaxDimension >= 960) return 'gpu-recognition-rescue';
  if (settings.inferenceMaxDimension >= 768 || settings.maximumPoseCandidates === 3) {
    return 'gpu-quality';
  }
  return 'gpu-balanced';
}

/** Resolves exact fixed-preset runtime values without enabling Auto changes. */
export function visionProfileForPerformanceSettings(
  settings: PerformanceSettings,
  backend: PoseBackend,
): VisionAdaptiveProfile {
  const normalized = normalizePerformanceSettings(settings);
  return {
    mode: fixedMode(backend, normalized),
    modelTier:
      backend === 'cpu' || normalized.modelPreference === 'lite'
        ? 'lite'
        : 'full',
    maxPoses: normalized.maximumPoseCandidates,
    maxDimension: normalized.inferenceMaxDimension,
    resizeQuality: resizeQuality(normalized.inferenceMaxDimension),
  };
}

/**
 * Separates sustained load problems from healthy-but-incomplete recognition.
 * Fixed presets are diagnosed with the same central policy as the UI but are
 * never silently altered. Only Auto changes profiles.
 */
export class AdaptiveVisionLoadController {
  private backend: PoseBackend;
  private settings: PerformanceSettings;
  private currentMode: VisionAdaptiveMode;
  private expectedPoseCount: 1 | 2 | null = null;
  private samples: VisionAdaptationSample[] = [];
  private cooldownRemaining = 0;
  private healthySampleStreak = 0;
  private candidateReserveActive = false;
  private autoRuntimePolicy: AutoVisionRuntimePolicy;

  constructor(
    backend: PoseBackend = 'cpu',
    settings: PerformanceSettings = getPerformancePresetSettings('auto'),
  ) {
    this.backend = backend;
    this.settings = normalizePerformanceSettings(settings);
    this.currentMode = initialMode(backend);
    this.candidateReserveActive = this.settings.spectatorReserve;
    this.autoRuntimePolicy = {
      targetFps: this.settings.inferenceTargetFps,
      visionLoadReductionAllowed: true,
    };
  }

  get profile(): VisionAdaptiveProfile {
    if (this.settings.preset !== 'auto') {
      return visionProfileForPerformanceSettings(this.settings, this.backend);
    }
    const base = AUTO_PROFILES[this.currentMode];
    return {
      ...base,
      maxPoses:
        this.candidateReserveActive &&
        (this.currentMode === 'gpu-recognition-rescue' ||
          this.currentMode === 'cpu-recognition-rescue')
          ? 3
          : 2,
    };
  }

  get performanceSettings(): PerformanceSettings {
    return { ...this.settings };
  }

  get targetFps(): PerformanceSettings['inferenceTargetFps'] {
    return this.settings.preset === 'auto'
      ? this.autoRuntimePolicy.targetFps
      : this.settings.inferenceTargetFps;
  }

  setAutoRuntimePolicy(policy: AutoVisionRuntimePolicy): VisionAdaptiveProfile {
    if (this.settings.preset !== 'auto') return this.profile;
    if (![15, 20, 24, 30].includes(policy.targetFps)) {
      throw new RangeError('Auto runtime target FPS must be 15, 20, 24, or 30');
    }
    const changed =
      this.autoRuntimePolicy.targetFps !== policy.targetFps ||
      this.autoRuntimePolicy.visionLoadReductionAllowed !==
        policy.visionLoadReductionAllowed;
    this.autoRuntimePolicy = { ...policy };
    if (!policy.visionLoadReductionAllowed && this.currentMode.endsWith('emergency')) {
      this.currentMode = initialMode(this.backend);
    }
    if (changed) {
      this.cooldownRemaining = 0;
      this.clearWindow();
    }
    return this.profile;
  }

  setPerformanceSettings(settings: PerformanceSettings): VisionAdaptiveProfile {
    this.settings = normalizePerformanceSettings(settings);
    this.currentMode = initialMode(this.backend);
    this.candidateReserveActive = this.settings.spectatorReserve;
    this.autoRuntimePolicy = {
      targetFps: this.settings.inferenceTargetFps,
      visionLoadReductionAllowed: true,
    };
    this.cooldownRemaining = 0;
    this.clearWindow();
    return this.profile;
  }

  setBackend(backend: PoseBackend): VisionAdaptiveProfile {
    this.backend = backend;
    this.currentMode = initialMode(backend);
    this.candidateReserveActive = this.settings.spectatorReserve;
    this.cooldownRemaining = 0;
    this.clearWindow();
    return this.profile;
  }

  setExpectedPoseCount(expected: 1 | 2 | null): VisionAdaptiveProfile {
    this.expectedPoseCount = expected;
    if (expected !== 2 && this.settings.preset === 'auto') {
      this.currentMode = initialMode(this.backend);
      this.candidateReserveActive = false;
      this.cooldownRemaining = 0;
    }
    this.clearWindow();
    return this.profile;
  }

  observe(sample: VisionAdaptationSample): VisionAdaptationSnapshot {
    if (
      !Number.isFinite(sample.inferenceMs) ||
      !Number.isFinite(sample.pipelineMs) ||
      !Number.isFinite(sample.poseCount) ||
      (sample.resultIntervalMs !== undefined &&
        (!Number.isFinite(sample.resultIntervalMs) || sample.resultIntervalMs < 0)) ||
      sample.inferenceMs < 0 ||
      sample.pipelineMs < 0 ||
      sample.poseCount < 0
    ) {
      throw new RangeError('Vision adaptation samples must be finite and non-negative');
    }

    this.samples.push(sample);
    if (this.samples.length > WINDOW_SIZE) this.samples.shift();
    if (this.cooldownRemaining > 0) this.cooldownRemaining -= 1;

    const inferenceP95 = percentile95(this.samples.map(({ inferenceMs }) => inferenceMs));
    const pipelineP95 = percentile95(this.samples.map(({ pipelineMs }) => pipelineMs));
    const expectedPoseHitRate = this.expectedPoseCount === null
      ? null
      : this.samples.filter(({ poseCount }) => poseCount >= this.expectedPoseCount!).length /
        this.samples.length;
    const calibrationStallRate =
      this.samples.filter(({ calibrationStalled }) => calibrationStalled === true).length /
      this.samples.length;
    const candidatePressureRate =
      this.samples.filter(({ candidatePressure }) => candidatePressure === true).length /
      this.samples.length;
    const resultIntervals = this.samples.flatMap(({ resultIntervalMs }) =>
      resultIntervalMs === undefined || resultIntervalMs <= 0 ? [] : [resultIntervalMs],
    );
    const meanResultInterval = resultIntervals.length === 0
      ? 0
      : resultIntervals.reduce((total, value) => total + value, 0) /
        resultIntervals.length;
    const resultFps =
      resultIntervals.length >= 6 && meanResultInterval > 0
        ? 1_000 / meanResultInterval
        : null;

    let performanceStatus: PerformanceHealthStatus | 'measuring' = 'measuring';
    let diagnosis: VisionDiagnosis = 'warming-up';
    if (this.samples.length >= MINIMUM_PERFORMANCE_SAMPLES) {
      const healthSettings = this.settings.preset === 'auto'
        ? {
            ...this.settings,
            preset: 'custom' as const,
            inferenceTargetFps: this.autoRuntimePolicy.targetFps,
          }
        : this.settings;
      const policy = getPerformanceHealthPolicy(healthSettings);
      performanceStatus = assessPerformanceHealth({
        fps: resultFps ?? policy.targetFps,
        inferenceP95Ms: inferenceP95,
        pipelineP95Ms: pipelineP95,
      }, healthSettings).status;
      diagnosis = performanceStatus === 'good' ? 'healthy' : 'performance-limited';
    }
    if (
      diagnosis === 'healthy' &&
      this.samples.length >= WINDOW_SIZE &&
      this.expectedPoseCount !== null &&
      ((expectedPoseHitRate !== null && expectedPoseHitRate < RECOGNITION_HIT_RATE) ||
        calibrationStallRate >= CALIBRATION_STALL_RATE)
    ) {
      diagnosis = 'recognition-limited';
    }

    const isSustainablyHealthy =
      performanceStatus === 'good' && diagnosis === 'healthy';
    this.healthySampleStreak = isSustainablyHealthy ? this.healthySampleStreak + 1 : 0;

    let profileChanged = false;
    if (this.settings.preset === 'auto' && this.cooldownRemaining === 0) {
      if (
        diagnosis === 'performance-limited' &&
        this.autoRuntimePolicy.visionLoadReductionAllowed
      ) {
        profileChanged = this.changeMode(lowerLoadMode(this.currentMode));
      } else if (diagnosis === 'recognition-limited') {
        const nextMode = recognitionRescueMode(this.currentMode);
        profileChanged = this.changeMode(nextMode);
        const reserveAllowed =
          this.settings.spectatorReserve || candidatePressureRate >= CANDIDATE_PRESSURE_RATE;
        const inCandidateRescue =
          this.currentMode === 'gpu-recognition-rescue' ||
          this.currentMode === 'cpu-recognition-rescue';
        if (inCandidateRescue && reserveAllowed !== this.candidateReserveActive) {
          this.candidateReserveActive = reserveAllowed;
          profileChanged = true;
          this.cooldownRemaining = CHANGE_COOLDOWN_SAMPLES;
        }
      } else if (this.healthySampleStreak >= RECOVERY_SAMPLES) {
        profileChanged = this.changeMode(recoverMode(this.currentMode));
      }
    }

    const snapshot: VisionAdaptationSnapshot = {
      profile: this.profile,
      diagnosis,
      performanceStatus,
      profileChanged,
      inferenceP95,
      pipelineP95,
      expectedPoseHitRate,
      calibrationStallRate,
      candidatePressureRate,
      resultFps,
      sampleCount: this.samples.length,
    };
    if (profileChanged) this.clearWindow();
    return snapshot;
  }

  private changeMode(nextMode: VisionAdaptiveMode): boolean {
    if (nextMode === this.currentMode) return false;
    this.currentMode = nextMode;
    if (
      nextMode !== 'gpu-recognition-rescue' &&
      nextMode !== 'cpu-recognition-rescue'
    ) {
      this.candidateReserveActive = false;
    }
    this.cooldownRemaining = CHANGE_COOLDOWN_SAMPLES;
    return true;
  }

  private clearWindow(): void {
    this.samples = [];
    this.healthySampleStreak = 0;
  }
}
