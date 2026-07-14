import {
  getPerformancePresetSettings,
  normalizePerformanceSettings,
  type EffectsQuality,
  type PerformanceHealthStatus,
  type PerformancePreset,
  type PerformanceSettings,
  type PoseOverlayRate,
} from './performance';

/** Consecutive pressure samples required before Auto lowers one stage. */
export const AUTO_PERFORMANCE_SAMPLE_WINDOW = 12;

/** Minimum samples between any two automatic stage changes. */
export const AUTO_PERFORMANCE_COOLDOWN_SAMPLES = 24;

/** Consecutive good samples required to recover one degraded stage. */
export const AUTO_PERFORMANCE_RECOVERY_HYSTERESIS_SAMPLES = 36;

/** Longer healthy run required to move from Balanced into Quality. */
export const AUTO_PERFORMANCE_QUALITY_HYSTERESIS_SAMPLES = 72;

export type AutoPerformanceStage = 'quality' | 0 | 1 | 2 | 3;

export interface AutoPerformanceRuntimeProfile {
  readonly gameRenderFps: PerformanceSettings['gameRenderFps'];
  readonly effectsQuality: EffectsQuality;
  readonly poseOverlayRate: PoseOverlayRate;
  readonly inferenceTargetFps: PerformanceSettings['inferenceTargetFps'];
  /** Vision may lower resolution/candidate load only at the final pressure stage. */
  readonly visionLoadReductionAllowed: boolean;
}

export interface AutoPerformanceStageDefinition extends AutoPerformanceRuntimeProfile {
  readonly stage: AutoPerformanceStage;
  readonly name: string;
}

function frozenStage(
  definition: AutoPerformanceStageDefinition,
): Readonly<AutoPerformanceStageDefinition> {
  return Object.freeze(definition);
}

/**
 * Ordered from highest quality to lowest load. Stage 0 is deliberately the
 * canonical Balanced starting point; the named Quality stage sits above it.
 */
export const AUTO_PERFORMANCE_STAGES = Object.freeze([
  frozenStage({
    stage: 'quality',
    name: 'quality',
    gameRenderFps: 60,
    effectsQuality: 'high',
    poseOverlayRate: 30,
    inferenceTargetFps: 30,
    visionLoadReductionAllowed: false,
  }),
  frozenStage({
    stage: 0,
    name: 'balanced',
    gameRenderFps: 45,
    effectsQuality: 'medium',
    poseOverlayRate: 15,
    inferenceTargetFps: 20,
    visionLoadReductionAllowed: false,
  }),
  frozenStage({
    stage: 1,
    name: 'effects-reduced',
    gameRenderFps: 45,
    effectsQuality: 'low',
    poseOverlayRate: 10,
    inferenceTargetFps: 20,
    visionLoadReductionAllowed: false,
  }),
  frozenStage({
    stage: 2,
    name: 'render-reduced',
    gameRenderFps: 30,
    effectsQuality: 'low',
    poseOverlayRate: 10,
    inferenceTargetFps: 20,
    visionLoadReductionAllowed: false,
  }),
  frozenStage({
    stage: 3,
    name: 'vision-reduction-allowed',
    gameRenderFps: 30,
    effectsQuality: 'low',
    poseOverlayRate: 10,
    inferenceTargetFps: 15,
    visionLoadReductionAllowed: true,
  }),
] satisfies readonly AutoPerformanceStageDefinition[]);

const QUALITY_STAGE_INDEX = 0;
const BALANCED_STAGE_INDEX = 1;
const LOWEST_LOAD_STAGE_INDEX = AUTO_PERFORMANCE_STAGES.length - 1;

export interface AutoPerformanceSnapshot {
  readonly preset: PerformancePreset;
  readonly autoEnabled: boolean;
  readonly stage: AutoPerformanceStage | null;
  readonly runtime: Readonly<AutoPerformanceRuntimeProfile>;
  readonly changed: boolean;
  readonly lastStatus: PerformanceHealthStatus | null;
  readonly sampleWindowCount: number;
  readonly pressureSampleCount: number;
  readonly goodStreak: number;
  readonly cooldownRemaining: number;
}

