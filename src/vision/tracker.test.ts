import type { NormalizedLandmark, PoseObservation } from '../types/game';
import { describe, expect, it } from 'vitest';
import {
  CalibrationCollector,
  SinglePlayerTracker,
  TwoPlayerTracker,
  hasFreshLockedIdentityFrame,
  type PlayerTrackBinding,
} from './tracker';

function landmark(x: number, y: number, confidence = 1): NormalizedLandmark {
  return { x, y, z: 0, visibility: confidence, presence: confidence };
}

function pose(centerX: number, temporaryId: string, confidence = 1): PoseObservation {
  const landmarks = Array.from({ length: 33 }, () => landmark(centerX, 0.5, confidence));
  landmarks[0] = landmark(centerX, 0.18, confidence);
  landmarks[7] = landmark(centerX - 0.035, 0.185, confidence);
  landmarks[8] = landmark(centerX + 0.035, 0.185, confidence);
  landmarks[11] = landmark(centerX - 0.05, 0.35, confidence);
  landmarks[12] = landmark(centerX + 0.05, 0.35, confidence);
  landmarks[15] = landmark(centerX - 0.16, 0.42, confidence);
  landmarks[16] = landmark(centerX + 0.16, 0.42, confidence);
  for (const index of [17, 19, 21]) {
    landmarks[index] = landmark(centerX - 0.16, 0.42, confidence);
  }
  for (const index of [18, 20, 22]) {
    landmarks[index] = landmark(centerX + 0.16, 0.42, confidence);
  }
  landmarks[23] = landmark(centerX - 0.04, 0.65, confidence);
  landmarks[24] = landmark(centerX + 0.04, 0.65, confidence);
  return {
    temporaryId,
    score: confidence,
    landmarks,
    torsoCenter: { x: centerX, y: 0.5 },
  };
}

function shapedPose(
  centerX: number,
  temporaryId: string,
  shoulderWidth: number,
  hipConfidence = 1,
): PoseObservation {
  const observation = pose(centerX, temporaryId);
  observation.landmarks[11] = landmark(centerX - shoulderWidth / 2, 0.35);
  observation.landmarks[12] = landmark(centerX + shoulderWidth / 2, 0.35);
  observation.landmarks[13] = landmark(centerX - shoulderWidth * 0.8, 0.47);
  observation.landmarks[14] = landmark(centerX + shoulderWidth * 0.8, 0.47);
  observation.landmarks[23] = landmark(centerX - 0.04, 0.65, hipConfidence);
  observation.landmarks[24] = landmark(centerX + 0.04, 0.65, hipConfidence);
  return observation;
}

function withLeftHand(observation: PoseObservation, x: number, y = 0.42): PoseObservation {
  for (const index of [15, 17, 19, 21]) {
    observation.landmarks[index] = landmark(x, y);
  }
  return observation;
}

/** Mimics two small upper bodies in a wide, low-detail camera frame. */
function wideShotPose(
  centerX: number,
  temporaryId: string,
  shoulderWidth = 0.09,
): PoseObservation {
  const observation = shapedPose(centerX, temporaryId, shoulderWidth);
  const setConfidence = (indices: readonly number[], confidence: number): void => {
    for (const index of indices) {
      const point = observation.landmarks[index];
      if (point === undefined) continue;
      observation.landmarks[index] = landmark(point.x, point.y, confidence);
    }
  };
  observation.landmarks[0] = landmark(centerX, 0.16, 0.3);
  observation.landmarks[7] = landmark(centerX - 0.035, 0.17, 0.3);
  observation.landmarks[8] = landmark(centerX + 0.035, 0.17, 0.3);
  setConfidence([11, 12], 0.65);
  setConfidence([13, 14], 0.58);
  setConfidence([15, 16], 0.31);
  setConfidence([17, 18, 19, 20, 21, 22], 0.12);
  setConfidence([23, 24], 0.08);
  return observation;
}

function withClearActiveHand(
  observation: PoseObservation,
  hand: 'left' | 'right',
): PoseObservation {
  const indices = hand === 'left' ? [15, 17, 19, 21] : [16, 18, 20, 22];
  for (const index of indices) {
    const point = observation.landmarks[index];
    if (point === undefined) continue;
    observation.landmarks[index] = landmark(point.x, point.y, 0.68);
  }
  return observation;
}

function withHeadAnchor(
  observation: PoseObservation,
  x: number,
  y = 0.18,
  span = 0.07,
  confidence = 0.9,
): PoseObservation {
  observation.landmarks[0] = landmark(x, y, confidence);
  observation.landmarks[7] = landmark(x - span / 2, y + 0.005, confidence);
  observation.landmarks[8] = landmark(x + span / 2, y + 0.005, confidence);
  return observation;
}

function headPose(
  centerX: number,
  temporaryId: string,
  headSpan: number,
): PoseObservation {
  return withHeadAnchor(shapedPose(centerX, temporaryId, 0.12), centerX, 0.18, headSpan);
}

function withoutArms(observation: PoseObservation): PoseObservation {
  for (let index = 13; index <= 22; index += 1) {
    const point = observation.landmarks[index];
    if (point !== undefined) observation.landmarks[index] = landmark(point.x, point.y, 0.01);
  }
  return observation;
}

function withoutHead(observation: PoseObservation): PoseObservation {
  for (const index of [0, 7, 8]) {
    const point = observation.landmarks[index];
    if (point !== undefined) observation.landmarks[index] = landmark(point.x, point.y, 0.01);
  }
  return observation;
}

