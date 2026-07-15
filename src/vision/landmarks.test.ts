import type { NormalizedLandmark, PoseObservation } from '../types/game';
import { describe, expect, it } from 'vitest';
import {
  getArmObservation,
  getMultiJointPoseGeometry,
  getPoseQuality,
  POSE_LANDMARK,
  POSE_QUALITY_LANDMARK_COUNT,
} from './landmarks';

function landmark(x: number, y: number, confidence: number): NormalizedLandmark {
  return { x, y, z: 0, visibility: confidence, presence: confidence };
}

function upperBodyPose(hipConfidence = 0.9): PoseObservation {
  const landmarks = Array.from({ length: 33 }, () => landmark(0.5, 0.5, 0.05));
  for (const [index, x, y] of [
    [POSE_LANDMARK.nose, 0.5, 0.15],
    [POSE_LANDMARK.leftEye, 0.48, 0.14],
    [POSE_LANDMARK.rightEye, 0.52, 0.14],
    [POSE_LANDMARK.leftEar, 0.46, 0.16],
    [POSE_LANDMARK.rightEar, 0.54, 0.16],
    [POSE_LANDMARK.leftShoulder, 0.4, 0.32],
    [POSE_LANDMARK.rightShoulder, 0.6, 0.32],
    [POSE_LANDMARK.leftElbow, 0.34, 0.45],
    [POSE_LANDMARK.rightElbow, 0.66, 0.45],
    [POSE_LANDMARK.leftWrist, 0.28, 0.36],
    [POSE_LANDMARK.rightWrist, 0.72, 0.36],
    [POSE_LANDMARK.leftPinky, 0.25, 0.35],
    [POSE_LANDMARK.rightPinky, 0.75, 0.35],
    [POSE_LANDMARK.leftIndex, 0.24, 0.33],
    [POSE_LANDMARK.rightIndex, 0.76, 0.33],
    [POSE_LANDMARK.leftThumb, 0.27, 0.38],
    [POSE_LANDMARK.rightThumb, 0.73, 0.38],
  ] as const) {
    landmarks[index] = landmark(x, y, 0.9);
  }
  landmarks[POSE_LANDMARK.leftHip] = landmark(0.43, 0.66, hipConfidence);
  landmarks[POSE_LANDMARK.rightHip] = landmark(0.57, 0.66, hipConfidence);
  return {
    temporaryId: 'person',
    score: 0.9,
    landmarks,
    torsoCenter: { x: 0.5, y: 0.49 },
  };
}

