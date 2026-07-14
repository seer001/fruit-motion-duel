import type {
  CalibrationProfile,
  DominantHand,
  Lane,
  Point,
  PoseObservation,
  PoseQualitySummary,
  TrackedPlayerPose,
} from '../types/game';
import { classifyDualLaneX, isInDualPlayerLane } from '../config/lanes';
import {
  getArmObservation,
  getHeadAnchor,
  getMultiJointPoseGeometry,
  landmarkConfidence,
  mirrorObservation,
  POSE_LANDMARK,
  type ArmObservation,
  type BodyDescriptor,
  type MultiJointPoseGeometry,
  type WristObservation,
} from './landmarks';

export interface PlayerTrackBinding {
  participantId: string;
  lane: Lane;
  activeHand: DominantHand;
}

export type PlayerTrackingState = 'acquiring' | 'tracking' | 'holding' | 'lost';

export interface PlayerTrackingResult extends TrackedPlayerPose {
  activeHand: DominantHand;
  state: PlayerTrackingState;
  sourceTemporaryId: string | null;
  /** Stable, pose-order-independent head trajectory used for identity binding. */
  headTrackletId: number | null;
  torsoCenter: Point | null;
  bodyAnchors: {
    headCenter: Point | null;
    shoulderCenter: Point | null;
    hipCenter: Point | null;
    trackingCenter: Point | null;
  };
  poseQuality: PoseQualitySummary | null;
  wrists: {
    left: WristObservation;
    right: WristObservation;
  };
  arms: {
    left: ArmObservation | null;
    right: ArmObservation | null;
  };
  observation: PoseObservation | null;
  identity: {
    /** True only after calibration profiles have been atomically sealed. */
    locked: boolean;
    /** True only when this frame passed the locked head-anchor match. */
    headMatched: boolean;
    state: 'unlocked' | 'locked' | 'occluded' | 'recalibration-required';
  };
}

export interface TrackerFrameResult {
  observedAt: number;
  players: [PlayerTrackingResult, PlayerTrackingResult];
  unassignedObservations: PoseObservation[];
  candidateDiagnostics: TrackerCandidateDiagnostics;
}

export interface SinglePlayerTrackerFrameResult {
  observedAt: number;
  player: PlayerTrackingResult;
  /** Tuple alias lets calibration and generic diagnostics share frame code. */
  players: [PlayerTrackingResult];
  unassignedObservations: PoseObservation[];
  candidateDiagnostics: TrackerCandidateDiagnostics;
}

export function hasFreshLockedIdentityFrame(
  frame: { observedAt: number; players: readonly PlayerTrackingResult[] } | null,
  participantIds: readonly string[],
  nowMs: number,
  maximumAgeMs: number,
): boolean {
  if (!frame || !Number.isFinite(nowMs) || maximumAgeMs < 0) return false;
  const ageMs = nowMs - frame.observedAt;
  if (ageMs < 0 || ageMs > maximumAgeMs) return false;
  return participantIds.every((participantId) =>
    frame.players.some(
      (player) =>
        player.participantId === participantId &&
        player.state === 'tracking' &&
        player.identity.locked &&
        player.identity.headMatched,
    ),
  );
}

/**
 * Separates an empty pose-model result from observations which reached the
 * tracker but were rejected by its body-quality gates. This is intentionally
 * lightweight so it can be sampled every frame by diagnostics without keeping
 * landmark arrays alive.
 */
export interface TrackerCandidateDiagnostics {
  inputObservationCount: number;
  acceptedCandidateCount: number;
  assignedCandidateCount: number;
  rejectedCandidateCount: number;
  /** Camera-space counts used by the two independent calibration cards. */
  laneDiagnostics: Record<Lane, TrackerLaneCandidateDiagnostics>;
  /** Quality-approved candidates inside the fail-closed centre safety region. */
  centerRejectedCandidateCount: number;
  /** Quality-approved candidates outside both player regions. */
  outsideLaneCandidateCount: number;
  rejectionReasons: {
    invalidGeometry: number;
    lowPoseQuality: number;
    insufficientReliableLandmarks: number;
    missingUpperBodyAnchor: number;
  };
}

export interface TrackerLaneCandidateDiagnostics {
  rawCandidateCount: number;
  acceptedCandidateCount: number;
  assignedCandidateCount: number;
  ambiguousCandidateCount: number;
}

export interface TwoPlayerTrackerOptions {
  mirrored?: boolean;
  allowBothWrists?: boolean;
  minimumPoseConfidence?: number;
  minimumWristConfidence?: number;
  minimumReliableLandmarks?: number;
  acquisitionFrames?: number;
  lostAfterMs?: number;
  /** Keep a confirmed identity template after the blade has entered `lost`. */
  identityRetentionMs?: number;
  maxMatchDistance?: number;
  ambiguityMargin?: number;
  laneWeight?: number;
  motionWeight?: number;
  geometryWeight?: number;
  maximumAssignmentCost?: number;
  velocitySmoothing?: number;
}

interface ResolvedTrackerOptions {
  mirrored: boolean;
  allowBothWrists: boolean;
  minimumPoseConfidence: number;
  minimumWristConfidence: number;
  minimumReliableLandmarks: number;
  acquisitionFrames: number;
  lostAfterMs: number;
  identityRetentionMs: number;
  maxMatchDistance: number;
  ambiguityMargin: number;
  laneWeight: number;
  motionWeight: number;
  geometryWeight: number;
  maximumAssignmentCost: number;
  velocitySmoothing: number;
}

interface DetectionCandidate {
  observation: PoseObservation;
  geometry: MultiJointPoseGeometry;
  sourceIndex: number;
  trackletId: number | null;
  trackletFrames: number;
}

interface CandidateCollection {
  candidates: DetectionCandidate[];
  diagnostics: Omit<TrackerCandidateDiagnostics, 'assignedCandidateCount'>;
}

interface TwoPlayerAssignment {
  assignments: [DetectionCandidate | null, DetectionCandidate | null];
  ambiguousCandidateCounts: Record<Lane, number>;
}

interface InternalTrack {
  binding: PlayerTrackBinding;
  confirmed: boolean;
  acquisitionCount: number;
  candidateCenter: Point | null;
  lastTrackingCenter: Point | null;
  velocity: Point;
  lastSeenAt: number | null;
  descriptor: BodyDescriptor | null;
  identityLock: LockedHeadIdentity | null;
  lastHeadCenter: Point | null;
  headVelocity: Point;
  lastHeadSeenAt: number | null;
  identityReacquisitionBlocked: boolean;
  identityNeedsRevalidation: boolean;
  pendingIdentityHead: Point | null;
  pendingIdentityCount: number;
  lastCandidateTrackletId: number | null;
  lockedTrackletId: number | null;
  blades: Record<DominantHand, BladeContinuityState>;
}

interface LockedHeadIdentity {
  headCenter: Point;
  headOffsetInShoulders: Point;
  headSpanToShoulderRatio: number | null;
  torsoToShoulderRatio: number;
  shoulderWidth: number;
  confidence: number;
}

interface BladeContinuityState {
  point: Point | null;
  observedAt: number | null;
  pendingPoint: Point | null;
  pendingCount: number;
}

// AppController renders confidence >= 0.45 while FruitDuelGame scores only
// confidence >= 0.55. A very short visual hold therefore removes cursor blink
// without allowing an unobserved point to cut fruit.
const DISPLAY_ONLY_BLADE_CONFIDENCE = 0.48;
const DISPLAY_ONLY_BLADE_HOLD_MS = 100;
const STRUCTURAL_HEAD_TRACKLET_CONFIDENCE = 0.22;
const LOCKED_HEAD_MINIMUM_CONFIDENCE = 0.22;
const LOCKED_IDENTITY_AMBIGUITY_MARGIN = 0.55;
const LOCKED_IDENTITY_MAXIMUM_SIGNATURE_COST = 0.58;
const LOCKED_IDENTITY_REVALIDATION_FRAMES = 3;

const DEFAULT_OPTIONS: ResolvedTrackerOptions = {
  mirrored: true,
  // Single dominant hand is the product-wide safety default. A caller must
  // explicitly opt in before a second blade can ever leave the tracker.
  allowBothWrists: false,
  // Multi-region scoring tolerates hidden hips while still requiring a stable
  // head/shoulder/arm structure. Wrist gating below remains stricter.
  minimumPoseConfidence: 0.38,
  minimumWristConfidence: 0.42,
  // Two people occupy fewer pixels each. A valid upper body can therefore
  // have only the two shoulders and two elbows above MediaPipe's 0.45
  // visibility line while the wrist remains usable through the supported-arm
  // gate below. Requiring five reliable points discarded both people before
  // calibration even though their geometry was stable.
  minimumReliableLandmarks: 4,
  acquisitionFrames: 3,
  lostAfterMs: 400,
  // Losing a scoring wrist and forgetting who the registered player is are
  // deliberately separate.  The former must stop the blade immediately; the
  // latter may survive a brief overlap/occlusion or a spectator walking past.
  identityRetentionMs: 2_500,
  maxMatchDistance: 0.34,
  ambiguityMargin: 0.12,
  laneWeight: 0.38,
  motionWeight: 0.4,
  geometryWeight: 0.34,
  maximumAssignmentCost: 1.5,
  velocitySmoothing: 0.35,
};

function resolveOptions(options: TwoPlayerTrackerOptions): ResolvedTrackerOptions {
  return { ...DEFAULT_OPTIONS, ...options };
}

