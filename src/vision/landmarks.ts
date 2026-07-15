import type {
  DominantHand,
  NormalizedLandmark,
  Point,
  PoseObservation,
  PoseQualitySummary,
} from '../types/game';

/** MediaPipe Pose Landmarker landmark indices used by the game. */
export const POSE_LANDMARK = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  leftMouth: 9,
  rightMouth: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
} as const;

const HEAD_INDICES = [
  POSE_LANDMARK.nose,
  POSE_LANDMARK.leftEar,
  POSE_LANDMARK.rightEar,
] as const;
const SHOULDER_INDICES = [POSE_LANDMARK.leftShoulder, POSE_LANDMARK.rightShoulder] as const;
const ELBOW_INDICES = [POSE_LANDMARK.leftElbow, POSE_LANDMARK.rightElbow] as const;
const WRIST_INDICES = [POSE_LANDMARK.leftWrist, POSE_LANDMARK.rightWrist] as const;
const HAND_INDICES = [
  POSE_LANDMARK.leftPinky,
  POSE_LANDMARK.rightPinky,
  POSE_LANDMARK.leftIndex,
  POSE_LANDMARK.rightIndex,
  POSE_LANDMARK.leftThumb,
  POSE_LANDMARK.rightThumb,
] as const;
const HIP_INDICES = [POSE_LANDMARK.leftHip, POSE_LANDMARK.rightHip] as const;
const QUALITY_INDICES = [
  ...HEAD_INDICES,
  ...SHOULDER_INDICES,
  ...ELBOW_INDICES,
  ...WRIST_INDICES,
  ...HAND_INDICES,
  ...HIP_INDICES,
] as const;

/**
 * Number of landmarks used by the lightweight post-inference quality pass.
 * MediaPipe still produces all 33 pose landmarks; this only documents the
 * smaller body-focused subset used for player tracking and diagnostics.
 */
export const POSE_QUALITY_LANDMARK_COUNT = QUALITY_INDICES.length;

const STRUCTURAL_MINIMUM_CONFIDENCE = 0.18;
const RELIABLE_LANDMARK_CONFIDENCE = 0.45;
// Fast hands commonly lose a little MediaPipe visibility before the shoulder
// and elbow do. Two current-frame hand anchors plus a supported arm are still
// safer than dropping the blade at a single hard 0.30 boundary.
const DIRECT_HAND_LANDMARK_CONFIDENCE = 0.24;
const MINIMUM_ARM_SUPPORT_FOR_HAND = 0.56;

export interface LandmarkObservation {
  point: Point | null;
  confidence: number;
}

export interface TorsoGeometry {
  shoulderCenter: Point;
  hipCenter: Point;
  torsoCenter: Point;
  shoulderWidth: number;
  torsoLength: number;
  confidence: number;
}

export interface WristObservation extends LandmarkObservation {}

export interface ArmObservation {
  shoulder: LandmarkObservation;
  elbow: LandmarkObservation;
  wrist: WristObservation;
  /** Most-distal directly observed hand endpoint after multi-point validation. */
  hand: LandmarkObservation & { reliableLandmarkCount: number };
  /** Directly observed wrist, or the validated directly observed distal endpoint. */
  bladePoint: Point | null;
  /** Confidence of the whole shoulder-elbow-wrist chain. */
  confidence: number;
  reliableJointCount: number;
}

export interface BodyDescriptor {
  shoulderWidth: number | null;
  headSpan: number | null;
  hipWidth: number | null;
  torsoLength: number | null;
  headToShoulder: number | null;
  leftUpperArm: number | null;
  rightUpperArm: number | null;
  leftForearm: number | null;
  rightForearm: number | null;
}

export interface MultiJointPoseGeometry extends TorsoGeometry {
  headCenter: Point | null;
  headSpan: number | null;
  trackingCenter: Point;
  hipWidth: number;
  quality: PoseQualitySummary;
  descriptor: BodyDescriptor;
}

