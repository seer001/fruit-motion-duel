import { describe, expect, it } from 'vitest';

import type { HalfResult, Participant } from '../types/game';
import {
  compareRankingEntries,
  isUnresolvedTie,
  rankParticipants,
  selectFinalists,
} from './ranking';

function participant(id: string, rankingEligible = true): Participant {
  return {
    id,
    displayName: id.toUpperCase(),
    activeHand: 'right',
    posture: 'standing',
    rankingEligible,
    createdAt: 0,
  };
}

function result(
  participantId: string,
  halfIndex: number,
  score: number,
  bombsHit = 0,
  fruitMisses = 0,
): HalfResult {
  return {
    id: `${participantId}-${halfIndex}`,
    heatId: 'heat',
    participantId,
    halfIndex,
    lane: halfIndex === 0 ? 'left' : 'right',
    scriptId: `script-${halfIndex}`,
    status: 'confirmed',
    durationMs: 25_000,
    trackingPauses: 0,
    completedAt: halfIndex,
    score,
    fruitHits: Math.floor(score / 100),
    fruitMisses,
    bombsHit,
    combo: 0,
    maxCombo: 4,
  };
}

describe('ranking', () => {
  it('sums two halves and sorts by score, bombs, then misses', () => {
    const participants = [participant('a'), participant('b'), participant('c')];
    const results = [
      result('a', 0, 500, 1),
      result('a', 1, 500, 0),
      result('b', 0, 500, 0, 2),
      result('b', 1, 500, 0, 2),
      result('c', 0, 450, 0),
      result('c', 1, 450, 0),
    ];
    const ranking = rankParticipants(participants, results);
    expect(ranking.map(({ participantId, rank }) => [participantId, rank])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 3],
    ]);
  });

  it('marks a real tie and requires a playoff at the finalist cutoff', () => {
    const participants = [participant('a'), participant('b'), participant('c')];
    const results = participants.flatMap(({ id }) => [result(id, 0, 500), result(id, 1, 500)]);
    const ranking = rankParticipants(participants, results);
    expect(ranking.every((entry) => entry.unresolvedTie)).toBe(true);
    expect(selectFinalists(ranking)).toMatchObject({
      selected: [],
      requiresTiebreak: true,
    });
    expect(selectFinalists(ranking).cutoffTie).toHaveLength(3);
  });

  it('does not use fruit hits as a hidden tie breaker', () => {
    const first = { score: 1_000, bombsHit: 0, fruitMisses: 1, fruitHits: 8 };
    const second = { score: 1_000, bombsHit: 0, fruitMisses: 1, fruitHits: 9 };
    expect(compareRankingEntries(first, second)).toBe(0);
    expect(isUnresolvedTie(first, second)).toBe(true);
  });

  it('excludes ineligible and incomplete participants by default', () => {
    const ranking = rankParticipants(
      [participant('eligible'), participant('casual', false), participant('incomplete')],
      [
        result('eligible', 0, 100),
        result('eligible', 1, 100),
        result('casual', 0, 1_000),
        result('casual', 1, 1_000),
        result('incomplete', 0, 2_000),
      ],
    );
    expect(ranking.map((entry) => entry.participantId)).toEqual(['eligible']);
  });
});
