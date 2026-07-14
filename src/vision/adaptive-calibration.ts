import type { CalibrationProfile } from '../types/game';

export interface AdaptiveCalibrationSample {
  shoulderWidth: number;
  torsoLength: number;
  poseQuality: number;
  observedAt: number;
}

export interface AdaptiveCalibrationOptions {
  alpha?: number;
  maximumScaleDeviation?: number;
  minimumPoseQuality?: number;
  nominalFrameMs?: number;
}

export interface AdaptiveCalibrationStatus {
  participantId: string;
  acceptedFrames: number;
  rejectedFrames: number;
  shoulderScale: number;
  torsoScale: number;
  lastUpdatedAt: number | null;
}

interface AdaptiveCalibrationState {
  baseline: CalibrationProfile;
  current: CalibrationProfile;
  acceptedFrames: number;
  rejectedFrames: number;
  lastUpdatedAt: number | null;
}

interface ResolvedOptions {
  alpha: number;
  maximumScaleDeviation: number;
  minimumPoseQuality: number;
  nominalFrameMs: number;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  // Roughly 1.3 seconds to settle at 30 fps. This follows deliberate body-scale
  // changes without letting a single bad frame move the play field.
  alpha: 0.025,
  maximumScaleDeviation: 0.1,
  minimumPoseQuality: 0.66,
  nominalFrameMs: 1000 / 30,
};

function cloneProfile(profile: CalibrationProfile): CalibrationProfile {
  return {
    ...profile,
    shoulderCenter: { ...profile.shoulderCenter },
    torsoCenter: { ...profile.torsoCenter },
    ...(profile.headCenter === undefined ? {} : { headCenter: { ...profile.headCenter } }),
    ...(profile.hipCenter === undefined ? {} : { hipCenter: { ...profile.hipCenter } }),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export class AdaptiveCalibrationManager {
  private readonly options: ResolvedOptions;
  private readonly states = new Map<string, AdaptiveCalibrationState>();

  constructor(options: AdaptiveCalibrationOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!(this.options.alpha > 0 && this.options.alpha <= 1)) {
      throw new RangeError('alpha must be in (0, 1]');
    }
    if (!(this.options.maximumScaleDeviation >= 0 && this.options.maximumScaleDeviation < 1)) {
      throw new RangeError('maximumScaleDeviation must be in [0, 1)');
    }
    if (!(this.options.minimumPoseQuality >= 0 && this.options.minimumPoseQuality <= 1)) {
      throw new RangeError('minimumPoseQuality must be in [0, 1]');
    }
    if (!isPositiveFinite(this.options.nominalFrameMs)) {
      throw new RangeError('nominalFrameMs must be positive');
    }
  }

  seed(profile: CalibrationProfile): CalibrationProfile {
    if (!isPositiveFinite(profile.shoulderWidth) || !isPositiveFinite(profile.torsoLength)) {
      throw new RangeError('Calibration profile scale must be positive');
    }
    const baseline = cloneProfile(profile);
    const current = cloneProfile(profile);
    this.states.set(profile.participantId, {
      baseline,
      current,
      acceptedFrames: 0,
      rejectedFrames: 0,
      lastUpdatedAt: null,
    });
    return cloneProfile(current);
  }

  update(
    participantId: string,
    sample: AdaptiveCalibrationSample,
  ): CalibrationProfile | null {
    const state = this.states.get(participantId);
    if (state === undefined) return null;
    const valid =
      isPositiveFinite(sample.shoulderWidth) &&
      isPositiveFinite(sample.torsoLength) &&
      Number.isFinite(sample.poseQuality) &&
      sample.poseQuality >= this.options.minimumPoseQuality &&
      Number.isFinite(sample.observedAt) &&
      (state.lastUpdatedAt === null || sample.observedAt > state.lastUpdatedAt);
    if (!valid) {
      state.rejectedFrames += 1;
      return cloneProfile(state.current);
    }

    const lower = 1 - this.options.maximumScaleDeviation;
    const upper = 1 + this.options.maximumScaleDeviation;
    const boundedShoulder = clamp(
      sample.shoulderWidth,
      state.baseline.shoulderWidth * lower,
      state.baseline.shoulderWidth * upper,
    );
    const boundedTorso = clamp(
      sample.torsoLength,
      state.baseline.torsoLength * lower,
      state.baseline.torsoLength * upper,
    );
    const elapsed =
      state.lastUpdatedAt === null
        ? this.options.nominalFrameMs
        : sample.observedAt - state.lastUpdatedAt;
    // Cap catch-up so a delayed frame cannot perform a sudden recalibration.
    const frameFactor = clamp(elapsed / this.options.nominalFrameMs, 1, 4);
    const alpha = 1 - Math.pow(1 - this.options.alpha, frameFactor);
    state.current.shoulderWidth += (boundedShoulder - state.current.shoulderWidth) * alpha;
    state.current.torsoLength += (boundedTorso - state.current.torsoLength) * alpha;
    state.current.poseQuality = sample.poseQuality;
    state.acceptedFrames += 1;
    state.lastUpdatedAt = sample.observedAt;
    return cloneProfile(state.current);
  }

  get(participantId: string): CalibrationProfile | null {
    const state = this.states.get(participantId);
    return state === undefined ? null : cloneProfile(state.current);
  }

  status(participantId: string): AdaptiveCalibrationStatus | null {
    const state = this.states.get(participantId);
    if (state === undefined) return null;
    return {
      participantId,
      acceptedFrames: state.acceptedFrames,
      rejectedFrames: state.rejectedFrames,
      shoulderScale: state.current.shoulderWidth / state.baseline.shoulderWidth,
      torsoScale: state.current.torsoLength / state.baseline.torsoLength,
      lastUpdatedAt: state.lastUpdatedAt,
    };
  }

  clear(): void {
    this.states.clear();
  }
}