export interface HeadAnchorObservation {
  center: Point | null;
  /** Ear-to-ear span when both ears are directly visible. */
  span: number | null;
  confidence: number;
  reliableLandmarkCount: number;
}

export function landmarkConfidence(landmark: NormalizedLandmark | undefined): number {
  if (landmark === undefined) return 0;
  const visibility = Number.isFinite(landmark.visibility) ? landmark.visibility : 0;
  const presence = Number.isFinite(landmark.presence) ? landmark.presence : 0;
  return Math.max(0, Math.min(1, Math.min(visibility, presence)));
}

function isFiniteLandmark(
  landmark: NormalizedLandmark | undefined,
): landmark is NormalizedLandmark {
  return (
    landmark !== undefined &&
    Number.isFinite(landmark.x) &&
    Number.isFinite(landmark.y) &&
    Number.isFinite(landmark.z)
  );
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle] ?? 0;
  if (ordered.length % 2 === 1) return upper;
  return ((ordered[middle - 1] ?? upper) + upper) / 2;
}

type VisibleLandmarkObservation = LandmarkObservation & { point: Point };

/**
 * Selects one coordinate that MediaPipe actually returned: the coherent hand
 * endpoint farthest from the arm. The closest coherent pair rejects a single
 * jumping endpoint before distance ranking, so this never invents a palm
 * centre or extrapolates a fingertip/tool beyond an observed landmark.
 */
function selectObservedDistalHandPoint(
  observations: readonly LandmarkObservation[],
  proximalPoint: Point | null,
  maximumClusterSpan: number,
): VisibleLandmarkObservation | null {
  const visible = observations.filter(
    (observation): observation is VisibleLandmarkObservation => observation.point !== null,
  );
  if (visible.length === 0) return null;

  const pairs: Array<{
    first: VisibleLandmarkObservation;
    second: VisibleLandmarkObservation;
    separation: number;
  }> = [];
  visible.forEach((first, firstIndex) => {
    visible.slice(firstIndex + 1).forEach((second) => {
      pairs.push({ first, second, separation: distance(first.point, second.point) });
    });
  });

  let coherent = visible;
  if (pairs.some(({ separation }) => separation > maximumClusterSpan)) {
    const closestPair = [...pairs].sort((left, right) => left.separation - right.separation)[0];
    if (!closestPair || closestPair.separation > maximumClusterSpan) return null;
    coherent = [closestPair.first, closestPair.second];
  }

  return coherent.reduce<VisibleLandmarkObservation | null>((selected, candidate) => {
    if (selected === null) return candidate;
    if (proximalPoint === null) {
      return candidate.confidence > selected.confidence ? candidate : selected;
    }
    const candidateDistance = distance(proximalPoint, candidate.point);
    const selectedDistance = distance(proximalPoint, selected.point);
    if (candidateDistance !== selectedDistance) {
      return candidateDistance > selectedDistance ? candidate : selected;
    }
    return candidate.confidence > selected.confidence ? candidate : selected;
  }, null);
}

function regionConfidence(
  observation: Pick<PoseObservation, 'landmarks'>,
  indices: readonly number[],
): number {
  return mean(indices.map((index) => landmarkConfidence(observation.landmarks[index])));
}

function weightedCenter(
  observation: Pick<PoseObservation, 'landmarks'>,
  indices: readonly number[],
  minimumConfidence = STRUCTURAL_MINIMUM_CONFIDENCE,
): Point | null {
  let x = 0;
  let y = 0;
  let totalWeight = 0;
  for (const index of indices) {
    const landmark = observation.landmarks[index];
    const confidence = landmarkConfidence(landmark);
    if (!isFiniteLandmark(landmark) || confidence < minimumConfidence) continue;
    x += landmark.x * confidence;
    y += landmark.y * confidence;
    totalWeight += confidence;
  }
  if (totalWeight <= 0) return null;
  return { x: x / totalWeight, y: y / totalWeight };
}

