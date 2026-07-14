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
    points: [{ x: timestampMs / 1_000, y: 0.5, timestampMs }],
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