function oppositeHand(hand: DominantHand): DominantHand {
  return hand === 'left' ? 'right' : 'left';
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function laneCenter(lane: Lane): number {
  return lane === 'left' ? 0.25 : 0.75;
}

function laneViolation(lane: Lane, x: number): boolean {
  return lane === 'left' ? x > 0.68 : x < 0.32;
}

function safeRatioDistance(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || value <= 0 || previous <= 0) return null;
  return Math.min(2, Math.abs(Math.log(value / previous)));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new RangeError('Cannot take the median of an empty list');
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function medianOrUndefined(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : median(values);
}

function createTrack(binding: PlayerTrackBinding): InternalTrack {
  return {
    binding: { ...binding },
    confirmed: false,
    acquisitionCount: 0,
    candidateCenter: null,
    lastTrackingCenter: null,
    velocity: { x: 0, y: 0 },
    lastSeenAt: null,
    descriptor: null,
    identityLock: null,
    lastHeadCenter: null,
    headVelocity: { x: 0, y: 0 },
    lastHeadSeenAt: null,
    identityReacquisitionBlocked: false,
    identityNeedsRevalidation: false,
    pendingIdentityHead: null,
    pendingIdentityCount: 0,
    lastCandidateTrackletId: null,
    lockedTrackletId: null,
    blades: {
      left: { point: null, observedAt: null, pendingPoint: null, pendingCount: 0 },
      right: { point: null, observedAt: null, pendingPoint: null, pendingCount: 0 },
    },
  };
}

function resetTrack(track: InternalTrack): void {
  track.confirmed = false;
  track.acquisitionCount = 0;
  track.candidateCenter = null;
  track.lastTrackingCenter = null;
  track.velocity = { x: 0, y: 0 };
  track.lastSeenAt = null;
  track.descriptor = null;
  track.identityLock = null;
  track.lastHeadCenter = null;
  track.headVelocity = { x: 0, y: 0 };
  track.lastHeadSeenAt = null;
  track.identityReacquisitionBlocked = false;
  track.identityNeedsRevalidation = false;
  track.pendingIdentityHead = null;
  track.pendingIdentityCount = 0;
  track.lastCandidateTrackletId = null;
  track.lockedTrackletId = null;
  for (const blade of Object.values(track.blades)) {
    blade.point = null;
    blade.observedAt = null;
    blade.pendingPoint = null;
    blade.pendingCount = 0;
  }
}

function expireIdentity(track: InternalTrack): void {
  if (track.identityLock !== null) {
    // A calibrated identity is never silently downgraded to lane-only
    // acquisition. After a long loss, only an explicit recalibration can
    // authorize a new subject for this participant.
    track.identityReacquisitionBlocked = true;
    track.candidateCenter = null;
    track.lastTrackingCenter = null;
    track.velocity = { x: 0, y: 0 };
    track.headVelocity = { x: 0, y: 0 };
    track.identityNeedsRevalidation = true;
    track.pendingIdentityHead = null;
    track.pendingIdentityCount = 0;
    for (const blade of Object.values(track.blades)) {
      blade.point = null;
      blade.observedAt = null;
      blade.pendingPoint = null;
      blade.pendingCount = 0;
    }
    return;
  }
  track.confirmed = false;
  track.acquisitionCount = 0;
  track.candidateCenter = null;
  track.lastTrackingCenter = null;
  track.velocity = { x: 0, y: 0 };
  track.descriptor = null;
  track.identityNeedsRevalidation = false;
  track.pendingIdentityHead = null;
  track.pendingIdentityCount = 0;
  track.lastCandidateTrackletId = null;
  track.lockedTrackletId = null;
  for (const blade of Object.values(track.blades)) {
    blade.point = null;
    blade.observedAt = null;
    blade.pendingPoint = null;
    blade.pendingCount = 0;
  }
}

function descriptorDistance(current: BodyDescriptor, previous: BodyDescriptor | null): number {
  if (previous === null) return 0;
  const currentScale = current.shoulderWidth ?? current.torsoLength;
  const previousScale = previous.shoulderWidth ?? previous.torsoLength;
  const ratio = (value: number | null, scale: number | null): number | null =>
    value === null || scale === null || scale <= 0 ? null : value / scale;
  // Ratios are much more useful than raw image sizes when a player leans
  // toward the camera.  A small absolute-size term still helps distinguish a
  // nearby spectator whose proportions happen to be similar.
  const comparisons: Array<[number | null, number | null, number]> = [
    [ratio(current.headSpan, currentScale), ratio(previous.headSpan, previousScale), 1.35],
    [ratio(current.hipWidth, currentScale), ratio(previous.hipWidth, previousScale), 1.05],
    [ratio(current.torsoLength, currentScale), ratio(previous.torsoLength, previousScale), 1.25],
    [ratio(current.headToShoulder, currentScale), ratio(previous.headToShoulder, previousScale), 0.9],
    [ratio(current.leftUpperArm, currentScale), ratio(previous.leftUpperArm, previousScale), 0.8],
    [ratio(current.rightUpperArm, currentScale), ratio(previous.rightUpperArm, previousScale), 0.8],
    [ratio(current.leftForearm, currentScale), ratio(previous.leftForearm, previousScale), 0.45],
    [ratio(current.rightForearm, currentScale), ratio(previous.rightForearm, previousScale), 0.45],
    [currentScale, previousScale, 0.28],
  ];
  let weightedDistance = 0;
  let totalWeight = 0;
  for (const [value, stored, weight] of comparisons) {
    const difference = safeRatioDistance(value, stored);
    if (difference === null) continue;
    weightedDistance += difference * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedDistance / totalWeight;
}

function blendDescriptor(
  previous: BodyDescriptor | null,
  current: BodyDescriptor,
  alpha = 0.22,
): BodyDescriptor {
  if (previous === null) return { ...current };
  const blend = (oldValue: number | null, value: number | null): number | null => {
    if (value === null) return oldValue;
    if (oldValue === null) return value;
    return oldValue * (1 - alpha) + value * alpha;
  };
  return {
    shoulderWidth: blend(previous.shoulderWidth, current.shoulderWidth),
    headSpan: blend(previous.headSpan, current.headSpan),
    hipWidth: blend(previous.hipWidth, current.hipWidth),
    torsoLength: blend(previous.torsoLength, current.torsoLength),
    headToShoulder: blend(previous.headToShoulder, current.headToShoulder),
    leftUpperArm: blend(previous.leftUpperArm, current.leftUpperArm),
    rightUpperArm: blend(previous.rightUpperArm, current.rightUpperArm),
    leftForearm: blend(previous.leftForearm, current.leftForearm),
    rightForearm: blend(previous.rightForearm, current.rightForearm),
  };
}

function toLockedHeadIdentity(profile: CalibrationProfile): LockedHeadIdentity {
  const anchor = profile.identityAnchor;
  if (anchor === undefined || profile.headCenter === undefined) {
    throw new Error(`Participant ${profile.participantId} has no calibrated head identity anchor`);
  }
  if (
    profile.shoulderWidth <= 0 ||
    !Number.isFinite(anchor.headCenter.x) ||
    !Number.isFinite(anchor.headCenter.y)
  ) {
    throw new Error(`Participant ${profile.participantId} has an invalid head identity anchor`);
  }
  return {
    headCenter: { ...anchor.headCenter },
    headOffsetInShoulders: { ...anchor.headOffsetInShoulders },
    headSpanToShoulderRatio: anchor.headSpanToShoulderRatio ?? null,
    torsoToShoulderRatio: anchor.torsoToShoulderRatio,
    shoulderWidth: profile.shoulderWidth,
    confidence: anchor.confidence,
  };
}

function applyIdentityLock(track: InternalTrack, profile: CalibrationProfile): void {
  if (profile.participantId !== track.binding.participantId || profile.lane !== track.binding.lane) {
    throw new Error(`Calibration profile does not match participant ${track.binding.participantId}`);
  }
  const identityLock = toLockedHeadIdentity(profile);
  if (track.lastCandidateTrackletId === null) {
    throw new Error(`Participant ${profile.participantId} has no stable head tracklet`);
  }
  track.identityLock = identityLock;
  track.lockedTrackletId = track.lastCandidateTrackletId;
  track.confirmed = true;
  track.acquisitionCount = 0;
  track.candidateCenter = identityLock.headCenter;
  track.lastTrackingCenter = identityLock.headCenter;
  track.velocity = { x: 0, y: 0 };
  track.lastHeadCenter = identityLock.headCenter;
  track.headVelocity = { x: 0, y: 0 };
  track.lastHeadSeenAt = profile.capturedAt;
  track.lastSeenAt = profile.capturedAt;
  track.identityReacquisitionBlocked = false;
  track.identityNeedsRevalidation = false;
  track.pendingIdentityHead = null;
  track.pendingIdentityCount = 0;
  for (const blade of Object.values(track.blades)) {
    blade.point = null;
    blade.observedAt = null;
    blade.pendingPoint = null;
    blade.pendingCount = 0;
  }
}

function lockedIdentitySignatureCost(
  identity: LockedHeadIdentity,
  geometry: MultiJointPoseGeometry,
): number {
  const shoulderWidth = geometry.shoulderWidth;
  const headCenter = geometry.headCenter;
  if (shoulderWidth <= 0 || headCenter === null) return Number.POSITIVE_INFINITY;
  const currentHeadOffset = {
    x: (headCenter.x - geometry.shoulderCenter.x) / shoulderWidth,
    y: (headCenter.y - geometry.shoulderCenter.y) / shoulderWidth,
  };
  const currentHeadSpanRatio = geometry.headSpan === null
    ? null
    : geometry.headSpan / shoulderWidth;
  const currentTorsoRatio = geometry.quality.hipConfidence >= 0.25
    ? geometry.torsoLength / shoulderWidth
    : null;
  const comparisons: Array<[number | null, number | null, number]> = [
    [currentHeadOffset.x, identity.headOffsetInShoulders.x, 1.15],
    [currentHeadOffset.y, identity.headOffsetInShoulders.y, 1.45],
    [currentHeadSpanRatio, identity.headSpanToShoulderRatio, 1.65],
    [currentTorsoRatio, identity.torsoToShoulderRatio, 0.85],
  ];
  let weightedDistance = 0;
  let totalWeight = 0;
  for (const [current, calibrated, weight] of comparisons) {
    if (current === null || calibrated === null) continue;
    weightedDistance += Math.min(2, Math.abs(current - calibrated)) * weight;
    totalWeight += weight;
  }
  const scaleDistance = safeRatioDistance(shoulderWidth, identity.shoulderWidth) ?? 0;
  weightedDistance += scaleDistance * 0.35;
  totalWeight += 0.35;
  return totalWeight === 0 ? Number.POSITIVE_INFINITY : weightedDistance / totalWeight;
}

interface HeadTracklet {
  id: number;
  headCenter: Point;
  velocity: Point;
  lastSeenAt: number;
  descriptor: BodyDescriptor;
  shoulderWidth: number;
  consecutiveFrames: number;
}

function headTrackletSignatureCost(
  tracklet: HeadTracklet,
  geometry: MultiJointPoseGeometry,
): number {
  const currentScale = geometry.shoulderWidth;
  const storedScale = tracklet.shoulderWidth;
  if (currentScale <= 0 || storedScale <= 0) return Number.POSITIVE_INFINITY;
  const ratio = (value: number | null, scale: number): number | null =>
    value === null ? null : value / scale;
  const comparisons: Array<[number | null, number | null, number]> = [
    [ratio(geometry.descriptor.headSpan, currentScale), ratio(tracklet.descriptor.headSpan, storedScale), 1.6],
    [ratio(geometry.descriptor.torsoLength, currentScale), ratio(tracklet.descriptor.torsoLength, storedScale), 1.05],
    [ratio(geometry.descriptor.hipWidth, currentScale), ratio(tracklet.descriptor.hipWidth, storedScale), 0.55],
    [ratio(geometry.descriptor.headToShoulder, currentScale), ratio(tracklet.descriptor.headToShoulder, storedScale), 1.25],
  ];
  let weightedDistance = 0;
  let totalWeight = 0;
  for (const [current, stored, weight] of comparisons) {
    if (current === null || stored === null) continue;
    weightedDistance += Math.min(2, Math.abs(current - stored)) * weight;
    totalWeight += weight;
  }
  const scaleDistance = safeRatioDistance(currentScale, storedScale) ?? 0;
  weightedDistance += scaleDistance * 0.3;
  totalWeight += 0.3;
  return totalWeight === 0 ? Number.POSITIVE_INFINITY : weightedDistance / totalWeight;
}

/**
 * Maintains pose-order-independent head trajectories for every person in the
 * frame. Player identities bind to one of these IDs during calibration; a
 * trajectory first observed as a spectator can therefore never be promoted
 * merely by walking into a player's old screen position.
 */
class HeadTrackletRegistry {
  private readonly tracklets: HeadTracklet[] = [];
  private nextId = 1;

  reset(): void {
    this.tracklets.length = 0;
    this.nextId = 1;
  }

  update(candidates: readonly DetectionCandidate[], timestampMs: number): DetectionCandidate[] {
    const activeTracklets = this.tracklets.filter(
      ({ lastSeenAt }) => timestampMs - lastSeenAt <= 5_000,
    );
    this.tracklets.splice(0, this.tracklets.length, ...activeTracklets);

    interface Pair {
      candidateIndex: number;
      tracklet: HeadTracklet;
      cost: number;
    }
    const pairs: Pair[] = [];
    candidates.forEach((candidate, candidateIndex) => {
      const headCenter = candidate.geometry.headCenter;
      if (
        headCenter === null ||
        candidate.geometry.quality.headConfidence < STRUCTURAL_HEAD_TRACKLET_CONFIDENCE
      ) return;
      for (const tracklet of activeTracklets) {
        const elapsedSeconds = Math.min(
          0.65,
          Math.max(0, timestampMs - tracklet.lastSeenAt) / 1000,
        );
        const predicted = {
          x: tracklet.headCenter.x + tracklet.velocity.x * elapsedSeconds,
          y: tracklet.headCenter.y + tracklet.velocity.y * elapsedSeconds,
        };
        const referenceScale = Math.max(
          0.05,
          tracklet.shoulderWidth,
          candidate.geometry.shoulderWidth,
        );
        const allowedDistance = Math.min(
          0.24,
          Math.max(0.08, referenceScale * 1.45) + elapsedSeconds * 0.15,
        );
        const distance = pointDistance(predicted, headCenter);
        if (distance > allowedDistance) continue;
        const signatureCost = headTrackletSignatureCost(tracklet, candidate.geometry);
        if (!Number.isFinite(signatureCost) || signatureCost > 0.62) continue;
        pairs.push({
          candidateIndex,
          tracklet,
          cost: distance / allowedDistance * 0.74 + signatureCost * 0.58,
        });
      }
    });

    const usedTracklets = new Set<number>();
    const matchedCandidates = new Set<number>();
    const orderedPairs = [...pairs].sort((a, b) => a.cost - b.cost);
    for (const pair of orderedPairs) {
      if (
        matchedCandidates.has(pair.candidateIndex) ||
        usedTracklets.has(pair.tracklet.id)
      ) continue;
      const candidateAlternatives = pairs
        .filter(({ candidateIndex }) => candidateIndex === pair.candidateIndex)
        .sort((a, b) => a.cost - b.cost);
      const trackletAlternatives = pairs
        .filter(({ tracklet }) => tracklet.id === pair.tracklet.id)
        .sort((a, b) => a.cost - b.cost);
      const candidateAmbiguous =
        candidateAlternatives[1] !== undefined &&
        candidateAlternatives[1]!.cost - pair.cost < 0.1;
      const trackletAmbiguous =
        trackletAlternatives[1] !== undefined &&
        trackletAlternatives[1]!.cost - pair.cost < 0.1;
      if (candidateAmbiguous || trackletAmbiguous) continue;

      const candidate = candidates[pair.candidateIndex];
      const headCenter = candidate?.geometry.headCenter;
      if (!candidate || headCenter === null || headCenter === undefined) continue;
      const elapsedSeconds = Math.max(0, timestampMs - pair.tracklet.lastSeenAt) / 1000;
      if (elapsedSeconds > 0) {
        const measuredVelocity = {
          x: (headCenter.x - pair.tracklet.headCenter.x) / elapsedSeconds,
          y: (headCenter.y - pair.tracklet.headCenter.y) / elapsedSeconds,
        };
        pair.tracklet.velocity = {
          x: pair.tracklet.velocity.x * 0.6 + measuredVelocity.x * 0.4,
          y: pair.tracklet.velocity.y * 0.6 + measuredVelocity.y * 0.4,
        };
      }
      pair.tracklet.consecutiveFrames =
        timestampMs - pair.tracklet.lastSeenAt <= 160
          ? pair.tracklet.consecutiveFrames + 1
          : 1;
      pair.tracklet.headCenter = headCenter;
      pair.tracklet.lastSeenAt = timestampMs;
      pair.tracklet.shoulderWidth =
        pair.tracklet.shoulderWidth * 0.88 + candidate.geometry.shoulderWidth * 0.12;
      pair.tracklet.descriptor = blendDescriptor(
        pair.tracklet.descriptor,
        candidate.geometry.descriptor,
        0.12,
      );
      candidate.trackletId = pair.tracklet.id;
      candidate.trackletFrames = pair.tracklet.consecutiveFrames;
      usedTracklets.add(pair.tracklet.id);
      matchedCandidates.add(pair.candidateIndex);
    }

    candidates.forEach((candidate, candidateIndex) => {
      if (matchedCandidates.has(candidateIndex)) return;
      const headCenter = candidate.geometry.headCenter;
      if (
        headCenter === null ||
        candidate.geometry.quality.headConfidence < STRUCTURAL_HEAD_TRACKLET_CONFIDENCE
      ) return;
      const tracklet: HeadTracklet = {
        id: this.nextId++,
        headCenter,
        velocity: { x: 0, y: 0 },
        lastSeenAt: timestampMs,
        descriptor: { ...candidate.geometry.descriptor },
        shoulderWidth: candidate.geometry.shoulderWidth,
        consecutiveFrames: 1,
      };
      this.tracklets.push(tracklet);
      candidate.trackletId = tracklet.id;
      candidate.trackletFrames = 1;
    });

    if (this.tracklets.length > 24) {
      this.tracklets.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      this.tracklets.length = 24;
    }
    return candidates as DetectionCandidate[];
  }
}

/**
 * Identity and calibration depend on a stable upper-body outline, not on both
 * players keeping six tiny finger endpoints and both hips visible. At a wide
 * two-player camera framing those small landmarks are the first ones to lose
 * confidence, even while shoulders and elbows remain reliable.
 */
function upperBodyStructuralConfidence(quality: PoseQualitySummary): number {
  return (
    quality.shoulderConfidence * 0.55 +
    quality.elbowConfidence * 0.3 +
    Math.max(quality.headConfidence, quality.hipConfidence) * 0.15
  );
}

function emptyLaneCandidateDiagnostics(): TrackerLaneCandidateDiagnostics {
  return {
    rawCandidateCount: 0,
    acceptedCandidateCount: 0,
    assignedCandidateCount: 0,
    ambiguousCandidateCount: 0,
  };
}

function cloneLaneDiagnostics(
  diagnostics: Record<Lane, TrackerLaneCandidateDiagnostics>,
): Record<Lane, TrackerLaneCandidateDiagnostics> {
  return {
    left: { ...diagnostics.left },
    right: { ...diagnostics.right },
  };
}

function createCandidates(
  observations: readonly PoseObservation[],
  options: ResolvedTrackerOptions,
  collectDualLaneDiagnostics = false,
): CandidateCollection {
  const candidates: DetectionCandidate[] = [];
  const laneDiagnostics: Record<Lane, TrackerLaneCandidateDiagnostics> = {
    left: emptyLaneCandidateDiagnostics(),
    right: emptyLaneCandidateDiagnostics(),
  };
  let centerRejectedCandidateCount = 0;
  let outsideLaneCandidateCount = 0;
  const rejectionReasons = {
    invalidGeometry: 0,
    lowPoseQuality: 0,
    insufficientReliableLandmarks: 0,
    missingUpperBodyAnchor: 0,
  };
  observations.forEach((sourceObservation, sourceIndex) => {
    const transformed = options.mirrored ? mirrorObservation(sourceObservation) : sourceObservation;
    if (collectDualLaneDiagnostics) {
      const rawRegion = classifyDualLaneX(getHeadAnchor(transformed).center?.x ?? Number.NaN);
      if (rawRegion === 'left' || rawRegion === 'right') {
        laneDiagnostics[rawRegion].rawCandidateCount += 1;
      }
    }
    const geometry = getMultiJointPoseGeometry(transformed);
    if (geometry === null) {
      rejectionReasons.invalidGeometry += 1;
      return;
    }
    const quality = geometry.quality;
    const trackingQuality = Math.max(
      quality.score,
      upperBodyStructuralConfidence(quality),
    );
    const hasUpperBodyAnchor =
      quality.shoulderConfidence >= 0.28 ||
      (quality.headConfidence >= 0.42 && quality.elbowConfidence >= 0.38);
    const hasHeadShoulderIdentityStructure =
      quality.headConfidence >= 0.3 && quality.shoulderConfidence >= 0.45;
    if (trackingQuality < options.minimumPoseConfidence) {
      rejectionReasons.lowPoseQuality += 1;
      return;
    }
    if (
      quality.reliableLandmarkCount < options.minimumReliableLandmarks &&
      !hasHeadShoulderIdentityStructure
    ) {
      rejectionReasons.insufficientReliableLandmarks += 1;
      return;
    }
    if (!hasUpperBodyAnchor) {
      rejectionReasons.missingUpperBodyAnchor += 1;
      return;
    }
    const observation: PoseObservation = {
      ...transformed,
      // Prefer the deterministic 17-anchor score to the old four-torso-point score.
      score: quality.score,
      torsoCenter: geometry.torsoCenter,
      quality,
    };
    candidates.push({
      observation,
      geometry,
      sourceIndex,
      trackletId: null,
      trackletFrames: 0,
    });
  });
  candidates.sort((a, b) => b.geometry.quality.score - a.geometry.quality.score);
  // MediaPipe may return the registered players plus nearby spectators.  Keep
  // every supported model candidate here; assignment below chooses at most two.
  const keptCandidates = candidates.slice(0, 4);
  if (collectDualLaneDiagnostics) {
    centerRejectedCandidateCount = 0;
    outsideLaneCandidateCount = 0;
    for (const candidate of keptCandidates) {
      const acceptedRegion = classifyDualLaneX(candidate.geometry.headCenter?.x ?? Number.NaN);
      if (acceptedRegion === 'left' || acceptedRegion === 'right') {
        laneDiagnostics[acceptedRegion].acceptedCandidateCount += 1;
      } else if (acceptedRegion === 'center') {
        centerRejectedCandidateCount += 1;
      } else {
        outsideLaneCandidateCount += 1;
      }
    }
  }
  return {
    candidates: keptCandidates,
    diagnostics: {
      inputObservationCount: observations.length,
      acceptedCandidateCount: keptCandidates.length,
      rejectedCandidateCount: observations.length - keptCandidates.length,
      laneDiagnostics,
      centerRejectedCandidateCount,
      outsideLaneCandidateCount,
      rejectionReasons,
    },
  };
}

function assignmentCost(
  track: InternalTrack,
  candidate: DetectionCandidate,
  timestampMs: number,
  options: ResolvedTrackerOptions,
  enforceUnlockedDualLane = false,
): number {
  if (
    candidate.trackletId === null ||
    (!track.confirmed && candidate.trackletFrames < options.acquisitionFrames) ||
    (
      track.lastCandidateTrackletId !== null &&
      candidate.trackletId !== track.lastCandidateTrackletId
    )
  ) {
    return Number.POSITIVE_INFINITY;
  }
  if (
    enforceUnlockedDualLane &&
    track.identityLock === null &&
    (
      candidate.geometry.headCenter === null ||
      !isInDualPlayerLane(track.binding.lane, candidate.geometry.headCenter.x)
    )
  ) {
    return Number.POSITIVE_INFINITY;
  }
  if (track.identityLock !== null) {
    if (
      track.lockedTrackletId === null ||
      candidate.trackletId !== track.lockedTrackletId
    ) {
      return Number.POSITIVE_INFINITY;
    }
    if (track.identityReacquisitionBlocked) return Number.POSITIVE_INFINITY;
    const headCenter = candidate.geometry.headCenter;
    if (
      headCenter === null ||
      candidate.geometry.quality.headConfidence < LOCKED_HEAD_MINIMUM_CONFIDENCE
    ) {
      return Number.POSITIVE_INFINITY;
    }
    const signatureCost = lockedIdentitySignatureCost(track.identityLock, candidate.geometry);
    if (
      !Number.isFinite(signatureCost) ||
      signatureCost > LOCKED_IDENTITY_MAXIMUM_SIGNATURE_COST
    ) {
      return Number.POSITIVE_INFINITY;
    }

    const referenceHead = track.lastHeadCenter ?? track.identityLock.headCenter;
    const lastHeadAt = track.lastHeadSeenAt ?? track.lastSeenAt;
    const elapsedSeconds = lastHeadAt === null
      ? 0
      : Math.min(0.65, Math.max(0, timestampMs - lastHeadAt) / 1000);
    const predictedHead = {
      x: referenceHead.x + track.headVelocity.x * elapsedSeconds,
      y: referenceHead.y + track.headVelocity.y * elapsedSeconds,
    };
    const headDistance = pointDistance(predictedHead, headCenter);
    const referenceScale = Math.max(
      0.055,
      track.identityLock.shoulderWidth,
      candidate.geometry.shoulderWidth,
    );
    const allowedDistance = Math.min(
      0.27,
      Math.max(0.105, referenceScale * 1.75) + elapsedSeconds * 0.16,
    );
    if (headDistance > allowedDistance) return Number.POSITIVE_INFINITY;

    const normalizedHeadMotion = headDistance / allowedDistance;
    const calibratedPositionDistance = pointDistance(
      track.identityLock.headCenter,
      headCenter,
    );
    const calibratedPositionCost = Math.min(
      1.5,
      calibratedPositionDistance / Math.max(0.16, referenceScale * 2.4),
    );
    const lanePenalty = laneViolation(track.binding.lane, headCenter.x) ? 0.2 : 0;
    const confidencePenalty =
      (1 - candidate.geometry.quality.headConfidence) * 0.08;
    return (
      normalizedHeadMotion * 0.72 +
      signatureCost * 0.52 +
      calibratedPositionCost * 0.08 +
      lanePenalty +
      confidencePenalty
    );
  }

  const center = candidate.geometry.trackingCenter;
  const normalizedLaneDistance = Math.abs(center.x - laneCenter(track.binding.lane)) / 0.5;
  const identityKnown = track.confirmed && track.descriptor !== null;
  // Lanes are a strong acquisition hint, not a permanent identity. Once a
  // player is registered, motion and body proportions must win when players
  // cross or overlap.
  const laneInfluence = identityKnown ? 0.14 : 1;
  const oppositeLanePenalty = laneViolation(track.binding.lane, center.x)
    ? identityKnown
      ? 0.14
      : 1.75
    : 0;
  let motionCost = 0;

  if (track.lastTrackingCenter !== null && track.lastSeenAt !== null) {
    const elapsedSeconds = Math.min(0.5, Math.max(0, timestampMs - track.lastSeenAt) / 1000);
    const predicted = {
      x: track.lastTrackingCenter.x + track.velocity.x * elapsedSeconds,
      y: track.lastTrackingCenter.y + track.velocity.y * elapsedSeconds,
    };
    const distance = pointDistance(predicted, center);
    const wasLost = timestampMs - track.lastSeenAt >= options.lostAfterMs;
    if (!wasLost && distance > options.maxMatchDistance * 1.5) {
      return Number.POSITIVE_INFINITY;
    }
    motionCost = Math.min(2, distance / options.maxMatchDistance);
  }

  const geometryCost = descriptorDistance(candidate.geometry.descriptor, track.descriptor);
  const confidencePenalty = (1 - candidate.geometry.quality.score) * 0.12;
  return (
    normalizedLaneDistance * options.laneWeight * laneInfluence +
    motionCost * options.motionWeight +
    geometryCost * options.geometryWeight +
    oppositeLanePenalty +
    confidencePenalty
  );
}

function bladeReferenceLength(geometry: MultiJointPoseGeometry, arm: ArmObservation): number {
  const upperArm =
    arm.shoulder.point === null || arm.elbow.point === null
      ? 0
      : pointDistance(arm.shoulder.point, arm.elbow.point);
  return Math.max(0.045, geometry.shoulderWidth, upperArm);
}

/**
 * Rejects one-frame hand teleports without low-pass filtering legitimate fast
 * swings. A stable relocated point can be reacquired after three observations;
 * rejected frames always return null and therefore can never cut fruit.
 */
function guardedBladePoint(
  track: InternalTrack,
  hand: DominantHand,
  arm: ArmObservation,
  geometry: MultiJointPoseGeometry,
  timestampMs: number,
): Point | null {
  const state = track.blades[hand];
  const point = arm.bladePoint;
  if (point === null) {
    state.pendingPoint = null;
    state.pendingCount = 0;
    return null;
  }

  const reference = bladeReferenceLength(geometry, arm);
  const elbowDistance = arm.elbow.point === null ? 0 : pointDistance(arm.elbow.point, point);
  const shoulderDistance =
    arm.shoulder.point === null ? 0 : pointDistance(arm.shoulder.point, point);
  const anatomicallyPossible =
    elbowDistance <= Math.max(0.2, reference * 2.65) &&
    shoulderDistance <= Math.max(0.3, reference * 4.2);
  if (!anatomicallyPossible) {
    state.pendingPoint = null;
    state.pendingCount = 0;
    return null;
  }

  let continuous = true;
  if (state.point !== null && state.observedAt !== null) {
    const elapsedMs = Math.max(0, timestampMs - state.observedAt);
    if (elapsedMs <= 260) {
      // At 30 FPS this permits a vigorous ~0.15-normalized-unit swing while
      // rejecting a hand that teleports across most of the picture.
      const maximumTravel =
        Math.max(0.055, reference * 0.72) +
        (elapsedMs / 1000) * Math.max(3.2, reference * 22);
      continuous = pointDistance(state.point, point) <= maximumTravel;
    }
  }

  if (!continuous) {
    const pendingTolerance = Math.max(0.035, reference * 0.62);
    if (
      state.pendingPoint !== null &&
      pointDistance(state.pendingPoint, point) <= pendingTolerance
    ) {
      state.pendingCount += 1;
      state.pendingPoint = {
        x: state.pendingPoint.x * 0.55 + point.x * 0.45,
        y: state.pendingPoint.y * 0.55 + point.y * 0.45,
      };
    } else {
      state.pendingPoint = point;
      state.pendingCount = 1;
    }
    if (state.pendingCount < 3) return null;
  }

  state.point = point;
  state.observedAt = timestampMs;
  state.pendingPoint = null;
  state.pendingCount = 0;
  return point;
}

/**
 * Keeps the cursor visible for at most a few display frames when the current
 * body is still assigned but its fast hand briefly drops below visibility.
 * `observedAt` is deliberately not advanced, so this can never become an
 * indefinitely refreshed ghost point. The caller also emits a non-scoring
 * confidence while using it.
 */
function displayOnlyHeldBladePoint(
  track: InternalTrack,
  hand: DominantHand,
  timestampMs: number,
): Point | null {
  const state = track.blades[hand];
  if (state.point === null || state.observedAt === null) return null;
  const ageMs = timestampMs - state.observedAt;
  return ageMs >= 0 && ageMs <= DISPLAY_ONLY_BLADE_HOLD_MS ? state.point : null;
}

function emptyAnchors(): PlayerTrackingResult['bodyAnchors'] {
  return {
    headCenter: null,
    shoulderCenter: null,
    hipCenter: null,
    trackingCenter: null,
  };
}

function missingResult(
  track: InternalTrack,
  timestampMs: number,
  options: ResolvedTrackerOptions,
  markForRevalidation = true,
): PlayerTrackingResult {
  if (
    markForRevalidation &&
    track.identityLock !== null &&
    !track.identityReacquisitionBlocked
  ) {
    track.identityNeedsRevalidation = true;
    track.pendingIdentityHead = null;
    track.pendingIdentityCount = 0;
  }
  const lostForMs = track.lastSeenAt === null ? 0 : timestampMs - track.lastSeenAt;
  const wasEverSeen = track.lastSeenAt !== null;
  const isHolding = track.confirmed && lostForMs < options.lostAfterMs;
  if (track.confirmed && wasEverSeen && lostForMs >= options.identityRetentionMs) {
    expireIdentity(track);
  }
  return {
    participantId: track.binding.participantId,
    lane: track.binding.lane,
    activeHand: track.binding.activeHand,
    confidence: 0,
    activeWrist: null,
    otherWrist: null,
    observedAt: timestampMs,
    lostForMs,
    state: isHolding ? 'holding' : wasEverSeen ? 'lost' : 'acquiring',
    sourceTemporaryId: null,
    headTrackletId: null,
    torsoCenter: null,
    bodyAnchors: emptyAnchors(),
    poseQuality: null,
    wrists: {
      left: { point: null, confidence: 0 },
      right: { point: null, confidence: 0 },
    },
    arms: { left: null, right: null },
    observation: null,
    identity: {
      locked: track.identityLock !== null,
      headMatched: false,
      state: track.identityLock === null
        ? 'unlocked'
        : track.identityReacquisitionBlocked
          ? 'recalibration-required'
          : 'occluded',
    },
  };
}

function lockedIdentityRevalidated(
  track: InternalTrack,
  candidate: DetectionCandidate,
): boolean {
  if (track.identityLock === null || !track.identityNeedsRevalidation) return true;
  const headCenter = candidate.geometry.headCenter;
  if (headCenter === null) return false;
  const tolerance = Math.max(0.04, candidate.geometry.shoulderWidth * 0.72);
  if (
    track.pendingIdentityHead !== null &&
    pointDistance(track.pendingIdentityHead, headCenter) <= tolerance
  ) {
    track.pendingIdentityCount += 1;
    track.pendingIdentityHead = {
      x: track.pendingIdentityHead.x * 0.55 + headCenter.x * 0.45,
      y: track.pendingIdentityHead.y * 0.55 + headCenter.y * 0.45,
    };
  } else {
    track.pendingIdentityHead = headCenter;
    track.pendingIdentityCount = 1;
  }
  if (track.pendingIdentityCount < LOCKED_IDENTITY_REVALIDATION_FRAMES) return false;
  track.identityNeedsRevalidation = false;
  track.pendingIdentityHead = null;
  track.pendingIdentityCount = 0;
  return true;
}

function updateTrack(
  track: InternalTrack,
  candidate: DetectionCandidate | null,
  timestampMs: number,
  options: ResolvedTrackerOptions,
): PlayerTrackingResult {
  if (candidate === null) return missingResult(track, timestampMs, options);
  if (!lockedIdentityRevalidated(track, candidate)) {
    // Keep the candidate visually unassigned and never expose its hand while
    // the calibrated head is being revalidated after an occlusion.
    return missingResult(track, timestampMs, options, false);
  }
  if (track.lastCandidateTrackletId === null) {
    track.lastCandidateTrackletId = candidate.trackletId;
  }
  const headMatched =
    track.identityLock !== null &&
    candidate.geometry.headCenter !== null &&
    candidate.geometry.quality.headConfidence >= LOCKED_HEAD_MINIMUM_CONFIDENCE;
  const center = headMatched
    ? candidate.geometry.headCenter!
    : candidate.geometry.trackingCenter;
  if (!track.confirmed) {
    const continuesCandidate =
      track.candidateCenter === null ||
      pointDistance(track.candidateCenter, center) <= options.maxMatchDistance;
    track.acquisitionCount = continuesCandidate ? track.acquisitionCount + 1 : 1;
    track.candidateCenter = center;
    if (track.acquisitionCount >= options.acquisitionFrames) track.confirmed = true;
  }

  if (track.lastTrackingCenter !== null && track.lastSeenAt !== null) {
    const elapsedSeconds = (timestampMs - track.lastSeenAt) / 1000;
    if (elapsedSeconds > 0) {
      const measuredVelocity = {
        x: (center.x - track.lastTrackingCenter.x) / elapsedSeconds,
        y: (center.y - track.lastTrackingCenter.y) / elapsedSeconds,
      };
      const alpha = options.velocitySmoothing;
      track.velocity = {
        x: track.velocity.x * (1 - alpha) + measuredVelocity.x * alpha,
        y: track.velocity.y * (1 - alpha) + measuredVelocity.y * alpha,
      };
    }
  }

  track.lastTrackingCenter = center;
  track.lastSeenAt = timestampMs;
  if (track.identityLock === null) {
    track.descriptor = blendDescriptor(track.descriptor, candidate.geometry.descriptor);
  }
  if (headMatched && candidate.geometry.headCenter !== null) {
    if (track.lastHeadCenter !== null && track.lastHeadSeenAt !== null) {
      const elapsedSeconds = (timestampMs - track.lastHeadSeenAt) / 1000;
      if (elapsedSeconds > 0) {
        const measuredVelocity = {
          x: (candidate.geometry.headCenter.x - track.lastHeadCenter.x) / elapsedSeconds,
          y: (candidate.geometry.headCenter.y - track.lastHeadCenter.y) / elapsedSeconds,
        };
        const alpha = options.velocitySmoothing;
        track.headVelocity = {
          x: track.headVelocity.x * (1 - alpha) + measuredVelocity.x * alpha,
          y: track.headVelocity.y * (1 - alpha) + measuredVelocity.y * alpha,
        };
      }
    }
    track.lastHeadCenter = candidate.geometry.headCenter;
    track.lastHeadSeenAt = timestampMs;
  }

  const leftArm = getArmObservation(candidate.observation, 'left', options.minimumWristConfidence);
  const rightArm = getArmObservation(candidate.observation, 'right', options.minimumWristConfidence);
  const activeArm = track.binding.activeHand === 'left' ? leftArm : rightArm;
  const isTracking = track.confirmed;
  const observedLeftBlade = isTracking
    ? guardedBladePoint(track, 'left', leftArm, candidate.geometry, timestampMs)
    : null;
  const observedRightBlade = isTracking
    ? guardedBladePoint(track, 'right', rightArm, candidate.geometry, timestampMs)
    : null;
  const leftBlade =
    observedLeftBlade ??
    (isTracking ? displayOnlyHeldBladePoint(track, 'left', timestampMs) : null);
  const rightBlade =
    observedRightBlade ??
    (isTracking ? displayOnlyHeldBladePoint(track, 'right', timestampMs) : null);
  const activeWrist = track.binding.activeHand === 'left' ? leftBlade : rightBlade;
  const otherWrist = track.binding.activeHand === 'left' ? rightBlade : leftBlade;
  const activeBladeObserved =
    track.binding.activeHand === 'left'
      ? observedLeftBlade !== null
      : observedRightBlade !== null;
  const measuredActiveConfidence = Math.min(
    Math.max(
      candidate.geometry.quality.score,
      upperBodyStructuralConfidence(candidate.geometry.quality),
    ),
    activeArm.confidence,
  );
  const activeConfidence =
    !isTracking || activeWrist === null
      ? 0
      : activeBladeObserved && measuredActiveConfidence >= DISPLAY_ONLY_BLADE_CONFIDENCE
        ? measuredActiveConfidence
        : DISPLAY_ONLY_BLADE_CONFIDENCE;

  return {
    participantId: track.binding.participantId,
    lane: track.binding.lane,
    activeHand: track.binding.activeHand,
    confidence: activeConfidence,
    activeWrist: isTracking ? activeWrist : null,
    otherWrist:
      isTracking && options.allowBothWrists ? otherWrist : null,
    observedAt: timestampMs,
    lostForMs: 0,
    state: isTracking ? 'tracking' : 'acquiring',
    sourceTemporaryId: candidate.observation.temporaryId,
    headTrackletId: candidate.trackletId,
    torsoCenter: isTracking ? candidate.geometry.torsoCenter : null,
    bodyAnchors: isTracking
      ? {
          headCenter: candidate.geometry.headCenter,
          shoulderCenter: candidate.geometry.shoulderCenter,
          hipCenter: candidate.geometry.hipCenter,
          trackingCenter: center,
        }
      : emptyAnchors(),
    poseQuality: isTracking ? candidate.geometry.quality : null,
    wrists: isTracking
      ? { left: leftArm.wrist, right: rightArm.wrist }
      : {
          left: { point: null, confidence: leftArm.wrist.confidence },
          right: { point: null, confidence: rightArm.wrist.confidence },
        },
    arms: isTracking ? { left: leftArm, right: rightArm } : { left: null, right: null },
    observation: isTracking ? candidate.observation : null,
    identity: {
      locked: track.identityLock !== null,
      headMatched,
      state: track.identityLock === null ? 'unlocked' : 'locked',
    },
  };
}

export class TwoPlayerTracker {
  private options: ResolvedTrackerOptions;
  private readonly tracks: [InternalTrack, InternalTrack];
  private readonly headTracklets = new HeadTrackletRegistry();
  private lastFrameAt = 0;

  constructor(
    bindings: readonly [PlayerTrackBinding, PlayerTrackBinding],
    options: TwoPlayerTrackerOptions = {},
  ) {
    if (bindings[0].participantId === bindings[1].participantId) {
      throw new Error('Tracked participant IDs must be unique');
    }
    if (bindings[0].lane === bindings[1].lane) {
      throw new Error('Two-player tracking requires one participant in each lane');
    }
    this.options = resolveOptions(options);
    this.tracks = [createTrack(bindings[0]), createTrack(bindings[1])];
  }

  setMirrored(mirrored: boolean): void {
    if (this.options.mirrored === mirrored) return;
    this.options = { ...this.options, mirrored };
    this.reset();
  }

  reset(): void {
    for (const track of this.tracks) resetTrack(track);
    this.headTracklets.reset();
    this.lastFrameAt = 0;
  }

  /**
   * Atomically seals both calibrated players. Validation is completed before
   * either live track is changed, so a half-calibrated pair can never enter a
   * round with only one protected identity.
   */
  lockIdentities(profiles: readonly CalibrationProfile[]): void {
    const ordered = this.tracks.map((track) => {
      const profile = profiles.find(
        ({ participantId }) => participantId === track.binding.participantId,
      );
      if (profile === undefined) {
        throw new Error(`Missing calibration profile for ${track.binding.participantId}`);
      }
      // Validate every profile before mutating either track.
      toLockedHeadIdentity(profile);
      if (track.lastCandidateTrackletId === null) {
        throw new Error(`Participant ${track.binding.participantId} has no stable head tracklet`);
      }
      const calibratedTrackletId = profile.identityAnchor?.headTrackletId;
      if (
        calibratedTrackletId !== undefined &&
        calibratedTrackletId !== track.lastCandidateTrackletId
      ) {
        throw new Error(
          `Calibration head tracklet changed for ${track.binding.participantId}`,
        );
      }
      if (profile.lane !== track.binding.lane) {
        throw new Error(`Calibration lane does not match ${track.binding.participantId}`);
      }
      return profile;
    }) as [CalibrationProfile, CalibrationProfile];
    this.tracks.forEach((track, index) => applyIdentityLock(track, ordered[index]!));
  }

  update(observations: readonly PoseObservation[], timestampMs: number): TrackerFrameResult {
    if (!Number.isFinite(timestampMs)) throw new RangeError('timestampMs must be finite');
    const observedAt = Math.max(timestampMs, this.lastFrameAt);
    this.lastFrameAt = observedAt;
    for (const track of this.tracks) {
      if (
        track.confirmed &&
        track.lastSeenAt !== null &&
        observedAt - track.lastSeenAt >= this.options.identityRetentionMs
      ) {
        expireIdentity(track);
      }
    }
    const candidateCollection = createCandidates(observations, this.options, true);
    const candidates = this.headTracklets.update(candidateCollection.candidates, observedAt);
    const assignmentResult = this.assign(candidates, observedAt);
    const assignments = assignmentResult.assignments;
    const assignedSourceIndices = new Set<number>();
    const laneDiagnostics = cloneLaneDiagnostics(candidateCollection.diagnostics.laneDiagnostics);
    laneDiagnostics.left.ambiguousCandidateCount =
      assignmentResult.ambiguousCandidateCounts.left;
    laneDiagnostics.right.ambiguousCandidateCount =
      assignmentResult.ambiguousCandidateCounts.right;
    const players = this.tracks.map((track, trackIndex) => {
      const candidate = assignments[trackIndex] ?? null;
      const player = updateTrack(track, candidate, observedAt, this.options);
      if (candidate !== null && player.sourceTemporaryId !== null) {
        assignedSourceIndices.add(candidate.sourceIndex);
        laneDiagnostics[track.binding.lane].assignedCandidateCount += 1;
      }
      return player;
    }) as [PlayerTrackingResult, PlayerTrackingResult];

    return {
      observedAt,
      players,
      unassignedObservations: candidates
        .filter((candidate) => !assignedSourceIndices.has(candidate.sourceIndex))
        .map((candidate) => candidate.observation),
      candidateDiagnostics: {
        ...candidateCollection.diagnostics,
        assignedCandidateCount: assignedSourceIndices.size,
        laneDiagnostics,
      },
    };
  }

  private assign(
    candidates: readonly DetectionCandidate[],
    timestampMs: number,
  ): TwoPlayerAssignment {
    const noAmbiguity: Record<Lane, number> = { left: 0, right: 0 };
    if (candidates.length === 0) {
      return { assignments: [null, null], ambiguousCandidateCounts: noAmbiguity };
    }

    interface Plan {
      assignment: [DetectionCandidate | null, DetectionCandidate | null];
      cost: number;
    }
    const plans: Plan[] = [];
    const choices: Array<DetectionCandidate | null> = [null, ...candidates];
    const missingCost = (track: InternalTrack): number =>
      track.confirmed ? Math.min(0.58, this.options.maximumAssignmentCost * 0.48) : 0.82;

    // At four candidates this is only 25 combinations. Including a deliberate
    // null choice prevents a plausible spectator from being forced onto an
    // occluded player merely because MediaPipe returned enough people.
    for (const left of choices) {
      for (const right of choices) {
        if (left !== null && left === right) continue;
        const assignment: [DetectionCandidate | null, DetectionCandidate | null] = [left, right];
        let total = 0;
        let valid = true;
        for (let trackIndex = 0; trackIndex < 2; trackIndex += 1) {
          const track = this.tracks[trackIndex];
          if (track === undefined) continue;
          const candidate = assignment[trackIndex] ?? null;
          if (candidate === null) {
            total += missingCost(track);
            continue;
          }
          const cost = assignmentCost(
            track,
            candidate,
            timestampMs,
            this.options,
            true,
          );
          if (!Number.isFinite(cost) || cost > this.options.maximumAssignmentCost) {
            valid = false;
            break;
          }
          total += cost;
        }
        if (valid) plans.push({ assignment, cost: total });
      }
    }

    plans.sort((a, b) => a.cost - b.cost);
    const best = plans[0];
    if (best === undefined) {
      return { assignments: [null, null], ambiguousCandidateCounts: noAmbiguity };
    }
    const ambiguityMargin = this.tracks.some(({ identityLock }) => identityLock !== null)
      ? Math.max(this.options.ambiguityMargin, LOCKED_IDENTITY_AMBIGUITY_MARGIN)
      : this.options.ambiguityMargin;
    const plausible = plans.filter(
      (plan) => plan.cost <= best.cost + ambiguityMargin,
    );

    // A near-equal null alternative means only that skipping a slightly noisy
    // detection is cheap; treating that as an identity conflict made a valid
    // player blink every few frames. Only a competing non-null person can make
    // an assigned identity ambiguous. If every near-optimal global plan agrees
    // on player A but not B, A keeps playing while B safely emits no blade.
    const ambiguousCandidateCounts: Record<Lane, number> = { left: 0, right: 0 };
    const assignments = [0, 1].map((trackIndex) => {
      const selected = best.assignment[trackIndex] ?? null;
      if (selected === null) return null;
      const competingCandidates = new Set(
        plausible.flatMap((plan) => {
          const candidate = plan.assignment[trackIndex] ?? null;
          return candidate === null || candidate === selected ? [] : [candidate];
        }),
      );
      if (competingCandidates.size === 0) return selected;
      const lane = this.tracks[trackIndex]?.binding.lane;
      if (lane !== undefined) {
        ambiguousCandidateCounts[lane] = competingCandidates.size + 1;
      }
      return null;
    }) as [DetectionCandidate | null, DetectionCandidate | null];
    return { assignments, ambiguousCandidateCounts };
  }
}

/** A one-person variant for practice mode that retains all tracking safeguards. */
export class SinglePlayerTracker {
  private options: ResolvedTrackerOptions;
  private readonly track: InternalTrack;
  private readonly headTracklets = new HeadTrackletRegistry();
  private lastFrameAt = 0;

  constructor(binding: PlayerTrackBinding, options: TwoPlayerTrackerOptions = {}) {
    this.options = resolveOptions(options);
    this.track = createTrack(binding);
  }

  setMirrored(mirrored: boolean): void {
    if (this.options.mirrored === mirrored) return;
    this.options = { ...this.options, mirrored };
    this.reset();
  }

  reset(): void {
    resetTrack(this.track);
    this.headTracklets.reset();
    this.lastFrameAt = 0;
  }

  lockIdentities(profiles: readonly CalibrationProfile[]): void {
    const profile = profiles.find(
      ({ participantId }) => participantId === this.track.binding.participantId,
    );
    if (profile === undefined) {
      throw new Error(`Missing calibration profile for ${this.track.binding.participantId}`);
    }
    const calibratedTrackletId = profile.identityAnchor?.headTrackletId;
    if (
      calibratedTrackletId !== undefined &&
      calibratedTrackletId !== this.track.lastCandidateTrackletId
    ) {
      throw new Error(
        `Calibration head tracklet changed for ${this.track.binding.participantId}`,
      );
    }
    // The one-person API intentionally matches TwoPlayerTracker so the app can
    // seal either mode without branching on the tracker implementation.
    applyIdentityLock(this.track, profile);
  }

  update(
    observations: readonly PoseObservation[],
    timestampMs: number,
  ): SinglePlayerTrackerFrameResult {
    if (!Number.isFinite(timestampMs)) throw new RangeError('timestampMs must be finite');
    const observedAt = Math.max(timestampMs, this.lastFrameAt);
    this.lastFrameAt = observedAt;
    if (
      this.track.confirmed &&
      this.track.lastSeenAt !== null &&
      observedAt - this.track.lastSeenAt >= this.options.identityRetentionMs
    ) {
      expireIdentity(this.track);
    }
    const candidateCollection = createCandidates(observations, this.options);
    const candidates = this.headTracklets.update(candidateCollection.candidates, observedAt);
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        cost: assignmentCost(this.track, candidate, observedAt, this.options),
      }))
      .sort((a, b) => a.cost - b.cost);
    const best = ranked[0];
    const runnerUp = ranked[1];
    const ambiguityMargin = this.track.identityLock === null
      ? this.options.ambiguityMargin
      : Math.max(this.options.ambiguityMargin, LOCKED_IDENTITY_AMBIGUITY_MARGIN);
    const ambiguous =
      best !== undefined &&
      runnerUp !== undefined &&
      Math.abs(runnerUp.cost - best.cost) < ambiguityMargin;
    const selected =
      best === undefined ||
      ambiguous ||
      !Number.isFinite(best.cost) ||
      best.cost > this.options.maximumAssignmentCost
        ? null
        : best.candidate;
    const player = updateTrack(this.track, selected, observedAt, this.options);
    const acceptedSelection = player.sourceTemporaryId === null ? null : selected;
    return {
      observedAt,
      player,
      players: [player],
      unassignedObservations: candidates
        .filter((candidate) => candidate !== acceptedSelection)
        .map((candidate) => candidate.observation),
      candidateDiagnostics: {
        ...candidateCollection.diagnostics,
        assignedCandidateCount: acceptedSelection === null ? 0 : 1,
      },
    };
  }
}