/**
 * A compact head anchor for identity continuity. Pose Landmarker already
 * returns these points, so this adds only a few arithmetic operations and no
 * extra model work. Nose plus both ears are deliberately preferred over hand
 * or elbow positions, which move substantially during play.
 */
export function getHeadAnchor(
  observation: Pick<PoseObservation, 'landmarks'>,
): HeadAnchorObservation {
  const nose = getLandmark(observation, POSE_LANDMARK.nose, STRUCTURAL_MINIMUM_CONFIDENCE);
  const leftEar = getLandmark(
    observation,
    POSE_LANDMARK.leftEar,
    STRUCTURAL_MINIMUM_CONFIDENCE,
  );
  const rightEar = getLandmark(
    observation,
    POSE_LANDMARK.rightEar,
    STRUCTURAL_MINIMUM_CONFIDENCE,
  );
  const visible = [nose, leftEar, rightEar].filter(
    (anchor): anchor is LandmarkObservation & { point: Point } => anchor.point !== null,
  );
  const center = visible.length === 0
    ? null
    : {
        x: median(visible.map(({ point }) => point.x)),
        y: median(visible.map(({ point }) => point.y)),
      };
  const span = leftEar.point !== null && rightEar.point !== null
    ? distance(leftEar.point, rightEar.point)
    : null;
  return {
    center,
    span,
    confidence: mean([nose.confidence, leftEar.confidence, rightEar.confidence]),
    reliableLandmarkCount: visible.filter(
      ({ confidence }) => confidence >= RELIABLE_LANDMARK_CONFIDENCE,
    ).length,
  };
}

function pairGeometry(
  observation: Pick<PoseObservation, 'landmarks'>,
  leftIndex: number,
  rightIndex: number,
): { center: Point | null; width: number; confidence: number; complete: boolean } {
  const left = observation.landmarks[leftIndex];
  const right = observation.landmarks[rightIndex];
  const leftConfidence = landmarkConfidence(left);
  const rightConfidence = landmarkConfidence(right);
  const validLeft = isFiniteLandmark(left) && leftConfidence >= STRUCTURAL_MINIMUM_CONFIDENCE;
  const validRight = isFiniteLandmark(right) && rightConfidence >= STRUCTURAL_MINIMUM_CONFIDENCE;

  if (validLeft && validRight) {
    const leftPoint = { x: left.x, y: left.y };
    const rightPoint = { x: right.x, y: right.y };
    return {
      center: midpoint(leftPoint, rightPoint),
      width: distance(leftPoint, rightPoint),
      confidence: (leftConfidence + rightConfidence) / 2,
      complete: true,
    };
  }
  const visible = validLeft ? left : validRight ? right : undefined;
  return {
    center: visible === undefined ? null : { x: visible.x, y: visible.y },
    width: 0,
    confidence: Math.max(leftConfidence, rightConfidence) * 0.55,
    complete: false,
  };
}

export function getPoseQuality(
  observation: Pick<PoseObservation, 'landmarks'>,
): PoseQualitySummary {
  const headConfidence = regionConfidence(observation, HEAD_INDICES);
  const shoulderConfidence = regionConfidence(observation, SHOULDER_INDICES);
  const elbowConfidence = regionConfidence(observation, ELBOW_INDICES);
  const wristConfidence = regionConfidence(observation, WRIST_INDICES);
  const handConfidence = regionConfidence(observation, HAND_INDICES);
  const hipConfidence = regionConfidence(observation, HIP_INDICES);
  const reliableLandmarkCount = QUALITY_INDICES.reduce<number>(
    (count, index) =>
      count +
      (landmarkConfidence(observation.landmarks[index]) >= RELIABLE_LANDMARK_CONFIDENCE ? 1 : 0),
    0,
  );
  const landmarkCoverage = reliableLandmarkCount / POSE_QUALITY_LANDMARK_COUNT;

  // Face details are deliberately excluded. Shoulders, arms, wrists and the
  // six direct hand anchors dominate this post-inference score; the compact
  // nose/ear outline and hips remain supporting identity anchors.
  const regionalScore =
    headConfidence * 0.07 +
    shoulderConfidence * 0.29 +
    elbowConfidence * 0.22 +
    wristConfidence * 0.1 +
    handConfidence * 0.19 +
    hipConfidence * 0.13;
  const score = regionalScore * 0.82 + landmarkCoverage * 0.18;

  return {
    score: Math.max(0, Math.min(1, score)),
    headConfidence,
    shoulderConfidence,
    elbowConfidence,
    wristConfidence,
    handConfidence,
    hipConfidence,
    landmarkCoverage,
    reliableLandmarkCount,
  };
}

