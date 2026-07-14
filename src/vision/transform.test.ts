import type { CalibrationProfile } from '../types/game';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERTICAL_PADDING,
  createViewportTransform,
  mapBodyPointToArena,
  mapBodyPointToLane,
  mapBodyYToPlayfield,
  mapCalibratedPointToArena,
  mapCalibratedPointToLane,
  mapNormalizedPoint,
  mirrorNormalizedPoint,
  normalizeBodyPoint,
  unmapViewportPoint,
} from './transform';

describe('viewport transforms', () => {
  it('letterboxes contain mode and round-trips points', () => {
    const transform = createViewportTransform({
      sourceWidth: 640,
      sourceHeight: 480,
      viewportWidth: 1920,
      viewportHeight: 1080,
      fit: 'contain',
      mirrored: false,
    });

    expect(transform.scale).toBe(2.25);
    expect(transform.offsetX).toBe(240);
    expect(transform.offsetY).toBe(0);
    const mapped = mapNormalizedPoint({ x: 0.25, y: 0.75 }, transform);
    expect(mapped).toEqual({ x: 600, y: 810 });
    expect(unmapViewportPoint(mapped, transform)).toEqual({ x: 0.25, y: 0.75 });
  });

  it('uses the same crop transform for cover mode', () => {
    const transform = createViewportTransform({
      sourceWidth: 1280,
      sourceHeight: 720,
      viewportWidth: 1000,
      viewportHeight: 1000,
      fit: 'cover',
      mirrored: false,
    });

    expect(transform.renderedHeight).toBeCloseTo(1000);
    expect(transform.offsetX).toBeCloseTo(-388.8889, 3);
    expect(mapNormalizedPoint({ x: 0.5, y: 0.5 }, transform)).toEqual({ x: 500, y: 500 });
  });

  it('preserves both vertical edges through ultrawide contain letterboxing', () => {
    const transform = createViewportTransform({
      sourceWidth: 2560,
      sourceHeight: 1080,
      viewportWidth: 1920,
      viewportHeight: 1080,
      fit: 'contain',
      mirrored: true,
    });

    expect(transform.offsetY).toBeCloseTo(135);
    expect(mapNormalizedPoint({ x: 0, y: 0 }, transform)).toEqual({ x: 1920, y: 135 });
    expect(mapNormalizedPoint({ x: 1, y: 1 }, transform)).toEqual({ x: 0, y: 945 });
    const sourcePoint = { x: 0.27, y: 0.91 };
    const roundTripped = unmapViewportPoint(
      mapNormalizedPoint(sourcePoint, transform),
      transform,
    );
    expect(roundTripped.x).toBeCloseTo(sourcePoint.x);
    expect(roundTripped.y).toBeCloseTo(sourcePoint.y);
  });

  it('mirrors coordinates in the common transform instead of CSS only', () => {
    const transform = createViewportTransform({
      sourceWidth: 1280,
      sourceHeight: 720,
      viewportWidth: 1280,
      viewportHeight: 720,
      fit: 'contain',
      mirrored: true,
    });

    const mapped = mapNormalizedPoint({ x: 0.2, y: 0.3 }, transform);
    expect(mapped).toEqual({ x: 1024, y: 216 });
    expect(unmapViewportPoint(mapped, transform)).toEqual({ x: 0.2, y: 0.3 });
    expect(mirrorNormalizedPoint({ x: 0.2, y: 0.3 })).toEqual({ x: 0.8, y: 0.3 });
  });

  it('rejects invalid dimensions', () => {
    expect(() =>
      createViewportTransform({
        sourceWidth: 0,
        sourceHeight: 720,
        viewportWidth: 1280,
        viewportHeight: 720,
        fit: 'contain',
        mirrored: false,
      }),
    ).toThrow(RangeError);
  });
});

describe('body-relative lane mapping', () => {
  const profile: CalibrationProfile = {
    participantId: 'player-1',
    lane: 'left',
    activeHand: 'right',
    shoulderCenter: { x: 0.25, y: 0.4 },
    torsoCenter: { x: 0.25, y: 0.5 },
    shoulderWidth: 0.2,
    torsoLength: 0.2,
    capturedAt: 100,
  };

  it('normalizes with the frozen profile scale', () => {
    expect(normalizeBodyPoint({ x: 0.45, y: 0.2 }, profile)).toEqual({ x: 1, y: -1 });
  });

  it('maps a normalized reach into the assigned lane', () => {
    const lanePoint = mapBodyPointToLane({ x: 1, y: -1 }, 'left');
    expect(lanePoint.x).toBeCloseTo(0.43);
    expect(lanePoint.y).toBeCloseTo(DEFAULT_VERTICAL_PADDING);
    const calibratedPoint = mapCalibratedPointToLane({ x: 0.45, y: 0.2 }, profile);
    expect(calibratedPoint.x).toBeCloseTo(0.43);
    expect(calibratedPoint.y).toBeCloseTo(DEFAULT_VERTICAL_PADDING);
  });

  it('clamps extreme reaches to the lane instead of crossing players', () => {
    expect(mapBodyPointToLane({ x: 100, y: -100 }, 'right')).toEqual({
      x: 0.975,
      y: DEFAULT_VERTICAL_PADDING,
    });
  });

  it('uses the full symmetric vertical reach while keeping the cursor halo visible', () => {
    const top = mapBodyYToPlayfield(-1);
    const center = mapBodyYToPlayfield(0);
    const bottom = mapBodyYToPlayfield(1);
    const cursorHalo = 48 / 1080;

    expect(top).toBeCloseTo(DEFAULT_VERTICAL_PADDING);
    expect(center).toBeCloseTo(0.5);
    expect(bottom).toBeCloseTo(1 - DEFAULT_VERTICAL_PADDING);
    expect(top).toBeLessThanOrEqual(0.08);
    expect(bottom).toBeGreaterThanOrEqual(0.92);
    expect(top - cursorHalo).toBeGreaterThanOrEqual(0);
    expect(bottom + cursorHalo).toBeLessThanOrEqual(1);
    expect(center - top).toBeCloseTo(bottom - center);
  });

  it('shares exactly the same vertical mapping in solo and both tournament lanes', () => {
    for (const bodyY of [-1, -0.5, 0, 0.5, 1]) {
      const solo = mapBodyPointToArena({ x: 0, y: bodyY });
      const left = mapBodyPointToLane({ x: 0, y: bodyY }, 'left');
      const right = mapBodyPointToLane({ x: 0, y: bodyY }, 'right');
      expect(left.y).toBeCloseTo(solo.y);
      expect(right.y).toBeCloseTo(solo.y);
    }
  });

  it('maps a calibrated solo hand through the shared vertical function', () => {
    const handOneTorsoBelowShoulder = { x: 0.25, y: 0.6 };
    const mapped = mapCalibratedPointToArena(handOneTorsoBelowShoulder, profile);

    expect(mapped.x).toBeCloseTo(0.5);
    expect(mapped.y).toBeCloseTo(1 - DEFAULT_VERTICAL_PADDING);
  });
});
