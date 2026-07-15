import type { CalibrationProfile, Lane, Point } from '../types/game';

export type ViewportFit = 'contain' | 'cover';

export interface ViewportTransformOptions {
  sourceWidth: number;
  sourceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  fit: ViewportFit;
  mirrored: boolean;
}

export interface ViewportTransform extends ViewportTransformOptions {
  scale: number;
  offsetX: number;
  offsetY: number;
  renderedWidth: number;
  renderedHeight: number;
}

export interface BodyAnchors {
  shoulderCenter: Point;
  torsoCenter: Point;
}

export interface BodyVerticalMappingOptions {
  /** Explicit game-space gain per torso length. Derived from reach when omitted. */
  verticalGain?: number;
  /** Game-space resting height for a hand level with the shoulders. */
  centerY?: number;
  /** Keeps the complete blade halo inside the 1080p playfield. */
  verticalPadding?: number;
  /** Torso lengths above/below the shoulders needed to reach a safe edge. */
  reachTorsoLengths?: number;
  clampVertical?: boolean;
}

export interface LaneMappingOptions extends BodyVerticalMappingOptions {
  horizontalGain?: number;
  lanePadding?: number;
  clampToLane?: boolean;
}

export interface ArenaMappingOptions extends BodyVerticalMappingOptions {
  horizontalGain?: number;
  horizontalPadding?: number;
  clampToArena?: boolean;
}

const DEFAULT_HORIZONTAL_GAIN = 0.18;
const DEFAULT_ARENA_HORIZONTAL_GAIN = 0.36;
const DEFAULT_CENTER_Y = 0.5;
const DEFAULT_LANE_PADDING = 0.025;
// The visible blade halo is 48 / 1080 = 0.0444 of the playfield. A 0.055
// margin leaves the complete cursor visible, including its antialiased rim.
export const DEFAULT_VERTICAL_PADDING = 0.055;
export const DEFAULT_VERTICAL_REACH_TORSO_LENGTHS = 1;

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

export function createViewportTransform(options: ViewportTransformOptions): ViewportTransform {
  assertPositiveFinite(options.sourceWidth, 'sourceWidth');
  assertPositiveFinite(options.sourceHeight, 'sourceHeight');
  assertPositiveFinite(options.viewportWidth, 'viewportWidth');
  assertPositiveFinite(options.viewportHeight, 'viewportHeight');

  const xScale = options.viewportWidth / options.sourceWidth;
  const yScale = options.viewportHeight / options.sourceHeight;
  const scale = options.fit === 'cover' ? Math.max(xScale, yScale) : Math.min(xScale, yScale);
  const renderedWidth = options.sourceWidth * scale;
  const renderedHeight = options.sourceHeight * scale;

  return {
    ...options,
    scale,
    renderedWidth,
    renderedHeight,
    offsetX: (options.viewportWidth - renderedWidth) / 2,
    offsetY: (options.viewportHeight - renderedHeight) / 2,
  };
}

export function mapNormalizedPoint(point: Point, transform: ViewportTransform): Point {
  const sourceX = point.x * transform.sourceWidth;
  const renderedX = sourceX * transform.scale + transform.offsetX;
  return {
    x: transform.mirrored ? transform.viewportWidth - renderedX : renderedX,
    y: point.y * transform.sourceHeight * transform.scale + transform.offsetY,
  };
}

export function unmapViewportPoint(point: Point, transform: ViewportTransform): Point {
  const renderedX = transform.mirrored ? transform.viewportWidth - point.x : point.x;
  return {
    x: (renderedX - transform.offsetX) / transform.scale / transform.sourceWidth,
    y: (point.y - transform.offsetY) / transform.scale / transform.sourceHeight,
  };
}

export function mirrorNormalizedPoint(point: Point): Point {
  return { x: 1 - point.x, y: point.y };
}

export function normalizeBodyPoint(
  point: Point,
  profile: CalibrationProfile,
  anchors: BodyAnchors = profile,
): Point {
  assertPositiveFinite(profile.shoulderWidth, 'profile.shoulderWidth');
  assertPositiveFinite(profile.torsoLength, 'profile.torsoLength');
  return {
    x: (point.x - anchors.torsoCenter.x) / profile.shoulderWidth,
    y: (point.y - anchors.shoulderCenter.y) / profile.torsoLength,
  };
}

/**
 * Uses the configured hand's shoulder as the horizontal neutral point while
 * preserving the shared shoulder-relative vertical mapping. A torso-centred
 * horizontal origin forced a right hand past the opposite shoulder to reach
 * left-side fruit (and vice versa), exactly where pose landmarks are most
 * likely to be occluded or swap sides.
 */