export function getLandmark(
  observation: Pick<PoseObservation, 'landmarks'>,
  index: number,
  minimumConfidence = 0,
): LandmarkObservation {
  const landmark = observation.landmarks[index];
  const confidence = landmarkConfidence(landmark);
  if (!isFiniteLandmark(landmark) || confidence < minimumConfidence) {
    return { point: null, confidence };
  }
  return { point: { x: landmark.x, y: landmark.y }, confidence };
}

export function getTorsoGeometry(
  observation: Pick<PoseObservation, 'landmarks'>,
): TorsoGeometry | null {
  const shoulders = pairGeometry(
    observation,
    POSE_LANDMARK.leftShoulder,
    POSE_LANDMARK.rightShoulder,
  );
  const hips = pairGeometry(observation, POSE_LANDMARK.leftHip, POSE_LANDMARK.rightHip);
  const headCenter = weightedCenter(observation, HEAD_INDICES);
  if (shoulders.center === null && hips.center === null) return null;

  const shoulderCenter = shoulders.center ?? {
    x: hips.center?.x ?? 0.5,
    y: (hips.center?.y ?? 0.6) - Math.max(hips.width, 0.12) * 1.35,
  };
  const hipCenter = hips.center ?? {
    x: shoulderCenter.x,
    y:
      shoulderCenter.y +
      Math.max(
        shoulders.width * 1.35,
        headCenter === null ? 0.16 : distance(headCenter, shoulderCenter) * 1.45,
      ),
  };
  const torsoCenter = midpoint(shoulderCenter, hipCenter);
  const torsoLength = distance(shoulderCenter, hipCenter);

  return {
    shoulderCenter,
    hipCenter,
    torsoCenter,
    shoulderWidth: shoulders.width,
    torsoLength,
    confidence: shoulders.confidence * 0.58 + hips.confidence * 0.42,
  };
}

function segmentLength(
  observation: Pick<PoseObservation, 'landmarks'>,
  startIndex: number,
  endIndex: number,
): number | null {
  const start = getLandmark(observation, startIndex, STRUCTURAL_MINIMUM_CONFIDENCE);
  const end = getLandmark(observation, endIndex, STRUCTURAL_MINIMUM_CONFIDENCE);
  return start.point === null || end.point === null ? null : distance(start.point, end.point);
}