function withoutEarSpan(observation: PoseObservation): PoseObservation {
  const rightEar = observation.landmarks[8];
  if (rightEar !== undefined) {
    observation.landmarks[8] = landmark(rightEar.x, rightEar.y, 0.01);
  }
  return observation;
}

function calibratedHeadLockedTracker(
  options: ConstructorParameters<typeof TwoPlayerTracker>[1] = {},
): TwoPlayerTracker {
  const tracker = new TwoPlayerTracker(bindings, {
    mirrored: false,
    acquisitionFrames: 1,
    ...options,
  });
  const collector = new CalibrationCollector(bindings, {
    minimumSamples: 2,
    minimumHeadConfidence: 0.3,
  });
  collector.add(tracker.update([
    headPose(0.25, 'red-cal-0', 0.055),
    headPose(0.75, 'blue-cal-0', 0.09),
  ], 0));
  collector.add(tracker.update([
    headPose(0.255, 'red-cal-1', 0.055),
    headPose(0.745, 'blue-cal-1', 0.09),
  ], 33));
  const redProfile = collector.finalize('red');
  const blueProfile = collector.finalize('blue');
  if (!redProfile || !blueProfile) throw new Error('Head calibration fixture failed');
  tracker.lockIdentities([redProfile, blueProfile]);
  return tracker;
}

const bindings: [PlayerTrackBinding, PlayerTrackBinding] = [
  { participantId: 'red', lane: 'left', activeHand: 'left' },
  { participantId: 'blue', lane: 'right', activeHand: 'right' },
];