export interface CalibrationCollectorOptions {
  minimumSamples?: number;
  maximumSamples?: number;
  minimumConfidence?: number;
  minimumHeadConfidence?: number;
  minimumHeadPointConfidence?: number;
  minimumEarSpanSamples?: number;
  maximumFallbackDeviation?: number;
}

interface CalibrationSample {
  geometry: MultiJointPoseGeometry;
  capturedAt: number;
  trackletId: number;
  earSpan: number | null;
}

export type CalibrationIdentitySource = 'ear-span' | 'shoulder-torso-fallback';
export type CalibrationParticipantStatus = 'collecting' | 'ready' | 'frozen';

export interface CalibrationParticipantDiagnostics {
  participantId: string;
  lane: Lane;
  sampleCount: number;
  minimumSamples: number;
  earSpanSampleCount: number;
  minimumEarSpanSamples: number;
  progress: number;
  headTrackletId: number | null;
  earSpanReady: boolean;
  fallbackReady: boolean;
  identitySource: CalibrationIdentitySource | null;
  status: CalibrationParticipantStatus;
}

function medianRelativeDeviation(values: readonly number[], scaleFloor: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center))) /
    Math.max(scaleFloor, Math.abs(center));
}

export class CalibrationCollector {
  private readonly bindings = new Map<string, PlayerTrackBinding>();
  private readonly samples = new Map<string, CalibrationSample[]>();
  private readonly finalizedProfiles = new Map<string, CalibrationProfile>();
  private readonly minimumSamples: number;
  private readonly maximumSamples: number;
  private readonly minimumConfidence: number;
  private readonly minimumHeadConfidence: number;
  private readonly minimumHeadPointConfidence: number;
  private readonly minimumEarSpanSamples: number;
  private readonly maximumFallbackDeviation: number;

