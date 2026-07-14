export interface TrackingImpairment {
  participantId: string;
  unavailableForMs: number;
}

export interface TrackingSafetyAssessment {
  ignoredSpectators: number;
  knifeDisabledParticipantIds: string[];
  pauseParticipantIds: string[];
  mustPause: boolean;
}

export function hasVisionHeartbeatExpired(
  lastResultAtMs: number,
  nowMs: number,
  pauseAfterMs: number,
): boolean {
  if (
    !Number.isFinite(lastResultAtMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(pauseAfterMs) ||
    pauseAfterMs < 0
  ) {
    throw new RangeError('Vision heartbeat values must be finite and pauseAfterMs non-negative');
  }
  return nowMs >= lastResultAtMs && nowMs - lastResultAtMs >= pauseAfterMs;
}

/**
 * Spectators are intentionally diagnostic-only. They never pause a round;
 * only sustained loss of an enrolled participant can do that.
 */
export function assessTrackingSafety(
  impairments: readonly TrackingImpairment[],
  spectatorCount: number,
  pauseAfterMs: number,
): TrackingSafetyAssessment {
  if (!Number.isFinite(pauseAfterMs) || pauseAfterMs < 0) {
    throw new RangeError('pauseAfterMs must be a non-negative finite number');
  }
  const ignoredSpectators = Math.max(0, Math.floor(spectatorCount));
  const knifeDisabledParticipantIds = impairments.map(({ participantId }) => participantId);
  const pauseParticipantIds = impairments
    .filter(({ unavailableForMs }) => unavailableForMs >= pauseAfterMs)
    .map(({ participantId }) => participantId);
  return {
    ignoredSpectators,
    knifeDisabledParticipantIds,
    pauseParticipantIds,
    mustPause: pauseParticipantIds.length > 0,
  };
}