describe('multi-joint pose analysis', () => {
  it('keeps a strong upper-body pose when both hips are outside the reliable frame', () => {
    const observation = upperBodyPose(0.05);
    const geometry = getMultiJointPoseGeometry(observation);

    expect(geometry).not.toBeNull();
    expect(geometry?.quality.reliableLandmarkCount).toBe(15);
    expect(geometry?.quality.score).toBeGreaterThan(0.65);
    expect(geometry?.quality.hipConfidence).toBeCloseTo(0.05);
    expect(geometry?.hipWidth).toBe(0);
    expect(geometry?.headCenter).not.toBeNull();
    expect(geometry?.torsoCenter.y).toBeGreaterThan(geometry?.shoulderCenter.y ?? 1);
  });

  it('scores head, shoulders, elbows, wrists and hips independently', () => {
    const quality = getPoseQuality(upperBodyPose());

    expect(quality.headConfidence).toBeCloseTo(0.9);
    expect(quality.shoulderConfidence).toBeCloseTo(0.9);
    expect(quality.elbowConfidence).toBeCloseTo(0.9);
    expect(quality.wristConfidence).toBeCloseTo(0.9);
    expect(quality.handConfidence).toBeCloseTo(0.9);
    expect(quality.hipConfidence).toBeCloseTo(0.9);
    expect(quality.landmarkCoverage).toBe(1);
    expect(POSE_QUALITY_LANDMARK_COUNT).toBe(17);
  });

  it('does not let low-confidence eye details lower body-focused pose quality', () => {
    const observation = upperBodyPose();
    const baseline = getPoseQuality(observation);
    for (const index of [
      POSE_LANDMARK.leftEyeInner,
      POSE_LANDMARK.leftEye,
      POSE_LANDMARK.leftEyeOuter,
      POSE_LANDMARK.rightEyeInner,
      POSE_LANDMARK.rightEye,
      POSE_LANDMARK.rightEyeOuter,
    ]) {
      observation.landmarks[index] = landmark(0.5, 0.14, 0.01);
    }

    expect(getPoseQuality(observation)).toEqual(baseline);
  });

  it('accepts a moderate wrist only when shoulder and elbow strongly support the arm', () => {
    const supported = upperBodyPose();
    supported.landmarks[POSE_LANDMARK.leftWrist] = landmark(0.28, 0.36, 0.32);
    expect(getArmObservation(supported, 'left', 0.42).wrist.point).not.toBeNull();

    supported.landmarks[POSE_LANDMARK.leftElbow] = landmark(0.34, 0.45, 0.2);
    expect(getArmObservation(supported, 'left', 0.42).wrist.point).toBeNull();
  });

  it('keeps two current-frame palm anchors through a small fast-motion confidence dip', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.leftWrist] = landmark(0.28, 0.36, 0.23);
    observation.landmarks[POSE_LANDMARK.leftPinky] = landmark(0.25, 0.35, 0.26);
    observation.landmarks[POSE_LANDMARK.leftIndex] = landmark(0.24, 0.33, 0.27);
    observation.landmarks[POSE_LANDMARK.leftThumb] = landmark(0.27, 0.38, 0.12);

    const arm = getArmObservation(observation, 'left', 0.42);
    expect(arm.hand.reliableLandmarkCount).toBe(2);
    expect(arm.bladePoint).toEqual(arm.hand.point);
    expect(arm.bladePoint).toEqual({ x: 0.24, y: 0.33 });
  });

  it('does not infer a phantom wrist from visible shoulder and elbow', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.rightWrist] = landmark(0.72, 0.36, 0.05);
    observation.landmarks[POSE_LANDMARK.rightPinky] = landmark(0.75, 0.35, 0.05);
    observation.landmarks[POSE_LANDMARK.rightIndex] = landmark(0.76, 0.33, 0.05);
    observation.landmarks[POSE_LANDMARK.rightThumb] = landmark(0.73, 0.38, 0.05);

    const arm = getArmObservation(observation, 'right', 0.42);
    expect(arm.shoulder.point).not.toBeNull();
    expect(arm.elbow.point).not.toBeNull();
    expect(arm.wrist.point).toBeNull();
    expect(arm.bladePoint).toBeNull();
  });

  it('uses multiple directly visible hand points when the wrist itself is occluded', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.leftWrist] = landmark(0.28, 0.36, 0.05);

    const arm = getArmObservation(observation, 'left', 0.42);
    expect(arm.wrist.point).toBeNull();
    expect(arm.hand.reliableLandmarkCount).toBe(3);
    expect(arm.hand.point).toEqual({ x: 0.24, y: 0.33 });
    expect(arm.bladePoint).toEqual(arm.hand.point);
  });

  it('keeps a complete hand cluster when a cross-body elbow and wrist are occluded', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.rightElbow] = landmark(0.54, 0.4, 0.08);
    observation.landmarks[POSE_LANDMARK.rightWrist] = landmark(0.47, 0.38, 0.08);
    observation.landmarks[POSE_LANDMARK.rightPinky] = landmark(0.45, 0.37, 0.88);
    observation.landmarks[POSE_LANDMARK.rightIndex] = landmark(0.44, 0.35, 0.9);
    observation.landmarks[POSE_LANDMARK.rightThumb] = landmark(0.47, 0.39, 0.86);

    const arm = getArmObservation(observation, 'right', 0.42);
    expect(arm.wrist.point).toBeNull();
    expect(arm.hand.reliableLandmarkCount).toBe(3);
    expect(arm.bladePoint).toEqual(arm.hand.point);
    expect(arm.bladePoint).toEqual({ x: 0.44, y: 0.35 });
  });

  it('still rejects an incomplete hand cluster when the supporting elbow is occluded', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.rightElbow] = landmark(0.54, 0.4, 0.08);
    observation.landmarks[POSE_LANDMARK.rightWrist] = landmark(0.47, 0.38, 0.08);
    observation.landmarks[POSE_LANDMARK.rightPinky] = landmark(0.45, 0.37, 0.88);
    observation.landmarks[POSE_LANDMARK.rightIndex] = landmark(0.44, 0.35, 0.9);
    observation.landmarks[POSE_LANDMARK.rightThumb] = landmark(0.47, 0.39, 0.08);

    expect(getArmObservation(observation, 'right', 0.42).bladePoint).toBeNull();
  });

  it('uses the farthest observed hand endpoint instead of a cluster centre or wrist', () => {
    const arm = getArmObservation(upperBodyPose(), 'left', 0.42);

    expect(arm.wrist.point).toEqual({ x: 0.28, y: 0.36 });
    expect(arm.bladePoint).toEqual(arm.hand.point);
    expect(arm.bladePoint).toEqual({ x: 0.24, y: 0.33 });
    expect(arm.bladePoint).not.toEqual(arm.wrist.point);
  });

  it('keeps a downward blade at the visible finger endpoints near the frame bottom', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.leftElbow] = landmark(0.34, 0.5, 0.9);
    observation.landmarks[POSE_LANDMARK.leftWrist] = landmark(0.3, 0.66, 0.9);
    observation.landmarks[POSE_LANDMARK.leftPinky] = landmark(0.29, 0.74, 0.9);
    observation.landmarks[POSE_LANDMARK.leftIndex] = landmark(0.3, 0.76, 0.9);
    observation.landmarks[POSE_LANDMARK.leftThumb] = landmark(0.32, 0.72, 0.9);

    const arm = getArmObservation(observation, 'left', 0.42);
    expect(arm.bladePoint).toEqual(arm.hand.point);
    expect(arm.bladePoint).toEqual({ x: 0.3, y: 0.76 });
    expect(arm.bladePoint?.y).toBeGreaterThan(arm.wrist.point?.y ?? 1);
  });

  it('uses one observed distal endpoint when a reliable wrist validates it at the frame edge', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.leftPinky] = landmark(0.25, 0.35, 0.05);
    observation.landmarks[POSE_LANDMARK.leftThumb] = landmark(0.27, 0.38, 0.05);

    const arm = getArmObservation(observation, 'left', 0.42);
    expect(arm.hand.reliableLandmarkCount).toBe(1);
    expect(arm.wrist.point).toEqual({ x: 0.28, y: 0.36 });
    expect(arm.bladePoint).toEqual({ x: 0.24, y: 0.33 });
  });

  it('selects a distal inlier when one directly observed endpoint jumps', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.leftIndex] = landmark(0.94, 0.02, 0.96);

    const arm = getArmObservation(observation, 'left', 0.42);
    expect(arm.hand.reliableLandmarkCount).toBe(3);
    expect(arm.bladePoint).toEqual({ x: 0.25, y: 0.35 });
    expect(arm.bladePoint?.x).toBeLessThan(0.3);
  });

  it('keeps the actual distal endpoint when the wrist is the jumping point', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.leftWrist] = landmark(0.86, 0.04, 0.96);

    const arm = getArmObservation(observation, 'left', 0.42);
    expect(arm.wrist.point).toEqual({ x: 0.86, y: 0.04 });
    expect(arm.bladePoint).toEqual(arm.hand.point);
    expect(arm.bladePoint).toEqual({ x: 0.24, y: 0.33 });
  });

  it('does not create a blade from only one visible finger when the wrist is lost', () => {
    const observation = upperBodyPose();
    observation.landmarks[POSE_LANDMARK.leftWrist] = landmark(0.28, 0.36, 0.05);
    observation.landmarks[POSE_LANDMARK.leftPinky] = landmark(0.25, 0.35, 0.05);
    observation.landmarks[POSE_LANDMARK.leftThumb] = landmark(0.27, 0.38, 0.05);

    const arm = getArmObservation(observation, 'left', 0.42);
    expect(arm.hand.reliableLandmarkCount).toBe(1);
    expect(arm.hand.point).toBeNull();
    expect(arm.bladePoint).toBeNull();
  });
});