  constructor(
    bindings: readonly PlayerTrackBinding[],
    options: CalibrationCollectorOptions = {},
  ) {
    this.minimumSamples = options.minimumSamples ?? 16;
    this.maximumSamples = options.maximumSamples ?? 90;
    this.minimumConfidence = options.minimumConfidence ?? 0.45;
    this.minimumHeadConfidence = options.minimumHeadConfidence ?? 0.3;
    this.minimumHeadPointConfidence = options.minimumHeadPointConfidence ?? 0.28;
    this.minimumEarSpanSamples = options.minimumEarSpanSamples ?? 6;
    this.maximumFallbackDeviation = options.maximumFallbackDeviation ?? 0.18;
    if (!Number.isInteger(this.minimumSamples) || this.minimumSamples <= 0) {
      throw new RangeError('minimumSamples must be a positive integer');
    }
    if (!Number.isInteger(this.maximumSamples) || this.maximumSamples < this.minimumSamples) {
      throw new RangeError('maximumSamples must be an integer no smaller than minimumSamples');
    }
    if (!Number.isInteger(this.minimumEarSpanSamples) || this.minimumEarSpanSamples <= 0) {
      throw new RangeError('minimumEarSpanSamples must be a positive integer');
    }
    for (const [name, value] of [
      ['minimumConfidence', this.minimumConfidence],
      ['minimumHeadConfidence', this.minimumHeadConfidence],
      ['minimumHeadPointConfidence', this.minimumHeadPointConfidence],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(`${name} must be in [0, 1]`);
      }
    }
    if (!Number.isFinite(this.maximumFallbackDeviation) || this.maximumFallbackDeviation < 0) {
      throw new RangeError('maximumFallbackDeviation must be non-negative and finite');
    }
    for (const binding of bindings) {
      if (this.bindings.has(binding.participantId)) {
        throw new Error(`Duplicate calibration participant ${binding.participantId}`);
      }
      this.bindings.set(binding.participantId, { ...binding });
      this.samples.set(binding.participantId, []);
    }
  }

