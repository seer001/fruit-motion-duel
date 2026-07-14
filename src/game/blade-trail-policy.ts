import type { DominantHand, Lane, SliceTrail } from '../types/game';

export interface BladeOwnerPolicy {
  participantId: string;
  lane: Lane;
  activeHand: DominantHand;
}

function latestTimestamp(trail: SliceTrail): number {
  return trail.points.at(-1)?.timestampMs ?? Number.NEGATIVE_INFINITY;
}

function deliveryTimestamp(trail: SliceTrail): number {
  return trail.receivedAtMs ?? latestTimestamp(trail);
}

function preferTrail(current: SliceTrail | undefined, candidate: SliceTrail): SliceTrail {
  if (!current) return candidate;
  const timestampDifference = latestTimestamp(candidate) - latestTimestamp(current);
  if (timestampDifference !== 0) return timestampDifference > 0 ? candidate : current;
  return candidate.confidence > current.confidence ? candidate : current;
}

/**
 * Enforces the gameplay contract at the rendering/collision boundary: every
 * enrolled participant owns exactly one blade, and it must be their configured
 * active hand. A hand-less trail is accepted for pointer demo input only.
 */
export function selectActiveBladeTrails(
  trails: readonly SliceTrail[],
  owners: readonly BladeOwnerPolicy[],
): SliceTrail[] {
  const ownerById = new Map(owners.map((owner) => [owner.participantId, owner]));
  const selected = new Map<string, SliceTrail>();

  for (const trail of trails) {
    const owner = ownerById.get(trail.participantId);
    if (!owner || trail.lane !== owner.lane) continue;
    if (trail.hand !== undefined && trail.hand !== owner.activeHand) continue;
    selected.set(trail.participantId, preferTrail(selected.get(trail.participantId), trail));
  }

  // Owner order is stable even if MediaPipe returns candidates in a new order.
  return owners.flatMap(({ participantId }) => {
    const trail = selected.get(participantId);
    return trail ? [trail] : [];
  });
}

/**
 * Keeps the last valid blade visible through a brief missing inference frame.
 * This is display-only retention: no new segment is added, so it cannot create
 * a slice while the hand is missing and it expires with the normal trail TTL.
 */
export function stabilizeActiveBladeTrails(
  previousTrails: readonly SliceTrail[],
  incomingTrails: readonly SliceTrail[],
  owners: readonly BladeOwnerPolicy[],
  nowMs: number,
  retentionMs: number,
): SliceTrail[] {
  const incoming = new Map(
    selectActiveBladeTrails(incomingTrails, owners).map((trail) => [trail.participantId, trail]),
  );
  const previous = new Map(
    selectActiveBladeTrails(previousTrails, owners).map((trail) => [trail.participantId, trail]),
  );

  return owners.flatMap(({ participantId }) => {
    const current = incoming.get(participantId);
    if (current) return [current];
    const retained = previous.get(participantId);
    const ageMs = retained === undefined ? Number.POSITIVE_INFINITY : nowMs - deliveryTimestamp(retained);
    return retained && ageMs >= 0 && ageMs <= retentionMs ? [retained] : [];
  });
}

/** Selects newly delivered trails once, independently of their capture age. */
export function selectFreshUnconsumedBladeTrails(
  trails: readonly SliceTrail[],
  lastConsumedAtByParticipant: ReadonlyMap<string, number>,
  nowMs: number,
  freshnessMs: number,
): SliceTrail[] {
  return trails.filter((trail) => {
    const receivedAtMs = trail.receivedAtMs;
    if (receivedAtMs === undefined || !Number.isFinite(receivedAtMs)) return false;
    if (nowMs - receivedAtMs < 0 || nowMs - receivedAtMs > freshnessMs) return false;
    return receivedAtMs > (lastConsumedAtByParticipant.get(trail.participantId) ?? -1);
  });
}