export function getMultiJointPoseGeometry(
  observation: Pick<PoseObservation, 'landmarks'>,
): MultiJointPoseGeometry | null {
  const torso = getTorsoGeometry(observation);
  if (torso === null) return null;
  const quality = getPoseQuality(observation);
  const head = getHeadAnchor(observation);
  const headCenter = head.center;
  const hips = pairGeometry(observation, POSE_LANDMARK.leftHip, POSE_LANDMARK.rightHip);
  const trackingCenter =
    weightedCenter(observation, [
      ...HEAD_INDICES,
      ...SHOULDER_INDICES,
      ...ELBOW_INDICES,
      ...HIP_INDICES,
    ]) ?? torso.torsoCenter;

  return {
    ...torso,
    headCenter,
    headSpan: head.span,
    trackingCenter,
    hipWidth: hips.width,
    quality,
    descriptor: {
      shoulderWidth: torso.shoulderWidth > 0 ? torso.shoulderWidth : null,
      headSpan: head.span,
      hipWidth: hips.width > 0 ? hips.width : null,
      torsoLength: torso.torsoLength > 0 ? torso.torsoLength : null,
      headToShoulder:
        headCenter === null ? null : distance(headCenter, torso.shoulderCenter),
      leftUpperArm: segmentLength(
        observation,
        POSE_LANDMARK.leftShoulder,
        POSE_LANDMARK.leftElbow,
      ),
      rightUpperArm: segmentLength(
        observation,
        POSE_LANDMARK.rightShoulder,
        POSE_LANDMARK.rightElbow,
      ),
      leftForearm: segmentLength(
        observation,
        POSE_LANDMARK.leftElbow,
        POSE_LANDMARK.leftWrist,
      ),
      rightForearm: segmentLength(
        observation,
        POSE_LANDMARK.rightElbow,
        POSE_LANDMARK.rightWrist,
      ),
    },
  };
}

export function getWrist(
  observation: Pick<PoseObservation, 'landmarks'>,
  hand: DominantHand,
  minimumConfidence = 0,
): WristObservation {
  const index = hand === 'left' ? POSE_LANDMARK.leftWrist : POSE_LANDMARK.rightWrist;
  return getLandmark(observation, index, minimumConfidence);
}

/**
 * Resolves a wrist together with its shoulder/elbow chain. A moderately visible
 * wrist is accepted when both supporting arm joints are strong; no point is
 * predicted when MediaPipe cannot see the wrist, preventing phantom slices.
 */