  add(frame: { observedAt: number; players: readonly PlayerTrackingResult[] }): void {
    for (const binding of this.bindings.values()) {
      if (this.finalizedProfiles.has(binding.participantId)) continue;
      const player = frame.players.find(
        ({ participantId }) => participantId === binding.participantId,
      );
      if (
        player?.state !== 'tracking' ||
        player.observation === null ||
        player.headTrackletId === null
      ) continue;
      const geometry = getMultiJointPoseGeometry(player.observation);
      const headAnchor = getHeadAnchor(player.observation);
      const headPointConfidences = [
        landmarkConfidence(player.observation.landmarks[POSE_LANDMARK.nose]),
        landmarkConfidence(player.observation.landmarks[POSE_LANDMARK.leftEar]),
        landmarkConfidence(player.observation.landmarks[POSE_LANDMARK.rightEar]),
      ];
      const trustedHeadPointCount = headPointConfidences.filter(
        (confidence) => confidence >= this.minimumHeadPointConfidence,
      ).length;
      const trustedEarSpan =
        headPointConfidences[1]! >= this.minimumHeadPointConfidence &&
        headPointConfidences[2]! >= this.minimumHeadPointConfidence &&
        headAnchor.span !== null &&
        headAnchor.span > 0.01
          ? headAnchor.span
          : null;
      const calibrationConfidence =
        geometry === null
          ? 0
          : Math.max(
              geometry.quality.score,
              upperBodyStructuralConfidence(geometry.quality),
            );
      if (
        geometry === null ||
        calibrationConfidence < this.minimumConfidence ||
        geometry.headCenter === null ||
        trustedHeadPointCount < 2 ||
        geometry.quality.headConfidence < this.minimumHeadConfidence ||
        geometry.quality.shoulderConfidence < 0.4 ||
        geometry.shoulderWidth <= 0.02 ||
        geometry.torsoLength <= 0.02 ||
        (
          this.bindings.size === 2 &&
          !isInDualPlayerLane(binding.lane, geometry.headCenter.x)
        )
      ) {
        continue;
      }
      const participantSamples = this.samples.get(binding.participantId);
      if (participantSamples === undefined) continue;
      const sample: CalibrationSample = {
        geometry,
        capturedAt: frame.observedAt,
        trackletId: player.headTrackletId,
        earSpan: trustedEarSpan,
      };
      const previous = participantSamples.at(-1);
      const previousHead = previous?.geometry.headCenter;
      const permittedJump = previous === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(
            0.1,
            previous.geometry.shoulderWidth * 1.7,
            sample.geometry.shoulderWidth * 1.7,
          );
      const discontinuous =
        previous !== undefined &&
        (
          previous.trackletId !== sample.trackletId ||
          previousHead === null ||
          previousHead === undefined ||
          pointDistance(previousHead, geometry.headCenter) > permittedJump
        );
      if (discontinuous) participantSamples.length = 0;
      participantSamples.push(sample);
      if (participantSamples.length > this.maximumSamples) participantSamples.shift();
    }
  }

