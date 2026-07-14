import type { Lane } from '../types/game';

export interface NormalizedLaneBounds {
  readonly minX: number;
  readonly maxX: number;
}

/**
 * Shared camera-space regions for two-player acquisition and calibration.
 *
 * The centre boundaries belong to the safety region. This deliberately leaves
 * no boundary pixel which can be accepted by both a player lane and the centre.
 */
export const DUAL_LANE_REGIONS = {
  left: { minX: 0.08, maxX: 0.46 },
  center: { minX: 0.46, maxX: 0.54 },
  right: { minX: 0.54, maxX: 0.92 },
} as const satisfies Record<Lane | 'center', NormalizedLaneBounds>;

export type DualLaneRegion = Lane | 'center' | 'outside';

export function classifyDualLaneX(x: number): DualLaneRegion {
  if (!Number.isFinite(x)) return 'outside';
  if (x >= DUAL_LANE_REGIONS.center.minX && x <= DUAL_LANE_REGIONS.center.maxX) {
    return 'center';
  }
  if (x >= DUAL_LANE_REGIONS.left.minX && x < DUAL_LANE_REGIONS.left.maxX) {
    return 'left';
  }
  if (x > DUAL_LANE_REGIONS.right.minX && x <= DUAL_LANE_REGIONS.right.maxX) {
    return 'right';
  }
  return 'outside';
}

export function isInDualPlayerLane(lane: Lane, x: number): boolean {
  return classifyDualLaneX(x) === lane;
}

export function isInDualPlayerSafetyZone(x: number): boolean {
  return classifyDualLaneX(x) === 'center';
}