export function getArmObservation(
  observation: Pick<PoseObservation, 'landmarks'>,
  hand: DominantHand,
  minimumWristConfidence = 0.45,
): ArmObservation {
  const isLeft = hand === 'left';
  const shoulder = getLandmark(
    observation,
    isLeft ? POSE_LANDMARK.leftShoulder : POSE_LANDMARK.rightShoulder,
  );
  const elbow = getLandmark(
    observation,
    isLeft ? POSE_LANDMARK.leftElbow : POSE_LANDMARK.rightElbow,
  );
  const rawWrist = getWrist(observation, hand);
  const handIndices = isLeft
    ? [POSE_LANDMARK.leftPinky, POSE_LANDMARK.leftIndex, POSE_LANDMARK.leftThumb]
    : [POSE_LANDMARK.rightPinky, POSE_LANDMARK.rightIndex, POSE_LANDMARK.rightThumb];
  const directHandObservations = handIndices.map((index) =>
    getLandmark(observation, index, DIRECT_HAND_LANDMARK_CONFIDENCE),
  );
  const handConfidences = directHandObservations.map(({ confidence }) => confidence);
  const reliableHandObservations = directHandObservations.filter(({ point }) => point !== null);
  const reliableHandLandmarks = reliableHandObservations.length;
  const handConfidence = mean(handConfidences);
  const armSupport = shoulder.confidence * 0.42 + elbow.confidence * 0.58;
  const supportedMinimum = Math.max(0.22, minimumWristConfidence * 0.55);
  const wristAccepted =
    rawWrist.point !== null &&
    (rawWrist.confidence >= minimumWristConfidence ||
      (rawWrist.confidence >= supportedMinimum &&
        armSupport >= MINIMUM_ARM_SUPPORT_FOR_HAND));
  const wrist = wristAccepted ? rawWrist : { point: null, confidence: rawWrist.confidence };
  const upperArmLength =
    shoulder.point === null || elbow.point === null
      ? null
      : distance(shoulder.point, elbow.point);
  const proximalPoint =
    elbow.point !== null && elbow.confidence >= STRUCTURAL_MINIMUM_CONFIDENCE
      ? elbow.point
      : shoulder.point !== null && shoulder.confidence >= STRUCTURAL_MINIMUM_CONFIDENCE
        ? shoulder.point
        : wrist.point;
  const maximumHandClusterSpan = Math.max(
    0.04,
    Math.min(0.11, (upperArmLength ?? 0.12) * 0.8),
  );
  const observedDistalHand = selectObservedDistalHandPoint(
    reliableHandObservations,
    proximalPoint,
    maximumHandClusterSpan,
  );
  // When a dominant hand reaches inward across the torso, its elbow and wrist
  // are commonly occluded before the three labelled hand endpoints disappear.
  // A complete current-frame hand cluster plus a reliable same-side shoulder
  // is enough evidence to keep that real hand available; two-point clusters
  // still require the full shoulder/elbow support used everywhere else.
  const completeHandClusterSupportedByShoulder =
    reliableHandLandmarks === directHandObservations.length &&
    shoulder.confidence >= RELIABLE_LANDMARK_CONFIDENCE;
  const observedDistalHandNearWrist =
    observedDistalHand !== null &&
    wrist.point !== null &&
    distance(observedDistalHand.point, wrist.point) <=
      Math.max(0.045, Math.min(0.12, (upperArmLength ?? 0.12) * 0.85));
  const singleEndpointSupportedByWrist =
    reliableHandLandmarks === 1 &&
    observedDistalHandNearWrist &&
    armSupport >= MINIMUM_ARM_SUPPORT_FOR_HAND;
  const handAccepted =
    observedDistalHand !== null &&
    (singleEndpointSupportedByWrist ||
      (reliableHandLandmarks >= 2 &&
        (armSupport >= MINIMUM_ARM_SUPPORT_FOR_HAND || completeHandClusterSupportedByShoulder)));
  const handPoint = handAccepted ? observedDistalHand.point : null;
  const handNearWrist =
    handPoint !== null && observedDistalHandNearWrist;
  const handDistalToElbow =
    handPoint !== null && elbow.point !== null && upperArmLength !== null
      ? distance(handPoint, elbow.point) >=
          Math.max(0.025, Math.min(0.07, upperArmLength * 0.35)) &&
        distance(handPoint, elbow.point) <= Math.min(0.3, upperArmLength * 2.2)
      : reliableHandLandmarks >= 3;
  // The farthest validated, directly observed hand endpoint is the blade. The
  // wrist remains a support/continuity anchor but is not averaged into the
  // cursor or used to project any imaginary fingertip/tool beyond the hand.
  const bladeUsesHandCluster =
    handAccepted && (wrist.point === null || handNearWrist || handDistalToElbow);
  const bladePoint = bladeUsesHandCluster ? handPoint : wrist.point;
  const bladeLandmarkConfidence = handAccepted
    ? bladeUsesHandCluster
      ? observedDistalHand.confidence
      : wrist.confidence
    : wrist.confidence;
  const confidences = [shoulder.confidence, elbow.confidence, rawWrist.confidence];
  return {
    shoulder,
    elbow,
    wrist,
    hand: {
      point: handPoint,
      confidence: handConfidence,
      reliableLandmarkCount: reliableHandLandmarks,
    },
    bladePoint,
    confidence:
      bladePoint !== null
        ? shoulder.confidence * 0.15 +
          elbow.confidence * 0.25 +
          bladeLandmarkConfidence * 0.6
        : 0,
    reliableJointCount: confidences.filter(
      (confidence) => confidence >= RELIABLE_LANDMARK_CONFIDENCE,
    ).length,
  };
}

export function mirrorObservation(observation: PoseObservation): PoseObservation {
  return {
    ...observation,
    torsoCenter: { x: 1 - observation.torsoCenter.x, y: observation.torsoCenter.y },
    landmarks: observation.landmarks.map((landmark) => ({
      ...landmark,
      x: 1 - landmark.x,
    })),
  };
}

export function clampNormalizedPoint(point: Point): Point {
  return {
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y)),
  };
}