  progress(participantId: string): number {
    if (this.finalizedProfiles.has(participantId)) return 1;
    const count = this.samples.get(participantId)?.length ?? 0;
    return Math.min(1, count / this.minimumSamples);
  }

  finalize(participantId: string): CalibrationProfile | null {
    const frozen = this.finalizedProfiles.get(participantId);
    if (frozen !== undefined) return frozen;
    const binding = this.bindings.get(participantId);
    const participantSamples = this.samples.get(participantId);
    if (
      binding === undefined ||
      participantSamples === undefined ||
      participantSamples.length < this.minimumSamples
    ) {
      return null;
    }
    const diagnostics = this.createDiagnostics(binding, participantSamples, false);
    const identitySource = diagnostics.identitySource;
    if (identitySource === null) return null;
    const headSamples = participantSamples
      .map((sample) => sample.geometry.headCenter)
      .filter((point): point is Point => point !== null);
    const armLengths = participantSamples.flatMap((sample) =>
      [sample.geometry.descriptor.leftUpperArm, sample.geometry.descriptor.rightUpperArm].filter(
        (length): length is number => length !== null,
      ),
    );
    if (headSamples.length < this.minimumSamples) return null;
    const headCenter = {
      x: median(headSamples.map((point) => point.x)),
      y: median(headSamples.map((point) => point.y)),
    };
    const shoulderCenter = {
      x: median(participantSamples.map((sample) => sample.geometry.shoulderCenter.x)),
      y: median(participantSamples.map((sample) => sample.geometry.shoulderCenter.y)),
    };
    const shoulderWidth = median(
      participantSamples.map((sample) => sample.geometry.shoulderWidth),
    );
    const torsoLength = median(
      participantSamples.map((sample) => sample.geometry.torsoLength),
    );
    const headSpanRatios = participantSamples.flatMap(({ geometry, earSpan }) =>
      earSpan === null || geometry.shoulderWidth <= 0
        ? []
        : [earSpan / geometry.shoulderWidth],
    );
    const hipWidth = medianOrUndefined(
      participantSamples
        .map((sample) => sample.geometry.hipWidth)
        .filter((value) => value > 0),
    );
    const upperArmLength = medianOrUndefined(armLengths);
    const identityAnchor = {
      version: 1 as const,
      headCenter,
      headOffsetInShoulders: {
        x: (headCenter.x - shoulderCenter.x) / shoulderWidth,
        y: (headCenter.y - shoulderCenter.y) / shoulderWidth,
      },
      ...(identitySource === 'ear-span'
        ? { headSpanToShoulderRatio: median(headSpanRatios) }
        : {}),
      torsoToShoulderRatio: torsoLength / shoulderWidth,
      confidence: median(
        participantSamples.map((sample) => sample.geometry.quality.headConfidence),
      ),
      sampleCount: participantSamples.length,
      headTrackletId: participantSamples[0]!.trackletId,
      earSpanSampleCount: diagnostics.earSpanSampleCount,
      source: identitySource,
    };
    const profile: CalibrationProfile = {
      participantId,
      lane: binding.lane,
      activeHand: binding.activeHand,
      shoulderCenter,
      torsoCenter: {
        x: median(participantSamples.map((sample) => sample.geometry.torsoCenter.x)),
        y: median(participantSamples.map((sample) => sample.geometry.torsoCenter.y)),
      },
      shoulderWidth,
      torsoLength,
      capturedAt: participantSamples[participantSamples.length - 1]?.capturedAt ?? 0,
      hipCenter: {
        x: median(participantSamples.map((sample) => sample.geometry.hipCenter.x)),
        y: median(participantSamples.map((sample) => sample.geometry.hipCenter.y)),
      },
      poseQuality: median(participantSamples.map((sample) => sample.geometry.quality.score)),
      headCenter,
      identityAnchor,
      ...(hipWidth === undefined ? {} : { hipWidth }),
      ...(upperArmLength === undefined ? {} : { upperArmLength }),
    };
    this.finalizedProfiles.set(participantId, profile);
    return profile;
  }