export function normalizeActiveHandPoint(
  point: Point,
  profile: CalibrationProfile,
  anchors: BodyAnchors = profile,
): Point {
  const bodyPoint = normalizeBodyPoint(point, profile, anchors);
  const activeShoulderOffset = profile.activeHand === 'right' ? 0.5 : -0.5;
  return {
    x:
      (point.x - anchors.shoulderCenter.x) / profile.shoulderWidth -
      activeShoulderOffset,
    y: bodyPoint.y,
  };
}

/**
 * Maps a hand's shoulder-relative height into the shared vertical playfield.
 *
 * One torso length above and below the shoulders spans the complete safe
 * playfield by default. The old fixed gain (0.28) required 1.77 torso lengths
 * below the shoulder to reach the lower edge, which pushed a real hand out of
 * the camera frame. This affine mapping is deliberately symmetric so fixing
 * the lower reach does not compress or bias the upper reach.
 */
export function mapBodyYToPlayfield(
  bodyY: number,
  options: BodyVerticalMappingOptions = {},
): number {
  if (!Number.isFinite(bodyY)) throw new RangeError('bodyY must be finite');
  const centerY = options.centerY ?? DEFAULT_CENTER_Y;
  const verticalPadding = options.verticalPadding ?? DEFAULT_VERTICAL_PADDING;
  const reachTorsoLengths =
    options.reachTorsoLengths ?? DEFAULT_VERTICAL_REACH_TORSO_LENGTHS;
  if (!Number.isFinite(centerY) || centerY <= verticalPadding || centerY >= 1 - verticalPadding) {
    throw new RangeError('centerY must be inside the vertically padded playfield');
  }
  if (!Number.isFinite(verticalPadding) || verticalPadding < 0 || verticalPadding >= 0.5) {
    throw new RangeError('verticalPadding must be finite and in [0, 0.5)');
  }
  assertPositiveFinite(reachTorsoLengths, 'reachTorsoLengths');
  const usableHalfRange = Math.min(
    centerY - verticalPadding,
    1 - verticalPadding - centerY,
  );
  const verticalGain = options.verticalGain ?? usableHalfRange / reachTorsoLengths;
  assertPositiveFinite(verticalGain, 'verticalGain');
  const rawY = centerY + bodyY * verticalGain;
  if (options.clampVertical === false) return rawY;
  return Math.max(verticalPadding, Math.min(1 - verticalPadding, rawY));
}

export function mapBodyPointToLane(
  bodyPoint: Point,
  lane: Lane,
  options: LaneMappingOptions = {},
): Point {
  const horizontalGain = options.horizontalGain ?? DEFAULT_HORIZONTAL_GAIN;
  const lanePadding = options.lanePadding ?? DEFAULT_LANE_PADDING;
  const laneStart = lane === 'left' ? 0 : 0.5;
  const laneEnd = lane === 'left' ? 0.5 : 1;
  const laneCenter = (laneStart + laneEnd) / 2;
  const raw = {
    x: laneCenter + bodyPoint.x * horizontalGain,
    y: mapBodyYToPlayfield(bodyPoint.y, {
      ...options,
      clampVertical: options.clampVertical ?? options.clampToLane !== false,
    }),
  };

  if (options.clampToLane === false) return raw;
  return {
    x: Math.max(laneStart + lanePadding, Math.min(laneEnd - lanePadding, raw.x)),
    y: raw.y,
  };
}

export function mapCalibratedPointToLane(
  point: Point,
  profile: CalibrationProfile,
  anchors: BodyAnchors = profile,
  options: LaneMappingOptions = {},
): Point {
  return mapBodyPointToLane(
    normalizeActiveHandPoint(point, profile, anchors),
    profile.lane,
    options,
  );
}

/** Maps a calibrated hand into the single-player full-width arena. */
export function mapBodyPointToArena(
  bodyPoint: Point,
  options: ArenaMappingOptions = {},
): Point {
  const horizontalGain = options.horizontalGain ?? DEFAULT_ARENA_HORIZONTAL_GAIN;
  const horizontalPadding = options.horizontalPadding ?? 0.035;
  const raw = {
    x: 0.5 + bodyPoint.x * horizontalGain,
    y: mapBodyYToPlayfield(bodyPoint.y, {
      ...options,
      clampVertical: options.clampVertical ?? options.clampToArena !== false,
    }),
  };
  if (options.clampToArena === false) return raw;
  return {
    x: Math.max(horizontalPadding, Math.min(1 - horizontalPadding, raw.x)),
    y: raw.y,
  };
}

export function mapCalibratedPointToArena(
  point: Point,
  profile: CalibrationProfile,
  anchors: BodyAnchors = profile,
  options: ArenaMappingOptions = {},
): Point {
  return mapBodyPointToArena(normalizeActiveHandPoint(point, profile, anchors), options);
}
