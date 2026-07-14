import { describe, expect, it } from 'vitest';

import {
  recentSweepPoints,
  segmentIntersectsCircle,
  sweepIntersectsCircle,
  sweepIntersectsCircleAtLatestSample,
} from './collision';

describe('sweep collision', () => {
  const circle = { x: 0.5, y: 0.5, radius: 0.1 };

  it('detects line segment and tangent circle hits', () => {
    expect(segmentIntersectsCircle({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, circle)).toBe(true);
    expect(segmentIntersectsCircle({ x: 0, y: 0.4 }, { x: 1, y: 0.4 }, circle)).toBe(true);
    expect(segmentIntersectsCircle({ x: 0, y: 0.2 }, { x: 1, y: 0.2 }, circle)).toBe(false);
  });

  it('clips a segment at the 100ms sweep boundary', () => {
    const points = recentSweepPoints(
      [
        { x: 0, y: 0.5, timestampMs: 850 },
        { x: 1, y: 0.5, timestampMs: 950 },
      ],
      1_000,
    );
    expect(points[0]).toEqual({ x: 0.5, y: 0.5, timestampMs: 900 });
  });

  it('ignores geometry older than 100ms', () => {
    expect(
      sweepIntersectsCircle(
        {
          points: [
            { x: 0, y: 0.5, timestampMs: 700 },
            { x: 1, y: 0.5, timestampMs: 800 },
          ],
        },
        circle,
        1_000,
      ),
    ).toBe(false);
  });

  it('keeps capture-time motion valid when a Worker result arrives late', () => {
    const delayedTrail = {
      points: [
        { x: 0.4, y: 0.5, timestampMs: 700 },
        { x: 0.6, y: 0.5, timestampMs: 800 },
      ],
    };

    // Comparing capture time to a 200 ms-later wall clock reproduces the
    // two-player failure: the sweep looks expired the instant it arrives.
    expect(sweepIntersectsCircle(delayedTrail, circle, 1_000)).toBe(false);
    expect(sweepIntersectsCircleAtLatestSample(delayedTrail, circle)).toBe(true);
  });

  it('can require a minimum normalized slice speed', () => {
    const trail = {
      points: [
        { x: 0.4, y: 0.5, timestampMs: 900 },
        { x: 0.6, y: 0.5, timestampMs: 1_000 },
      ],
    };
    expect(sweepIntersectsCircle(trail, circle, 1_000, { minimumSpeedPerSecond: 1 })).toBe(true);
    expect(sweepIntersectsCircle(trail, circle, 1_000, { minimumSpeedPerSecond: 3 })).toBe(false);
  });
});
