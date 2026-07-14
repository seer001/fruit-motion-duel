import { describe, expect, it } from 'vitest';

import {
  DUAL_LANE_REGIONS,
  classifyDualLaneX,
  isInDualPlayerLane,
  isInDualPlayerSafetyZone,
} from './lanes';

describe('dual-player lane regions', () => {
  it('keeps acquisition inside the confirmed left and right regions', () => {
    expect(DUAL_LANE_REGIONS).toEqual({
      left: { minX: 0.08, maxX: 0.46 },
      center: { minX: 0.46, maxX: 0.54 },
      right: { minX: 0.54, maxX: 0.92 },
    });
    expect(isInDualPlayerLane('left', 0.08)).toBe(true);
    expect(isInDualPlayerLane('left', 0.459)).toBe(true);
    expect(isInDualPlayerLane('right', 0.541)).toBe(true);
    expect(isInDualPlayerLane('right', 0.92)).toBe(true);
  });

  it('fails closed at both centre boundaries', () => {
    expect(classifyDualLaneX(0.46)).toBe('center');
    expect(classifyDualLaneX(0.5)).toBe('center');
    expect(classifyDualLaneX(0.54)).toBe('center');
    expect(isInDualPlayerSafetyZone(0.5)).toBe(true);
    expect(isInDualPlayerLane('left', 0.46)).toBe(false);
    expect(isInDualPlayerLane('right', 0.54)).toBe(false);
  });

  it('rejects outer margins and invalid coordinates', () => {
    expect(classifyDualLaneX(0.079)).toBe('outside');
    expect(classifyDualLaneX(0.921)).toBe('outside');
    expect(classifyDualLaneX(Number.NaN)).toBe('outside');
  });
});
