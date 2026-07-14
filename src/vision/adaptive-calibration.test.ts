import { describe, expect, it } from 'vitest';

import type { CalibrationProfile } from '../types/game';
import { AdaptiveCalibrationManager } from './adaptive-calibration';

const PROFILE: CalibrationProfile = {
  participantId: 'player-1',
  lane: 'left',
  activeHand: 'right',
  shoulderCenter: { x: 0.3, y: 0.35 },
  torsoCenter: { x: 0.3, y: 0.5 },
  shoulderWidth: 0.2,
  torsoLength: 0.25,
  capturedAt: 1,
};

describe('AdaptiveCalibrationManager', () => {
  it('slowly follows good frames without changing the baseline object', () => {
    const manager = new AdaptiveCalibrationManager({ alpha: 0.1 });
    const seeded = manager.seed(PROFILE);
    const adapted = manager.update('player-1', {
      shoulderWidth: 0.21,
      torsoLength: 0.26,
      poseQuality: 0.9,
      observedAt: 100,
    });

    expect(adapted?.shoulderWidth).toBeCloseTo(0.201);
    expect(adapted?.torsoLength).toBeCloseTo(0.251);
    expect(seeded.shoulderWidth).toBe(0.2);
    expect(PROFILE.shoulderWidth).toBe(0.2);
    expect(manager.status('player-1')?.acceptedFrames).toBe(1);
  });

  it('rejects low-quality and non-monotonic frames', () => {
    const manager = new AdaptiveCalibrationManager();
    manager.seed(PROFILE);
    const lowQuality = manager.update('player-1', {
      shoulderWidth: 0.3,
      torsoLength: 0.35,
      poseQuality: 0.4,
      observedAt: 100,
    });
    manager.update('player-1', {
      shoulderWidth: 0.2,
      torsoLength: 0.25,
      poseQuality: 0.9,
      observedAt: 100,
    });

    expect(lowQuality?.shoulderWidth).toBe(0.2);
    expect(manager.status('player-1')).toMatchObject({
      acceptedFrames: 1,
      rejectedFrames: 1,
    });
  });

  it('cannot drift beyond the configured baseline envelope', () => {
    const manager = new AdaptiveCalibrationManager({
      alpha: 1,
      maximumScaleDeviation: 0.1,
    });
    manager.seed(PROFILE);
    const expanded = manager.update('player-1', {
      shoulderWidth: 1,
      torsoLength: 1,
      poseQuality: 1,
      observedAt: 100,
    });
    expect(expanded?.shoulderWidth).toBeCloseTo(0.22);
    expect(expanded?.torsoLength).toBeCloseTo(0.275);

    const contracted = manager.update('player-1', {
      shoulderWidth: 0.01,
      torsoLength: 0.01,
      poseQuality: 1,
      observedAt: 200,
    });
    expect(contracted?.shoulderWidth).toBeCloseTo(0.18);
    expect(contracted?.torsoLength).toBeCloseTo(0.225);
  });

  it('returns null for unknown players and clears all state', () => {
    const manager = new AdaptiveCalibrationManager();
    expect(
      manager.update('missing', {
        shoulderWidth: 0.2,
        torsoLength: 0.25,
        poseQuality: 1,
        observedAt: 100,
      }),
    ).toBeNull();
    manager.seed(PROFILE);
    manager.clear();
    expect(manager.get('player-1')).toBeNull();
  });
});
