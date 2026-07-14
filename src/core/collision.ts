import type { Point, SliceTrail } from '../types/game';

export const SWEEP_WINDOW_MS = 100;

export interface Circle extends Point {
  radius: number;
}

export interface SweepCollisionOptions {
  windowMs?: number;
  strokeRadius?: number;
  minimumSpeedPerSecond?: number;
}

type TimedPoint = Point & { timestampMs: number };

export function segmentIntersectsCircle(
  start: Point,
  end: Point,
  circle: Circle,
  strokeRadius = 0,
): boolean {
  const radius = circle.radius + strokeRadius;
  if (!Number.isFinite(radius) || radius < 0) {
    throw new RangeError('combined radius must be non-negative and finite');
  }

  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((circle.x - start.x) * deltaX + (circle.y - start.y) * deltaY) /
              lengthSquared,
          ),
        );
  const closestX = start.x + projection * deltaX;
  const closestY = start.y + projection * deltaY;
  const distanceX = circle.x - closestX;
  const distanceY = circle.y - closestY;
  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
}

function interpolateAt(first: TimedPoint, second: TimedPoint, timestampMs: number): TimedPoint {
  const proportion = (timestampMs - first.timestampMs) / (second.timestampMs - first.timestampMs);
  return {
    x: first.x + (second.x - first.x) * proportion,
    y: first.y + (second.y - first.y) * proportion,
    timestampMs,
  };
}

export function recentSweepPoints(
  points: readonly TimedPoint[],
  nowMs: number,
  windowMs = SWEEP_WINDOW_MS,
): TimedPoint[] {
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be positive');
  }

  const ordered = points
    .filter((point) => point.timestampMs <= nowMs)
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const cutoff = nowMs - windowMs;
  const recent = ordered.filter((point) => point.timestampMs >= cutoff);
  const firstRecent = recent[0];
  if (firstRecent === undefined) return [];

  let preceding: TimedPoint | undefined;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const point = ordered[index];
    if (point !== undefined && point.timestampMs < cutoff) {
      preceding = point;
      break;
    }
  }
  if (preceding !== undefined && firstRecent.timestampMs > cutoff) {
    recent.unshift(interpolateAt(preceding, firstRecent, cutoff));
  }
  return recent;
}

export function sweepIntersectsCircle(
  trail: Pick<SliceTrail, 'points'>,
  circle: Circle,
  nowMs: number,
  options: SweepCollisionOptions = {},
): boolean {
  const windowMs = options.windowMs ?? SWEEP_WINDOW_MS;
  const strokeRadius = options.strokeRadius ?? 0;
  const minimumSpeed = options.minimumSpeedPerSecond ?? 0;
  if (!Number.isFinite(minimumSpeed) || minimumSpeed < 0) {
    throw new RangeError('minimumSpeedPerSecond must be non-negative');
  }

  const points = recentSweepPoints(trail.points, nowMs, windowMs);
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start === undefined || end === undefined) continue;
    const elapsedSeconds = (end.timestampMs - start.timestampMs) / 1_000;
    if (elapsedSeconds <= 0) continue;
    const speed = Math.hypot(end.x - start.x, end.y - start.y) / elapsedSeconds;
    if (speed < minimumSpeed) continue;
    if (segmentIntersectsCircle(start, end, circle, strokeRadius)) return true;
  }
  return false;
}

/**
 * Evaluates motion against the newest captured sample instead of result
 * delivery time. A valid 100 ms sweep must not expire merely because pose
 * inference took longer than 100 ms to reach the game thread.
 *
 * The caller must still gate result freshness with `receivedAtMs` so the same
 * delayed sweep cannot be replayed indefinitely.
 */
export function sweepIntersectsCircleAtLatestSample(
  trail: Pick<SliceTrail, 'points'>,
  circle: Circle,
  options: SweepCollisionOptions = {},
): boolean {
  const latestTimestampMs = trail.points.reduce(
    (latest, point) => Math.max(latest, point.timestampMs),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(latestTimestampMs)) return false;
  return sweepIntersectsCircle(trail, circle, latestTimestampMs, options);
}
