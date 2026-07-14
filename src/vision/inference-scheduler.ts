export type InferenceTargetFps = 15 | 20 | 24 | 30;

export function inferenceIntervalMs(targetFps: InferenceTargetFps): number {
  if (![15, 20, 24, 30].includes(targetFps)) {
    throw new RangeError('Inference target FPS must be 15, 20, 24, or 30');
  }
  return 1_000 / targetFps;
}

/**
 * A decoded camera frame is submitted at most once. The caller still owns the
 * single in-flight/latest-pending policy; this function only applies cadence.
 */
export function shouldSubmitInferenceFrame(
  timestampMs: number,
  lastSubmittedAtMs: number,
  targetFps: InferenceTargetFps,
): boolean {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(lastSubmittedAtMs)) {
    throw new RangeError('Inference timestamps must be finite');
  }
  return timestampMs - lastSubmittedAtMs >= inferenceIntervalMs(targetFps);
}
