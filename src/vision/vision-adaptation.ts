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
  poseCount: number;
  /** Main-thread interval between delivered results; omitted for the first result. */
  resultIntervalMs?: number;
}

export interface VisionAdaptationSnapshot {
  profile: VisionAdaptiveProfile;
  diagnosis: VisionDiagnosis;
  profileChanged: boolean;
  inferenceP95: number;
  pipelineP95: number;
  expectedPoseHitRate: number | null;
  resultFps: number | null;
  sampleCount: number;
}

const PROFILES: Record<VisionAdaptiveMode, VisionAdaptiveProfile> = {
  'gpu-quality': {
    mode: 'gpu-quality',
    modelTier: 'full',
    maxPoses: 3,
    maxDimension: 768,
    resizeQuality: 'high',
  },
  'gpu-recognition-rescue': {
    mode: 'gpu-recognition-rescue',
    modelTier: 'full',
    maxPoses: 3,
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
    // A third Lite candidate is enabled only after CPU latency has already
    // proved healthy. This lets the tracker recover two enrolled players when
    // one nearby spectator would otherwise consume the two-candidate cap.
    maxPoses: 3,
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

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function initialMode(backend: PoseBackend): VisionAdaptiveMode {
  return backend === 'gpu' ? 'gpu-quality' : 'cpu-balanced';
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
      return 'gpu-balanced';
    case 'gpu-balanced':
      return 'gpu-quality';
    case 'cpu-emergency':
      return 'cpu-balanced';
    default:
      return mode;
  }
}

function recognitionRescueMode(mode: VisionAdaptiveMode): VisionAdaptiveMode {
  switch (mode) {
    case 'gpu-quality':
      return 'gpu-recognition-rescue';
    case 'gpu-emergency':
      return 'gpu-balanced';
    case 'gpu-balanced':
      return 'gpu-quality';
    case 'cpu-emergency':
      return 'cpu-balanced';
    case 'cpu-balanced':
      return 'cpu-recognition-rescue';
    default:
      return mode;
  }
}

/**
 * Separates slow inference from healthy-but-incomplete pose detection.
 *
 * The controller deliberately uses long windows and a cooldown: changing
 * `numPoses` makes MediaPipe rebuild part of its graph, so a single slow or
 * occluded frame must never cause a mode switch. It also never drops below two
 * candidates while a two-player round is expected.
 */
export class AdaptiveVisionLoadController {
  private backend: PoseBackend;
  private currentMode: VisionAdaptiveMode;
  private expectedPoseCount: 1 | 2 | null = null;
  private samples: VisionAdaptationSample[] = [];
  private cooldownRemaining = 0;
  private fastSampleStreak = 0;

  constructor(backend: PoseBackend = 'cpu') {
    this.backend = backend;
    this.currentMode = initialMode(backend);
  }

  get profile(): VisionAdaptiveProfile {
    return PROFILES[this.currentMode];
  }

  setBackend(backend: PoseBackend): VisionAdaptiveProfile {
    this.backend = backend;
    this.currentMode = initialMode(backend);
    this.cooldownRemaining = 0;
    this.clearWindow();
    return this.profile;
  }

  setExpectedPoseCount(expected: 1 | 2 | null): VisionAdaptiveProfile {
    this.expectedPoseCount = expected;
    if (
      expected !== 2 &&
      (this.currentMode === 'gpu-recognition-rescue' ||
        this.currentMode === 'cpu-recognition-rescue')
    ) {
      this.currentMode = initialMode(this.backend);
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

    let diagnosis: VisionDiagnosis = 'warming-up';
    if (this.samples.length >= MINIMUM_PERFORMANCE_SAMPLES) {
      // The activity release gates are 45/100 ms. A small margin prevents a
      // 46 ms boundary wobble from rebuilding the graph repeatedly, while
      // still intervening well before latency becomes visibly disruptive.
      diagnosis =
        inferenceP95 > 55 ||
        pipelineP95 > 110 ||
        (resultFps !== null && resultFps < 20)
        ? 'performance-limited'
        : 'healthy';
    }
    if (
      diagnosis === 'healthy' &&
      this.samples.length >= WINDOW_SIZE &&
      expectedPoseHitRate !== null &&
      expectedPoseHitRate < 0.55
    ) {
      diagnosis = 'recognition-limited';
    }

    const isFast =
      this.samples.length >= MINIMUM_PERFORMANCE_SAMPLES &&
      inferenceP95 <= 38 &&
      pipelineP95 <= 80;
    this.fastSampleStreak = isFast ? this.fastSampleStreak + 1 : 0;

    let profileChanged = false;
    if (this.cooldownRemaining === 0 && diagnosis === 'performance-limited') {
      profileChanged = this.changeMode(lowerLoadMode(this.currentMode));
    } else if (this.cooldownRemaining === 0 && diagnosis === 'recognition-limited') {
      profileChanged = this.changeMode(recognitionRescueMode(this.currentMode));
    } else if (this.cooldownRemaining === 0 && this.fastSampleStreak >= RECOVERY_SAMPLES) {
      profileChanged = this.changeMode(recoverMode(this.currentMode));
    }

    const snapshot: VisionAdaptationSnapshot = {
      profile: this.profile,
      diagnosis,
      profileChanged,
      inferenceP95,
      pipelineP95,
      expectedPoseHitRate,
      resultFps,
      sampleCount: this.samples.length,
    };
    if (profileChanged) this.clearWindow();
    return snapshot;
  }

  private changeMode(nextMode: VisionAdaptiveMode): boolean {
    if (nextMode === this.currentMode) return false;
    this.currentMode = nextMode;
    this.cooldownRemaining = CHANGE_COOLDOWN_SAMPLES;
    return true;
  }

  private clearWindow(): void {
    this.samples = [];
    this.fastSampleStreak = 0;
  }
}
