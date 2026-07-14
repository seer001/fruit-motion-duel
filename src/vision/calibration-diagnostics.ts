/** Legacy quality target retained for recorded fixtures; runtime uses preset policy. */
export const CALIBRATION_PERFORMANCE_TARGETS = {
  minimumFps: 20,
  maximumInferenceP95Ms: 45,
  maximumPipelineP95Ms: 100,
} as const;

const MINIMUM_PERFORMANCE_SAMPLES = 8;

export interface CalibrationPerformanceSnapshot {
  fps: number;
  inferenceP95Ms: number;
  pipelineP95Ms: number;
  sampleCount: number;
  ready: boolean;
  backend: 'gpu' | 'cpu' | 'starting';
}

export type CalibrationHealthCode =
  | 'measuring'
  | 'performance-insufficient'
  | 'only-one-person'
  | 'pairing-not-locked'
  | 'dominant-hand-missing'
  | 'calibration-threshold'
  | 'ready';

export interface CalibrationHealthInput {
  frameReceived?: boolean;
  expectedPlayers: number;
  rawPoseCount: number;
  acceptedCandidateCount: number;
  assignedPlayerCount: number;
  lockedPlayerCount: number;
  recognizedHandCount: number;
  calibrationStalled: boolean;
  performance: CalibrationPerformanceSnapshot;
}

export type CalibrationRecognitionInput = Omit<CalibrationHealthInput, 'performance'>;

export interface CalibrationHealthAssessment {
  code: CalibrationHealthCode;
  label: string;
  instruction: string;
}

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/**
 * Converts already-collected timing samples into a stable, low-cost status.
 * FPS is derived from result-to-result intervals, avoiding a false low-FPS
 * warning during the first fraction of a second after calibration opens.
 */
export function summarizeCalibrationPerformance(input: {
  inferenceSamples: readonly number[];
  pipelineSamples: readonly number[];
  inferenceTimestamps: readonly number[];
  nowMs: number;
  backend?: 'gpu' | 'cpu';
  minimumUsableFps?: number;
}): CalibrationPerformanceSnapshot {
  const recentTimestamps = input.inferenceTimestamps.filter(
    (timestamp) => timestamp >= input.nowMs - 3_000 && timestamp <= input.nowMs,
  );
  const intervals: number[] = [];
  for (let index = 1; index < recentTimestamps.length; index += 1) {
    const previous = recentTimestamps[index - 1];
    const current = recentTimestamps[index];
    if (previous !== undefined && current !== undefined && current > previous) {
      intervals.push(current - previous);
    }
  }
  const intervalWindow = intervals.slice(-30);
  const meanInterval = intervalWindow.length === 0
    ? 0
    : intervalWindow.reduce((total, value) => total + value, 0) / intervalWindow.length;
  const sampleCount = Math.min(
    input.inferenceSamples.length,
    input.pipelineSamples.length,
    recentTimestamps.length,
  );
  const recentInferenceSamples = input.inferenceSamples.slice(-recentTimestamps.length);
  const recentPipelineSamples = input.pipelineSamples.slice(-recentTimestamps.length);
  const clearlyBelowTarget =
    intervalWindow.length >= 2 &&
    meanInterval > 1_000 / (input.minimumUsableFps ?? CALIBRATION_PERFORMANCE_TARGETS.minimumFps);

  return {
    fps: meanInterval > 0 ? Math.min(99, 1_000 / meanInterval) : 0,
    inferenceP95Ms: percentile95(recentInferenceSamples.slice(-120)),
    pipelineP95Ms: percentile95(recentPipelineSamples.slice(-120)),
    sampleCount,
    ready:
      (sampleCount >= MINIMUM_PERFORMANCE_SAMPLES && intervalWindow.length >= 4) ||
      clearlyBelowTarget,
    backend: input.backend ?? 'starting',
  };
}

/** Recognition/calibration blockers are intentionally independent of timing. */
export function assessCalibrationRecognition(
  input: CalibrationRecognitionInput,
): CalibrationHealthAssessment {
  if (input.frameReceived === false) {
    return {
      code: 'measuring',
      label: `正在量測${input.expectedPlayers === 1 ? '單人' : '雙人'}辨識…`,
      instruction: input.expectedPlayers === 1
        ? '請留在畫面中央，穩定站立約 1 秒。'
        : '請兩人留在左右色區，穩定站立約 1 秒。',
    };
  }

  if (input.acceptedCandidateCount < input.expectedPlayers) {
    const detected = Math.min(input.rawPoseCount, input.acceptedCandidateCount);
    return {
      code: input.rawPoseCount < input.expectedPlayers
        ? 'only-one-person'
        : 'pairing-not-locked',
      label: input.rawPoseCount < input.expectedPlayers
        ? input.expectedPlayers === 2
          ? detected === 1
            ? '只偵測到一位玩家'
            : '尚未同時偵測到兩位玩家'
          : '尚未偵測到玩家'
        : '人體已偵測，但候選品質未通過',
      instruction: input.rawPoseCount < input.expectedPlayers
        ? '請拉開距離，讓兩人的頭、雙肩與手肘都完整入鏡。'
        : '模型看到了人體，但上半身可靠點不足；請面對鏡頭並露出頭部、雙肩與手肘。',
    };
  }

  if (
    input.assignedPlayerCount < input.expectedPlayers ||
    input.lockedPlayerCount < input.expectedPlayers
  ) {
    return {
      code: 'pairing-not-locked',
      label: '玩家配對尚未鎖定',
      instruction: '請各自留在左右色區；兩側可分開累積，完成後才會一次封存身份。',
    };
  }

  if (input.recognizedHandCount < input.expectedPlayers) {
    return {
      code: 'dominant-hand-missing',
      label: '主手未辨識',
      instruction: '請露出指定主手的肩、肘、腕，並讓拇指／食指／小指至少兩點清楚入鏡。',
    };
  }

  if (input.calibrationStalled) {
    return {
      code: 'calibration-threshold',
      label: '校正品質尚未通過',
      instruction: '請正面站立並暫停快速移動；耳距不足時會改以穩定頭肩與軀幹比例完成。',
    };
  }

  return {
    code: 'ready',
    label: input.expectedPlayers === 2 ? '雙人辨識正常' : '單人辨識正常',
    instruction: '身體、玩家身分與主手皆已穩定鎖定。',
  };
}

export function assessCalibrationHealth(
  input: CalibrationHealthInput,
): CalibrationHealthAssessment {
  if (!input.performance.ready) {
    return {
      code: 'measuring',
      label: `正在量測${input.expectedPlayers === 1 ? '單人' : '雙人'}辨識…`,
      instruction: input.expectedPlayers === 1
        ? '請留在畫面中央，穩定站立約 1 秒。'
        : '請兩人留在左右色區，穩定站立約 1 秒。',
    };
  }

  const recognition = assessCalibrationRecognition(input);
  if (recognition.code !== 'ready') return recognition;

  const performanceFailed =
    input.performance.fps < CALIBRATION_PERFORMANCE_TARGETS.minimumFps ||
    input.performance.inferenceP95Ms > CALIBRATION_PERFORMANCE_TARGETS.maximumInferenceP95Ms ||
    input.performance.pipelineP95Ms > CALIBRATION_PERFORMANCE_TARGETS.maximumPipelineP95Ms;
  if (performanceFailed) {
    return {
      code: 'performance-insufficient',
      label: '效能不足',
      instruction: '先關閉其他視訊程式與高負載分頁，並將鏡頭設為 720p30。',
    };
  }

  return recognition;
}