describe('TwoPlayerTracker', () => {
  it('assigns reversed detections by lane and exposes the configured active wrist', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      allowBothWrists: true,
    });
    const frame = tracker.update([pose(0.75, 'blue-pose'), pose(0.25, 'red-pose')], 100);

    expect(frame.players[0].participantId).toBe('red');
    expect(frame.players[0].sourceTemporaryId).toBe('red-pose');
    expect(frame.players[0].state).toBe('tracking');
    expect(frame.players[0].activeWrist?.x).toBeCloseTo(0.09);
    expect(frame.players[0].otherWrist?.x).toBeCloseTo(0.41);
    expect(frame.players[1].sourceTemporaryId).toBe('blue-pose');
    expect(frame.players[1].activeWrist?.x).toBeCloseTo(0.91);
  });

  it('holds an identity through a short gap but never emits a stale blade', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      lostAfterMs: 400,
    });
    tracker.update([pose(0.25, 'red'), pose(0.75, 'blue')], 0);

    const holding = tracker.update([], 250);
    expect(holding.players[0].state).toBe('holding');
    expect(holding.players[0].lostForMs).toBe(250);
    expect(holding.players[0].activeWrist).toBeNull();

    const lost = tracker.update([], 450);
    expect(lost.players[0].state).toBe('lost');
    expect(lost.players[1].state).toBe('lost');
  });

  it('keeps a brief hand-confidence dropout visible but explicitly non-scoring', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    tracker.update([pose(0.25, 'red'), pose(0.75, 'blue')], 0);

    const weakRedHand = pose(0.25, 'red-weak-hand');
    for (const index of [15, 17, 19, 21]) {
      weakRedHand.landmarks[index] = landmark(0.09, 0.42, 0.05);
    }
    const shortDropout = tracker.update([weakRedHand, pose(0.75, 'blue-live')], 66);

    expect(shortDropout.players[0].state).toBe('tracking');
    expect(shortDropout.players[0].activeWrist?.x).toBeCloseTo(0.09);
    expect(shortDropout.players[0].wrists.left.point).toBeNull();
    expect(shortDropout.players[0].confidence).toBeGreaterThanOrEqual(0.45);
    expect(shortDropout.players[0].confidence).toBeLessThan(0.55);

    const expired = tracker.update([weakRedHand, pose(0.75, 'blue-live-2')], 133);
    expect(expired.players[0].activeWrist).toBeNull();
    expect(expired.players[0].confidence).toBe(0);
  });

  it('does not blink a matched player merely because skipping that detection is near-equal', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      ambiguityMargin: 0.5,
    });
    tracker.update(
      [shapedPose(0.25, 'red-start', 0.09), shapedPose(0.75, 'blue-start', 0.23)],
      0,
    );

    const oneVisible = tracker.update([shapedPose(0.27, 'red-live', 0.09)], 33);
    expect(oneVisible.players[0].state).toBe('tracking');
    expect(oneVisible.players[0].sourceTemporaryId).toBe('red-live');
    expect(oneVisible.players[0].activeWrist).not.toBeNull();
    expect(oneVisible.players[1].state).toBe('holding');
    expect(oneVisible.players[1].activeWrist).toBeNull();
  });

  it('refuses an ambiguous center crossing instead of silently swapping scores', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      ambiguityMargin: 0.2,
    });
    tracker.update([pose(0.25, 'red'), pose(0.75, 'blue')], 0);

    const crossing = tracker.update([pose(0.49, 'a'), pose(0.51, 'b')], 33);
    expect(crossing.players[0].state).toBe('holding');
    expect(crossing.players[1].state).toBe('holding');
    expect(crossing.players[0].activeWrist).toBeNull();
    expect(crossing.unassignedObservations).toHaveLength(2);
    expect(crossing.candidateDiagnostics).toMatchObject({
      inputObservationCount: 2,
      acceptedCandidateCount: 2,
      assignedCandidateCount: 0,
      rejectedCandidateCount: 0,
      centerRejectedCandidateCount: 2,
    });
  });

  it('acquires unlocked players only inside their own lane and reports per-side counts', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const frame = tracker.update(
      [pose(0.5, 'center'), pose(0.75, 'blue')],
      0,
    );

    expect(frame.players[0].sourceTemporaryId).toBeNull();
    expect(frame.players[1].sourceTemporaryId).toBe('blue');
    expect(frame.candidateDiagnostics).toMatchObject({
      assignedCandidateCount: 1,
      centerRejectedCandidateCount: 1,
      laneDiagnostics: {
        left: {
          rawCandidateCount: 0,
          acceptedCandidateCount: 0,
          assignedCandidateCount: 0,
          ambiguousCandidateCount: 0,
        },
        right: {
          rawCandidateCount: 1,
          acceptedCandidateCount: 1,
          assignedCandidateCount: 1,
          ambiguousCandidateCount: 0,
        },
      },
    });
  });

  it('marks two near-equal candidates in one lane ambiguous without blocking the other lane', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const frame = tracker.update(
      [
        shapedPose(0.25, 'left-a', 0.1),
        shapedPose(0.251, 'left-b', 0.1),
        shapedPose(0.75, 'right', 0.16),
      ],
      0,
    );

    expect(frame.players[0].sourceTemporaryId).toBeNull();
    expect(frame.players[1].sourceTemporaryId).toBe('right');
    expect(frame.candidateDiagnostics.laneDiagnostics.left).toMatchObject({
      rawCandidateCount: 2,
      acceptedCandidateCount: 2,
      assignedCandidateCount: 0,
      ambiguousCandidateCount: 2,
    });
    expect(frame.candidateDiagnostics.laneDiagnostics.right.assignedCandidateCount).toBe(1);
  });

  it('mirrors all landmarks before lane assignment and wrist output', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: true,
      acquisitionFrames: 1,
    });
    const frame = tracker.update([pose(0.75, 'red-source'), pose(0.25, 'blue-source')], 100);

    expect(frame.players[0].sourceTemporaryId).toBe('red-source');
    expect(frame.players[0].torsoCenter?.x).toBeCloseTo(0.25);
    expect(frame.players[0].activeWrist?.x).toBeCloseTo(0.41);
    expect(frame.players[1].torsoCenter?.x).toBeCloseTo(0.75);
  });

  it('keeps both wrist observations while allowing single-hand game output', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      allowBothWrists: false,
    });
    const frame = tracker.update([pose(0.25, 'red'), pose(0.75, 'blue')], 100);

    expect(frame.players[0].activeWrist).not.toBeNull();
    expect(frame.players[0].otherWrist).toBeNull();
    expect(frame.players[0].wrists.right.point).not.toBeNull();
  });

  it('defaults to exactly one output blade per player', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const frame = tracker.update([pose(0.25, 'red'), pose(0.75, 'blue')], 100);

    expect(frame.players.every((player) => player.activeWrist !== null)).toBe(true);
    expect(frame.players.every((player) => player.otherWrist === null)).toBe(true);
    expect(frame.players[0].wrists.right.point).not.toBeNull();
    expect(frame.players[1].wrists.left.point).not.toBeNull();
  });

  it('tracks a player from head, shoulders and arms when both hips have low confidence', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const red = shapedPose(0.25, 'red-upper-body', 0.1, 0.05);
    const blue = shapedPose(0.75, 'blue-upper-body', 0.1, 0.05);
    const frame = tracker.update([red, blue], 100);

    expect(frame.players[0].state).toBe('tracking');
    expect(frame.players[0].sourceTemporaryId).toBe('red-upper-body');
    expect(frame.players[0].poseQuality?.hipConfidence).toBeCloseTo(0.05);
    expect(frame.players[0].bodyAnchors.headCenter).not.toBeNull();
    expect(frame.players[0].arms.left?.elbow.point).not.toBeNull();
    expect(frame.players[0].activeWrist).not.toBeNull();
  });

  it('keeps the blade alive from visible hand landmarks when the wrist point is occluded', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const red = pose(0.25, 'red-hand-fallback');
    red.landmarks[15] = landmark(0.09, 0.42, 0.05);
    const frame = tracker.update([red, pose(0.75, 'blue')], 100);

    expect(frame.players[0].wrists.left.point).toBeNull();
    expect(frame.players[0].arms.left?.hand.reliableLandmarkCount).toBe(3);
    expect(frame.players[0].activeWrist).not.toBeNull();
  });

  it('uses stable multi-joint body proportions when detection order reverses', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      laneWeight: 0,
      motionWeight: 0,
      geometryWeight: 1,
      ambiguityMargin: 0.01,
    });
    tracker.update(
      [shapedPose(0.25, 'red-first', 0.1), shapedPose(0.75, 'blue-first', 0.22)],
      0,
    );
    const reversed = tracker.update(
      [shapedPose(0.76, 'blue-next', 0.22), shapedPose(0.24, 'red-next', 0.1)],
      33,
    );

    expect(reversed.players[0].sourceTemporaryId).toBe('red-next');
    expect(reversed.players[1].sourceTemporaryId).toBe('blue-next');
  });

  it('selects two registered players from three candidates and reports the spectator', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    tracker.update(
      [shapedPose(0.25, 'red-register', 0.1), shapedPose(0.75, 'blue-register', 0.21)],
      0,
    );

    const frame = tracker.update(
      [
        shapedPose(0.5, 'spectator', 0.3),
        shapedPose(0.7, 'blue-live', 0.21),
        shapedPose(0.3, 'red-live', 0.1),
      ],
      33,
    );

    expect(frame.players[0].sourceTemporaryId).toBe('red-live');
    expect(frame.players[1].sourceTemporaryId).toBe('blue-live');
    expect(frame.unassignedObservations.map((observation) => observation.temporaryId)).toEqual([
      'spectator',
    ]);
  });

  it('keeps player identity when all four MediaPipe candidate positions reorder', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    tracker.update(
      [shapedPose(0.25, 'red-0', 0.09), shapedPose(0.75, 'blue-0', 0.23)],
      0,
    );
    const frame = tracker.update(
      [
        shapedPose(0.86, 'audience-right', 0.32),
        shapedPose(0.72, 'blue-1', 0.23),
        shapedPose(0.12, 'audience-left', 0.29),
        shapedPose(0.28, 'red-1', 0.09),
      ],
      33,
    );

    expect(frame.players.map((player) => player.sourceTemporaryId)).toEqual(['red-1', 'blue-1']);
    expect(frame.unassignedObservations).toHaveLength(2);
    expect(frame.unassignedObservations.map((pose) => pose.temporaryId).sort()).toEqual([
      'audience-left',
      'audience-right',
    ]);
  });

  it('keeps both registered blades continuous across repeated order changes and brief hand dips', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    tracker.update(
      [shapedPose(0.25, 'red-0', 0.09), shapedPose(0.75, 'blue-0', 0.23)],
      0,
    );

    for (let frameIndex = 1; frameIndex <= 18; frameIndex += 1) {
      const red = shapedPose(0.25 + frameIndex * 0.001, `red-${frameIndex}`, 0.09);
      const blue = shapedPose(0.75 - frameIndex * 0.001, `blue-${frameIndex}`, 0.23);
      if (frameIndex % 4 === 0) {
        for (const index of [15, 17, 19, 21]) {
          red.landmarks[index] = landmark(0.09, 0.42, 0.05);
        }
      }
      const observations = frameIndex % 2 === 0 ? [blue, red] : [red, blue];
      const frame = tracker.update(observations, frameIndex * 33);

      expect(frame.players.map((player) => player.sourceTemporaryId)).toEqual([
        `red-${frameIndex}`,
        `blue-${frameIndex}`,
      ]);
      expect(frame.players.every((player) => player.state === 'tracking')).toBe(true);
      expect(frame.players.every((player) => player.activeWrist !== null)).toBe(true);
      if (frameIndex % 4 === 0) {
        expect(frame.players[0].confidence).toBeLessThan(0.55);
      }
    }
  });

  it('tracks both small wide-shot players with only shoulders and elbows reliable', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 3,
    });

    let latest = tracker.update(
      [wideShotPose(0.25, 'red-0'), wideShotPose(0.75, 'blue-0', 0.12)],
      0,
    );
    for (let frameIndex = 1; frameIndex <= 8; frameIndex += 1) {
      const red = wideShotPose(0.25 + frameIndex * 0.0005, `red-${frameIndex}`);
      const blue = wideShotPose(0.75 - frameIndex * 0.0005, `blue-${frameIndex}`, 0.12);
      latest = tracker.update(
        frameIndex % 2 === 0 ? [blue, red] : [red, blue],
        frameIndex * 50,
      );
    }

    expect(latest.players.map((player) => player.sourceTemporaryId)).toEqual(['red-8', 'blue-8']);
    expect(latest.players.every((player) => player.state === 'tracking')).toBe(true);
    expect(latest.players.every((player) => player.activeWrist !== null)).toBe(true);
    expect(latest.players.every((player) => (player.poseQuality?.score ?? 1) < 0.5)).toBe(true);
    expect(latest.players.every((player) => player.poseQuality?.reliableLandmarkCount === 4)).toBe(true);
    expect(latest.candidateDiagnostics).toMatchObject({
      inputObservationCount: 2,
      acceptedCandidateCount: 2,
      assignedCandidateCount: 2,
      rejectedCandidateCount: 0,
    });
  });

  it('lets a clear active hand score when the other hand, hips and ears lower global quality', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const red = withClearActiveHand(wideShotPose(0.25, 'red'), 'left');
    const blue = withClearActiveHand(wideShotPose(0.75, 'blue', 0.12), 'right');
    const frame = tracker.update([blue, red], 100);

    expect(frame.players.every((player) => player.state === 'tracking')).toBe(true);
    expect(frame.players.every((player) => player.activeWrist !== null)).toBe(true);
    // FruitDuelGame scores at 0.55. Identity quality is allowed to come from
    // the stable upper body, but the active arm remains the final blade gate.
    expect(frame.players.every((player) => player.confidence >= 0.55)).toBe(true);
    expect(frame.players.every((player) => (player.poseQuality?.score ?? 1) < 0.55)).toBe(true);
  });

  it('distinguishes no model observations from candidates rejected by tracker gates', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const noModelCandidate = tracker.update([], 0);
    expect(noModelCandidate.candidateDiagnostics).toMatchObject({
      inputObservationCount: 0,
      acceptedCandidateCount: 0,
      assignedCandidateCount: 0,
      rejectedCandidateCount: 0,
    });

    const weak = pose(0.25, 'tracker-rejected', 0.05);
    weak.landmarks[11] = landmark(0.2, 0.35, 0.3);
    weak.landmarks[12] = landmark(0.3, 0.35, 0.3);
    const trackerRejected = tracker.update([weak], 50);
    expect(trackerRejected.candidateDiagnostics).toMatchObject({
      inputObservationCount: 1,
      acceptedCandidateCount: 0,
      assignedCandidateCount: 0,
      rejectedCandidateCount: 1,
      rejectionReasons: { lowPoseQuality: 1 },
    });
  });

  it('follows atomically locked identities through a two-player lane crossing', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      ambiguityMargin: 0.04,
    });
    const collector = new CalibrationCollector(bindings, {
      minimumSamples: 1,
      minimumEarSpanSamples: 1,
    });
    const calibrationFrame = tracker.update(
      [shapedPose(0.25, 'red-start', 0.09), shapedPose(0.75, 'blue-start', 0.23)],
      0,
    );
    collector.add(calibrationFrame);
    const redProfile = collector.finalize('red');
    const blueProfile = collector.finalize('blue');
    if (redProfile === null || blueProfile === null) {
      throw new Error('Crossing calibration fixture failed');
    }
    tracker.lockIdentities([redProfile, blueProfile]);
    tracker.update(
      [shapedPose(0.34, 'red-a', 0.09), shapedPose(0.66, 'blue-a', 0.23)],
      50,
    );
    tracker.update(
      [shapedPose(0.43, 'red-b', 0.09), shapedPose(0.57, 'blue-b', 0.23)],
      100,
    );
    tracker.update(
      [shapedPose(0.48, 'blue-c', 0.23), shapedPose(0.52, 'red-c', 0.09)],
      150,
    );
    const crossed = tracker.update(
      [shapedPose(0.43, 'blue-crossed', 0.23), shapedPose(0.57, 'red-crossed', 0.09)],
      200,
    );

    expect(crossed.players[0].sourceTemporaryId).toBe('red-crossed');
    expect(crossed.players[1].sourceTemporaryId).toBe('blue-crossed');
    expect(crossed.players.every((player) => player.state === 'tracking')).toBe(true);
  });

  it('holds the occluded identity without a ghost blade and resumes after separation', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      lostAfterMs: 400,
      identityRetentionMs: 2_000,
    });
    tracker.update(
      [shapedPose(0.25, 'red-start', 0.09), shapedPose(0.75, 'blue-start', 0.23)],
      0,
    );

    const overlap = tracker.update([shapedPose(0.5, 'visible-red', 0.09)], 180);
    const hiddenBlue = overlap.players[1];
    expect(hiddenBlue.state).toBe('holding');
    expect(hiddenBlue.sourceTemporaryId).toBeNull();
    expect(hiddenBlue.activeWrist).toBeNull();

    const separated = tracker.update(
      [shapedPose(0.7, 'blue-return', 0.23), shapedPose(0.3, 'red-return', 0.09)],
      330,
    );
    expect(separated.players.map((player) => player.sourceTemporaryId)).toEqual([
      'red-return',
      'blue-return',
    ]);
  });

  it('keeps the identity template after tracking is lost, then reacquires the same player', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
      lostAfterMs: 200,
      identityRetentionMs: 1_500,
    });
    tracker.update(
      [shapedPose(0.25, 'red-start', 0.09), shapedPose(0.75, 'blue-start', 0.23)],
      0,
    );
    const lost = tracker.update([], 500);
    expect(lost.players[0].state).toBe('lost');

    const returned = tracker.update(
      [shapedPose(0.76, 'blue-return', 0.23), shapedPose(0.24, 'red-return', 0.09)],
      700,
    );
    expect(returned.players[0].state).toBe('tracking');
    expect(returned.players[0].sourceTemporaryId).toBe('red-return');
  });

  it('rejects an impossible hand jump and only holds the last cursor as non-scoring', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const initial = tracker.update(
      [withLeftHand(pose(0.25, 'red-initial'), 0.09), pose(0.75, 'blue')],
      0,
    );
    expect(initial.players[0].activeWrist).not.toBeNull();

    const jumped = tracker.update(
      [withLeftHand(pose(0.25, 'red-jump'), 0.88), pose(0.75, 'blue')],
      33,
    );
    expect(jumped.players[0].state).toBe('tracking');
    expect(jumped.players[0].activeWrist?.x).toBeCloseTo(0.09);
    expect(jumped.players[0].confidence).toBeLessThan(0.55);

    const recovered = tracker.update(
      [withLeftHand(pose(0.25, 'red-recovered'), 0.12), pose(0.75, 'blue')],
      66,
    );
    expect(recovered.players[0].activeWrist?.x).toBeCloseTo(0.12);
  });

  it('allows a legitimate fast swing within the shoulder-scaled continuity gate', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    tracker.update(
      [withLeftHand(pose(0.25, 'red-start'), 0.08), pose(0.75, 'blue')],
      0,
    );
    const swing = tracker.update(
      [withLeftHand(pose(0.25, 'red-swing'), 0.24), pose(0.75, 'blue')],
      33,
    );
    expect(swing.players[0].activeWrist?.x).toBeCloseTo(0.24);
  });

  it('seals two calibrated head identities and keeps them stable across candidate reordering', () => {
    const tracker = calibratedHeadLockedTracker();

    for (let frameIndex = 1; frameIndex <= 12; frameIndex += 1) {
      const red = headPose(0.255 + frameIndex * 0.002, `red-live-${frameIndex}`, 0.055);
      const blue = headPose(0.745 - frameIndex * 0.002, `blue-live-${frameIndex}`, 0.09);
      const spectator = headPose(0.5, `spectator-${frameIndex}`, 0.13);
      const observations = frameIndex % 2 === 0
        ? [spectator, blue, red]
        : [red, spectator, blue];
      const frame = tracker.update(observations, 33 + frameIndex * 33);

      expect(frame.players.map(({ sourceTemporaryId }) => sourceTemporaryId)).toEqual([
        `red-live-${frameIndex}`,
        `blue-live-${frameIndex}`,
      ]);
      expect(frame.players.every(({ identity }) => identity.locked && identity.headMatched)).toBe(true);
      expect(frame.unassignedObservations.map(({ temporaryId }) => temporaryId)).toEqual([
        `spectator-${frameIndex}`,
      ]);
    }
  });

  it('requires a fresh, currently head-matched pair before a ready screen may start', () => {
    const tracker = calibratedHeadLockedTracker();
    const frame = tracker.update([
      headPose(0.26, 'red-ready', 0.055),
      headPose(0.74, 'blue-ready', 0.09),
    ], 66);

    expect(hasFreshLockedIdentityFrame(frame, ['red', 'blue'], 1_466, 1_400)).toBe(true);
    expect(hasFreshLockedIdentityFrame(frame, ['red', 'blue'], 1_467, 1_400)).toBe(false);
    expect(hasFreshLockedIdentityFrame(frame, ['red', 'missing'], 100, 1_400)).toBe(false);
  });

  it('keeps the registered head identity when the arms leave frame and never borrows a spectator blade', () => {
    const tracker = calibratedHeadLockedTracker();
    const redWithoutArms = withoutArms(headPose(0.27, 'red-no-arms', 0.055));
    withHeadAnchor(redWithoutArms, 0.27, 0.18, 0.055, 0.35);
    redWithoutArms.landmarks[23] = landmark(0.23, 0.65, 0.01);
    redWithoutArms.landmarks[24] = landmark(0.31, 0.65, 0.01);
    const spectator = headPose(0.45, 'spectator-full-arms', 0.13);
    const frame = tracker.update([
      spectator,
      headPose(0.73, 'blue-live', 0.09),
      redWithoutArms,
    ], 99);

    expect(frame.players[0].sourceTemporaryId).toBe('red-no-arms');
    expect(frame.players[0].identity).toMatchObject({ locked: true, headMatched: true });
    expect(frame.players[0].state).toBe('tracking');
    expect(frame.players[0].activeWrist).toBeNull();
    expect(frame.players[0].confidence).toBe(0);
    expect(frame.players[1].sourceTemporaryId).toBe('blue-live');
    expect(frame.unassignedObservations.map(({ temporaryId }) => temporaryId)).toContain(
      'spectator-full-arms',
    );
  });

  it('fails closed after a long identity loss so a spectator in the same spot cannot take over', () => {
    const tracker = calibratedHeadLockedTracker({
      lostAfterMs: 150,
      identityRetentionMs: 500,
    });
    tracker.update([], 600);

    const attemptedTakeover = tracker.update([
      headPose(0.255, 'spectator-left-takeover', 0.055),
      headPose(0.745, 'spectator-right-takeover', 0.09),
    ], 650);

    expect(attemptedTakeover.players.every(({ sourceTemporaryId }) => sourceTemporaryId === null)).toBe(true);
    expect(attemptedTakeover.players.every(({ activeWrist }) => activeWrist === null)).toBe(true);
    expect(attemptedTakeover.players.every(
      ({ identity }) => identity.state === 'recalibration-required',
    )).toBe(true);
    expect(attemptedTakeover.unassignedObservations).toHaveLength(2);
  });

  it('never promotes a known spectator tracklet when it walks into a missing player position', () => {
    const tracker = calibratedHeadLockedTracker();
    const spectatorPositions = [0.5, 0.44, 0.38];
    spectatorPositions.forEach((spectatorX, index) => {
      const frame = tracker.update([
        headPose(0.26, `red-live-${index}`, 0.055),
        headPose(0.74, `blue-live-${index}`, 0.09),
        headPose(spectatorX, `spectator-known-${index}`, 0.055),
      ], 66 + index * 33);
      expect(frame.players[0].sourceTemporaryId).toBe(`red-live-${index}`);
      expect(frame.unassignedObservations.map(({ temporaryId }) => temporaryId)).toContain(
        `spectator-known-${index}`,
      );
    });

    [0.33, 0.29, 0.265].forEach((spectatorX, index) => {
      const frame = tracker.update([
        headPose(0.74, `blue-alone-${index}`, 0.09),
        headPose(spectatorX, `spectator-in-red-zone-${index}`, 0.055),
      ], 165 + index * 33);
      expect(frame.players[0].sourceTemporaryId).toBeNull();
      expect(frame.players[0].activeWrist).toBeNull();
      expect(frame.players[0].identity.state).toBe('occluded');
      expect(frame.unassignedObservations.map(({ temporaryId }) => temporaryId)).toContain(
        `spectator-in-red-zone-${index}`,
      );
    });
  });

  it('holds a locked player during a missing-head frame and restores only the matching head', () => {
    const tracker = calibratedHeadLockedTracker();
    const hiddenHead = withoutHead(headPose(0.27, 'red-head-hidden', 0.055));
    const occluded = tracker.update([
      hiddenHead,
      headPose(0.73, 'blue-live', 0.09),
      headPose(0.48, 'spectator', 0.13),
    ], 99);

    expect(occluded.players[0].sourceTemporaryId).toBeNull();
    expect(occluded.players[0].activeWrist).toBeNull();
    expect(occluded.players[0].identity.state).toBe('occluded');

    const pendingOne = tracker.update([
      headPose(0.72, 'blue-pending-1', 0.09),
      headPose(0.28, 'red-pending-1', 0.055),
    ], 132);
    expect(pendingOne.players[0].sourceTemporaryId).toBeNull();
    expect(pendingOne.players[0].activeWrist).toBeNull();
    const pendingTwo = tracker.update([
      headPose(0.72, 'blue-pending-2', 0.09),
      headPose(0.28, 'red-pending-2', 0.055),
    ], 165);
    expect(pendingTwo.players[0].sourceTemporaryId).toBeNull();
    expect(pendingTwo.players[0].activeWrist).toBeNull();
    const restored = tracker.update([
      headPose(0.72, 'blue-restored', 0.09),
      headPose(0.28, 'red-restored', 0.055),
    ], 198);
    expect(restored.players.map(({ sourceTemporaryId }) => sourceTemporaryId)).toEqual([
      'red-restored',
      'blue-restored',
    ]);
  });

  it('validates both identity profiles before changing either player lock', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings, { minimumSamples: 1 });
    collector.add(tracker.update([
      headPose(0.25, 'red-cal', 0.055),
      headPose(0.75, 'blue-cal', 0.09),
    ], 0));
    const redProfile = collector.finalize('red');
    if (!redProfile) throw new Error('Red fixture profile missing');

    expect(() => tracker.lockIdentities([redProfile])).toThrow(/blue/);
    const frame = tracker.update([
      headPose(0.25, 'red-live', 0.055),
      headPose(0.75, 'blue-live', 0.09),
    ], 33);
    expect(frame.players.every(({ identity }) => !identity.locked)).toBe(true);
  });
});