  diagnostics(participantId: string): CalibrationParticipantDiagnostics | null {
    const binding = this.bindings.get(participantId);
    const participantSamples = this.samples.get(participantId);
    if (binding === undefined || participantSamples === undefined) return null;
    return this.createDiagnostics(
      binding,
      participantSamples,
      this.finalizedProfiles.has(participantId),
    );
  }

  allDiagnostics(): CalibrationParticipantDiagnostics[] {
    return [...this.bindings.values()].map((binding) =>
      this.createDiagnostics(
        binding,
        this.samples.get(binding.participantId) ?? [],
        this.finalizedProfiles.has(binding.participantId),
      ),
    );
  }

  clear(participantId?: string): void {
    if (participantId === undefined) {
      for (const participantSamples of this.samples.values()) participantSamples.length = 0;
      this.finalizedProfiles.clear();
      return;
    }
    const participantSamples = this.samples.get(participantId);
    if (participantSamples !== undefined) participantSamples.length = 0;
    this.finalizedProfiles.delete(participantId);
  }

  private createDiagnostics(
    binding: PlayerTrackBinding,
    participantSamples: readonly CalibrationSample[],
    frozen: boolean,
  ): CalibrationParticipantDiagnostics {
    const earSpanSampleCount = participantSamples.filter(({ earSpan }) => earSpan !== null).length;
    const enoughSamples = participantSamples.length >= this.minimumSamples;
    const earSpanReady = enoughSamples && earSpanSampleCount >= this.minimumEarSpanSamples;
    const headOffsetX = participantSamples.map(({ geometry }) =>
      (geometry.headCenter!.x - geometry.shoulderCenter.x) / geometry.shoulderWidth,
    );
    const headOffsetY = participantSamples.map(({ geometry }) =>
      (geometry.headCenter!.y - geometry.shoulderCenter.y) / geometry.shoulderWidth,
    );
    const torsoRatios = participantSamples.map(
      ({ geometry }) => geometry.torsoLength / geometry.shoulderWidth,
    );
    const shoulderWidths = participantSamples.map(({ geometry }) => geometry.shoulderWidth);
    const fallbackReady =
      enoughSamples &&
      medianRelativeDeviation(headOffsetX, 0.5) <= this.maximumFallbackDeviation &&
      medianRelativeDeviation(headOffsetY, 0.5) <= this.maximumFallbackDeviation &&
      medianRelativeDeviation(torsoRatios, 1) <= this.maximumFallbackDeviation &&
      medianRelativeDeviation(shoulderWidths, 0.05) <= this.maximumFallbackDeviation;
    const identitySource: CalibrationIdentitySource | null = earSpanReady
      ? 'ear-span'
      : fallbackReady
        ? 'shoulder-torso-fallback'
        : null;
    return {
      participantId: binding.participantId,
      lane: binding.lane,
      sampleCount: participantSamples.length,
      minimumSamples: this.minimumSamples,
      earSpanSampleCount,
      minimumEarSpanSamples: this.minimumEarSpanSamples,
      progress: frozen ? 1 : Math.min(1, participantSamples.length / this.minimumSamples),
      headTrackletId: participantSamples[0]?.trackletId ?? null,
      earSpanReady,
      fallbackReady,
      identitySource,
      status: frozen ? 'frozen' : identitySource === null ? 'collecting' : 'ready',
    };
  }
}

export function getOtherHand(binding: PlayerTrackBinding): DominantHand {
  return oppositeHand(binding.activeHand);
}