/** Merges the ephemeral Auto stage into a validated setting without persisting it. */
export function resolveEffectivePerformanceSettings(
  input: PerformanceSettings,
  snapshot: Pick<AutoPerformanceSnapshot, 'autoEnabled' | 'runtime'>,
): PerformanceSettings {
  const settings = normalizePerformanceSettings(input);
  if (!snapshot.autoEnabled || settings.preset !== 'auto') return settings;
  const { runtime } = snapshot;
  return {
    ...settings,
    inferenceTargetFps: runtime.inferenceTargetFps,
    gameRenderFps: runtime.gameRenderFps,
    effectsQuality: runtime.effectsQuality,
    poseOverlayRate: runtime.poseOverlayRate,
    // Antialias is an initialization setting; the app applies this desired
    // value at the next safe renderer boundary if a round is already active.
    antialias: runtime.gameRenderFps === 30 ? false : settings.antialias,
    cssBlur: runtime.effectsQuality === 'low' ? false : settings.cssBlur,
  };
}

function settingsForPresetInput(
  input: PerformancePreset | PerformanceSettings,
): PerformanceSettings {
  if (typeof input !== 'string') return normalizePerformanceSettings(input);
  if (input === 'custom') {
    // A named Custom preset has no values of its own. Keep it fixed and use a
    // neutral runtime until the caller supplies the full custom settings.
    return { ...getPerformancePresetSettings('balanced'), preset: 'custom' };
  }
  return getPerformancePresetSettings(input);
}

function fixedRuntime(
  settings: PerformanceSettings,
): Readonly<AutoPerformanceRuntimeProfile> {
  return Object.freeze({
    gameRenderFps: settings.gameRenderFps,
    effectsQuality: settings.effectsQuality,
    poseOverlayRate: settings.poseOverlayRate,
    inferenceTargetFps: settings.inferenceTargetFps,
    visionLoadReductionAllowed: false,
  });
}

function stageRuntime(
  stage: AutoPerformanceStageDefinition,
): Readonly<AutoPerformanceRuntimeProfile> {
  return Object.freeze({
    gameRenderFps: stage.gameRenderFps,
    effectsQuality: stage.effectsQuality,
    poseOverlayRate: stage.poseOverlayRate,
    inferenceTargetFps: stage.inferenceTargetFps,
    visionLoadReductionAllowed: stage.visionLoadReductionAllowed,
  });
}

function runtimeSignature(runtime: AutoPerformanceRuntimeProfile): string {
  return [
    runtime.gameRenderFps,
    runtime.effectsQuality,
    runtime.poseOverlayRate,
    runtime.inferenceTargetFps,
    runtime.visionLoadReductionAllowed,
  ].join(':');
}

/**
 * Owns cross-system Auto staging only. Vision-specific adaptation remains
 * gated behind `visionLoadReductionAllowed`; fixed presets never enter this
 * state machine.
 */
export class AutoPerformanceController {
  private settings: PerformanceSettings;
  private stageIndex = BALANCED_STAGE_INDEX;
  private sampleWindow: PerformanceHealthStatus[] = [];
  private consecutiveGoodSamples = 0;
  private remainingCooldown = 0;
  private latestStatus: PerformanceHealthStatus | null = null;

  constructor(preset: PerformancePreset | PerformanceSettings = 'auto') {
    this.settings = settingsForPresetInput(preset);
  }

  get snapshot(): AutoPerformanceSnapshot {
    return this.makeSnapshot(false);
  }