describe('SinglePlayerTracker', () => {
  it('returns the same player result shape without requiring a synthetic opponent', () => {
    const tracker = new SinglePlayerTracker(bindings[0], {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const frame = tracker.update([pose(0.5, 'solo')], 100);

    expect(frame.player).toBe(frame.players[0]);
    expect(frame.player.participantId).toBe('red');
    expect(frame.player.state).toBe('tracking');
    expect(frame.player.sourceTemporaryId).toBe('solo');
    expect(frame.player.activeWrist).not.toBeNull();
  });

  it('holds through a short single-player occlusion without emitting a stale wrist', () => {
    const tracker = new SinglePlayerTracker(bindings[0], {
      mirrored: false,
      acquisitionFrames: 1,
    });
    tracker.update([pose(0.25, 'solo')], 0);
    const missing = tracker.update([], 200);

    expect(missing.player.state).toBe('holding');
    expect(missing.player.activeWrist).toBeNull();
    expect(missing.player.lostForMs).toBe(200);
  });
});

describe('CalibrationCollector', () => {
  it('never samples a centre-zone candidate while the valid side still advances', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings, { minimumSamples: 2 });
    for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
      collector.add(tracker.update(
        [pose(0.5, `center-${frameIndex}`), pose(0.75, `blue-${frameIndex}`)],
        frameIndex * 33,
      ));
    }

    expect(collector.progress('red')).toBe(0);
    expect(collector.progress('blue')).toBe(1);
    expect(collector.diagnostics('red')?.sampleCount).toBe(0);
  });

  it('advances and freezes each side independently before the pair is atomically locked', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings);

    for (let frameIndex = 0; frameIndex < 16; frameIndex += 1) {
      collector.add(tracker.update([
        pose(0.25, `red-${frameIndex}`),
        withoutHead(pose(0.75, `blue-hidden-${frameIndex}`)),
      ], frameIndex * 33));
    }

    expect(collector.progress('red')).toBe(1);
    expect(collector.progress('blue')).toBe(0);
    const redProfile = collector.finalize('red');
    expect(redProfile).not.toBeNull();
    expect(collector.diagnostics('red')).toMatchObject({
      sampleCount: 16,
      earSpanSampleCount: 16,
      identitySource: 'ear-span',
      status: 'frozen',
    });

    for (let frameIndex = 16; frameIndex < 32; frameIndex += 1) {
      collector.add(tracker.update(
        [pose(0.75, `blue-${frameIndex}`)],
        frameIndex * 33,
      ));
    }

    expect(collector.diagnostics('red')?.sampleCount).toBe(16);
    expect(collector.progress('blue')).toBe(1);
    const blueProfile = collector.finalize('blue');
    expect(blueProfile).not.toBeNull();
    expect(collector.finalize('red')).toBe(redProfile);
    if (redProfile === null || blueProfile === null) {
      throw new Error('Independent calibration fixture failed');
    }

    tracker.lockIdentities([redProfile, blueProfile]);
    const locked = tracker.update(
      [pose(0.25, 'red-locked'), pose(0.75, 'blue-locked')],
      32 * 33,
    );
    expect(locked.players.every(({ identity }) => identity.locked)).toBe(true);
  });

  it('clears only the side whose head tracklet changes', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings, {
      minimumSamples: 3,
      minimumEarSpanSamples: 2,
    });
    for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
      collector.add(tracker.update(
        [pose(0.25, `red-${frameIndex}`), pose(0.75, `blue-${frameIndex}`)],
        frameIndex * 33,
      ));
    }
    const changed = tracker.update(
      [pose(0.25, 'red-stable'), pose(0.75, 'blue-replaced')],
      66,
    );
    const blue = changed.players[1];
    if (blue.headTrackletId === null) throw new Error('Blue tracklet fixture missing');
    collector.add({
      observedAt: changed.observedAt,
      players: [changed.players[0], { ...blue, headTrackletId: blue.headTrackletId + 100 }],
    });

    expect(collector.diagnostics('red')).toMatchObject({ sampleCount: 3, status: 'ready' });
    expect(collector.diagnostics('blue')).toMatchObject({ sampleCount: 1, status: 'collecting' });
  });

  it('uses six ear spans when available without requiring ears in every sample', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings);
    for (let frameIndex = 0; frameIndex < 16; frameIndex += 1) {
      const red = pose(0.25, `red-${frameIndex}`);
      const blue = pose(0.75, `blue-${frameIndex}`);
      if (frameIndex >= 6) {
        withoutEarSpan(red);
        withoutEarSpan(blue);
      }
      collector.add(tracker.update([red, blue], frameIndex * 33));
    }

    expect(collector.diagnostics('red')).toMatchObject({
      sampleCount: 16,
      earSpanSampleCount: 6,
      earSpanReady: true,
      identitySource: 'ear-span',
      status: 'ready',
    });
    expect(collector.finalize('red')?.identityAnchor?.headSpanToShoulderRatio).toBeGreaterThan(0);
  });

  it('uses an explicit stable shoulder and torso fallback when no ear span is available', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings);
    for (let frameIndex = 0; frameIndex < 16; frameIndex += 1) {
      collector.add(tracker.update([
        withoutEarSpan(pose(0.25, `red-${frameIndex}`)),
        withoutEarSpan(pose(0.75, `blue-${frameIndex}`)),
      ], frameIndex * 33));
    }

    expect(collector.diagnostics('red')).toMatchObject({
      sampleCount: 16,
      earSpanSampleCount: 0,
      earSpanReady: false,
      fallbackReady: true,
      identitySource: 'shoulder-torso-fallback',
      status: 'ready',
    });
    const profile = collector.finalize('red');
    expect(profile).not.toBeNull();
    expect(profile?.identityAnchor?.headSpanToShoulderRatio).toBeUndefined();
    expect(profile?.identityAnchor).toMatchObject({
      sampleCount: 16,
      earSpanSampleCount: 0,
      source: 'shoulder-torso-fallback',
    });
  });

  it('does not finalize an unstable shoulder and torso fallback', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const seed = tracker.update([pose(0.25, 'red-seed'), pose(0.75, 'blue-seed')], 0);
    const collector = new CalibrationCollector(bindings);
    const redSeed = seed.players[0];
    if (redSeed.headTrackletId === null) throw new Error('Red tracklet fixture missing');

    for (let frameIndex = 0; frameIndex < 16; frameIndex += 1) {
      const observation = withoutEarSpan(
        shapedPose(0.25, `red-unstable-${frameIndex}`, frameIndex % 2 === 0 ? 0.05 : 0.2),
      );
      collector.add({
        observedAt: frameIndex * 33,
        players: [{
          ...redSeed,
          sourceTemporaryId: observation.temporaryId,
          observation,
          headTrackletId: redSeed.headTrackletId,
        }],
      });
    }

    expect(collector.diagnostics('red')).toMatchObject({
      sampleCount: 16,
      earSpanSampleCount: 0,
      fallbackReady: false,
      identitySource: null,
      status: 'collecting',
    });
    expect(collector.finalize('red')).toBeNull();
  });

  it('does not advance or finalize without a reliable head anchor', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings, {
      minimumSamples: 2,
      minimumHeadConfidence: 0.3,
    });
    for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
      collector.add(tracker.update([
        withoutHead(headPose(0.25, `red-${frameIndex}`, 0.055)),
        withoutHead(headPose(0.75, `blue-${frameIndex}`, 0.09)),
      ], frameIndex * 33));
    }

    expect(collector.progress('red')).toBe(0);
    expect(collector.progress('blue')).toBe(0);
    expect(collector.finalize('red')).toBeNull();
    expect(collector.finalize('blue')).toBeNull();
  });

  it('rejects a one-point head estimate without a measurable two-ear span', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings, {
      minimumSamples: 1,
      minimumHeadConfidence: 0.3,
    });
    const red = headPose(0.25, 'red-one-point', 0.055);
    const blue = headPose(0.75, 'blue-one-point', 0.09);
    for (const observation of [red, blue]) {
      observation.landmarks[0] = landmark(
        observation.torsoCenter.x,
        0.18,
        0.9,
      );
      observation.landmarks[7] = landmark(observation.torsoCenter.x, 0.18, 0.01);
      observation.landmarks[8] = landmark(observation.torsoCenter.x, 0.18, 0.01);
    }
    collector.add(tracker.update([red, blue], 0));

    expect(collector.progress('red')).toBe(0);
    expect(collector.progress('blue')).toBe(0);
    expect(collector.finalize('red')).toBeNull();
  });

  it('builds a median calibration profile from confirmed frames', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 1,
    });
    const collector = new CalibrationCollector(bindings, { minimumSamples: 2 });

    collector.add(tracker.update([pose(0.24, 'red-1'), pose(0.74, 'blue-1')], 100));
    collector.add(tracker.update([pose(0.26, 'red-2'), pose(0.76, 'blue-2')], 133));
    const profile = collector.finalize('red');

    expect(profile).not.toBeNull();
    expect(profile?.torsoCenter.x).toBeCloseTo(0.25);
    expect(profile?.shoulderWidth).toBeCloseTo(0.1);
    expect(profile?.torsoLength).toBeCloseTo(0.3);
    expect(profile?.capturedAt).toBe(133);
  });

  it('calibrates both low-resolution players without requiring visible fingers or hips', () => {
    const tracker = new TwoPlayerTracker(bindings, {
      mirrored: false,
      acquisitionFrames: 3,
    });
    const collector = new CalibrationCollector(bindings, { minimumSamples: 24 });

    for (let frameIndex = 0; frameIndex < 28; frameIndex += 1) {
      const red = wideShotPose(0.25, `red-${frameIndex}`);
      const blue = wideShotPose(0.75, `blue-${frameIndex}`, 0.12);
      const observations = frameIndex % 2 === 0 ? [red, blue] : [blue, red];
      collector.add(tracker.update(observations, frameIndex * 50));
    }

    expect(collector.progress('red')).toBe(1);
    expect(collector.progress('blue')).toBe(1);
    expect(collector.finalize('red')).toMatchObject({ participantId: 'red', lane: 'left' });
    expect(collector.finalize('blue')).toMatchObject({ participantId: 'blue', lane: 'right' });
    expect(collector.finalize('red')?.poseQuality).toBeLessThan(0.5);
  });
});
