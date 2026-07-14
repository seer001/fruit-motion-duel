import { describe, expect, it } from 'vitest';

import type { SliceTrail } from '../types/game';
import {
  selectActiveBladeTrails,
  selectFreshUnconsumedBladeTrails,
  stabilizeActiveBladeTrails,
  type BladeOwnerPolicy,
} from './blade-trail-policy';

const OWNERS: BladeOwnerPolicy[] = [
  { participantId: 'blue', lane: 'left', activeHand: 'right' },
  { participantId: 'orange', lane: 'right', activeHand: 'left' },
];
const LOGICAL_WIDTH = 1920;

function trail(
  participantId: string,
  lane: 'left' | 'right',
  hand: 'left' | 'right',
  timestampMs: number,
  confidence = 0.9,
  receivedAtMs = timestampMs,
): SliceTrail {
  return {
    participantId,
    lane,
    hand,
    confidence,
    receivedAtMs,
    points: [{ x: (lane === 'left' ? 0.25 : 0.75) * LOGICAL_WIDTH, y: 0.5, timestampMs }],
  };
}

function trailPath(
  participantId: string,
  lane: 'left' | 'right',
  hand: 'left' | 'right',
  normalizedXs: readonly number[],
  startTimestampMs = 100,
): SliceTrail {
  const points = normalizedXs.map((x, index) => ({
    x: x * LOGICAL_WIDTH,
    y: 540,
    timestampMs: startTimestampMs + index * 20,
  }));
  return {
    participantId,
    lane,
    hand,
    confidence: 0.9,
    receivedAtMs: points.at(-1)?.timestampMs ?? startTimestampMs,
    points,
  };
}

describe('single active-hand blade policy', () => {
  it('reduces two hands per player to exactly two configured active-hand trails', () => {
    const selected = selectActiveBladeTrails(
      [
        trail('blue', 'left', 'left', 100),
        trail('blue', 'left', 'right', 101),
        trail('orange', 'right', 'right', 102),
        trail('orange', 'right', 'left', 103),
      ],
      OWNERS,
    );

    expect(selected).toHaveLength(2);
    expect(selected.map(({ participantId, hand }) => [participantId, hand])).toEqual([
      ['blue', 'right'],
      ['orange', 'left'],
    ]);
  });

  it('deduplicates repeated active-hand trails and ignores unregistered people', () => {
    const selected = selectActiveBladeTrails(
      [
        trail('blue', 'left', 'right', 100, 0.95),
        trail('blue', 'left', 'right', 120, 0.8),
        trail('spectator', 'right', 'left', 130),
      ],
      OWNERS,
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.participantId).toBe('blue');
    expect(selected[0]?.points.at(-1)?.timestampMs).toBe(120);
  });

  it('keeps left and right trails while their latest continuous suffix stays on its scoring side', () => {
    const selected = selectActiveBladeTrails(
      [
        trailPath('blue', 'left', 'right', [0.2, 0.32, 0.459]),
        trailPath('orange', 'right', 'left', [0.8, 0.67, 0.541]),
      ],
      OWNERS,
    );

    expect(selected).toHaveLength(2);
    expect(selected[0]?.points.map(({ x }) => x / LOGICAL_WIDTH)).toEqual([0.2, 0.32, 0.459]);
    expect(selected[1]?.points.map(({ x }) => x / LOGICAL_WIDTH)).toEqual([0.8, 0.67, 0.541]);
  });

  it('fails closed when the latest blade point reaches either centre boundary or the opponent side', () => {
    expect(selectActiveBladeTrails(
      [
        trailPath('blue', 'left', 'right', [0.3, 0.46]),
        trailPath('orange', 'right', 'left', [0.7, 0.54]),
      ],
      OWNERS,
    )).toEqual([]);

    expect(selectActiveBladeTrails(
      [
        trailPath('blue', 'left', 'right', [0.3, 0.7]),
        trailPath('orange', 'right', 'left', [0.7, 0.3]),
      ],
      OWNERS,
    )).toEqual([]);
  });

  it('drops pre-crossing segments after a blade re-enters its own side', () => {
    const selected = selectActiveBladeTrails(
      [
        trailPath('blue', 'left', 'right', [0.28, 0.5, 0.44, 0.4]),
        trailPath('orange', 'right', 'left', [0.72, 0.5, 0.56, 0.6]),
      ],
      OWNERS,
    );

    expect(selected[0]?.points.map(({ x }) => x / LOGICAL_WIDTH)).toEqual([0.44, 0.4]);
    expect(selected[1]?.points.map(({ x }) => x / LOGICAL_WIDTH)).toEqual([0.56, 0.6]);
  });

  it('retains only one harmless point on the first frame after re-entry', () => {
    const selected = selectActiveBladeTrails(
      [trailPath('blue', 'left', 'right', [0.3, 0.5, 0.42])],
      OWNERS,
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.points).toHaveLength(1);
    expect(selected[0]?.points[0]?.x).toBe(0.42 * LOGICAL_WIDTH);
  });

  it('does not fall back to an older in-lane duplicate when the newest trail is unsafe', () => {
    const selected = selectActiveBladeTrails(
      [
        trailPath('blue', 'left', 'right', [0.2, 0.3], 100),
        trailPath('blue', 'left', 'right', [0.3, 0.5], 200),
      ],
      OWNERS,
    );

    expect(selected).toEqual([]);
  });

  it('leaves single-player trails full-width and unchanged', () => {
    const fullWidth = trailPath('blue', 'left', 'right', [0.15, 0.5, 0.85]);
    const selected = selectActiveBladeTrails([fullWidth], [OWNERS[0]!]);

    expect(selected).toEqual([fullWidth]);
    expect(selected[0]).toBe(fullWidth);
  });

  it('retains a missing blade for one short frame without adding a scoring segment', () => {
    // The hand motion was captured long before the Worker delivered it. Visual
    // retention must use delivery time or a slow dual-player result vanishes
    // the instant it reaches the game.
    const previous = [trail('blue', 'left', 'right', 1_000, 0.9, 5_000)];
    const retained = stabilizeActiveBladeTrails(previous, [], OWNERS, 5_080, 180);
    const expired = stabilizeActiveBladeTrails(previous, [], OWNERS, 5_181, 180);

    expect(retained).toEqual(previous);
    expect(retained[0]?.points).toHaveLength(1);
    expect(expired).toEqual([]);
  });

  it('consumes each newly delivered result once while accepting delayed capture timestamps', () => {
    const delayedCapture = trail('blue', 'left', 'right', 1_000, 0.9, 5_000);
    const consumed = new Map<string, number>();

    expect(selectFreshUnconsumedBladeTrails([delayedCapture], consumed, 5_020, 180)).toEqual([
      delayedCapture,
    ]);
    consumed.set('blue', 5_000);
    expect(selectFreshUnconsumedBladeTrails([delayedCapture], consumed, 5_030, 180)).toEqual([]);
    expect(selectFreshUnconsumedBladeTrails(
      [trail('orange', 'right', 'left', 1_050, 0.9, 5_000)],
      consumed,
      5_181,
      180,
    )).toEqual([]);
  });
});