  setPreset(preset: PerformancePreset | PerformanceSettings): AutoPerformanceSnapshot {
    const previousRuntime = this.currentRuntime();
    const previousPreset = this.settings.preset;
    this.settings = settingsForPresetInput(preset);
    this.stageIndex = BALANCED_STAGE_INDEX;
    this.clearEvidence();
    this.remainingCooldown = 0;
    this.latestStatus = null;
    const changed =
      previousPreset !== this.settings.preset ||
      runtimeSignature(previousRuntime) !== runtimeSignature(this.currentRuntime());
    return this.makeSnapshot(changed);
  }

  reset(): AutoPerformanceSnapshot {
    const previousRuntime = this.currentRuntime();
    this.stageIndex = BALANCED_STAGE_INDEX;
    this.clearEvidence();
    this.remainingCooldown = 0;
    this.latestStatus = null;
    return this.makeSnapshot(
      runtimeSignature(previousRuntime) !== runtimeSignature(this.currentRuntime()),
    );
  }

  observe(status: PerformanceHealthStatus): AutoPerformanceSnapshot {
    this.latestStatus = status;
    if (this.settings.preset !== 'auto') return this.makeSnapshot(false);

    this.sampleWindow.push(status);
    if (this.sampleWindow.length > AUTO_PERFORMANCE_SAMPLE_WINDOW) {
      this.sampleWindow.shift();
    }
    this.consecutiveGoodSamples = status === 'good'
      ? this.consecutiveGoodSamples + 1
      : 0;
    if (this.remainingCooldown > 0) this.remainingCooldown -= 1;

    if (this.remainingCooldown > 0) return this.makeSnapshot(false);

    const sustainedPressure =
      this.sampleWindow.length === AUTO_PERFORMANCE_SAMPLE_WINDOW &&
      this.sampleWindow.every((sample) => sample !== 'good');
    if (sustainedPressure && this.stageIndex < LOWEST_LOAD_STAGE_INDEX) {
      return this.changeStage(this.stageIndex + 1);
    }

    const recoveryThreshold = this.stageIndex === BALANCED_STAGE_INDEX
      ? AUTO_PERFORMANCE_QUALITY_HYSTERESIS_SAMPLES
      : AUTO_PERFORMANCE_RECOVERY_HYSTERESIS_SAMPLES;
    if (
      this.stageIndex > QUALITY_STAGE_INDEX &&
      this.consecutiveGoodSamples >= recoveryThreshold
    ) {
      return this.changeStage(this.stageIndex - 1);
    }

    return this.makeSnapshot(false);
  }

  private changeStage(nextStageIndex: number): AutoPerformanceSnapshot {
    this.stageIndex = nextStageIndex;
    this.clearEvidence();
    this.remainingCooldown = AUTO_PERFORMANCE_COOLDOWN_SAMPLES;
    return this.makeSnapshot(true);
  }

  private clearEvidence(): void {
    this.sampleWindow = [];
    this.consecutiveGoodSamples = 0;
  }

  private currentRuntime(): Readonly<AutoPerformanceRuntimeProfile> {
    if (this.settings.preset !== 'auto') return fixedRuntime(this.settings);
    const stage = AUTO_PERFORMANCE_STAGES[this.stageIndex];
    if (stage === undefined) throw new Error('Invalid Auto performance stage');
    return stageRuntime(stage);
  }

  private makeSnapshot(changed: boolean): AutoPerformanceSnapshot {
    const autoEnabled = this.settings.preset === 'auto';
    const runtime = this.currentRuntime();
    const pressureSampleCount = autoEnabled
      ? this.sampleWindow.filter((status) => status !== 'good').length
      : 0;
    const stage = autoEnabled ? AUTO_PERFORMANCE_STAGES[this.stageIndex]?.stage ?? null : null;
    return Object.freeze({
      preset: this.settings.preset,
      autoEnabled,
      stage,
      runtime,
      changed,
      lastStatus: this.latestStatus,
      sampleWindowCount: autoEnabled ? this.sampleWindow.length : 0,
      pressureSampleCount,
      goodStreak: autoEnabled ? this.consecutiveGoodSamples : 0,
      cooldownRemaining: autoEnabled ? this.remainingCooldown : 0,
    });
  }
}
