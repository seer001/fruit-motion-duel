import { describe, expect, it } from 'vitest';

import type { RoundFinishedPayload, ScoreBreakdown } from '../types/game';
import {
  DEFAULT_INTERMISSION_MS,
  DEFAULT_PRACTICE_DURATION_MS,
  FINAL_HALF_DURATION_MS,
  QUALIFIER_HALF_DURATION_MS,
  TIEBREAK_HALF_DURATION_MS,
  TournamentManager,
  TournamentRuleError,
  TournamentTieError,
  type HalfAssignment,
  type ParticipantDraft,
  type TournamentScriptPools,
} from './TournamentManager';

describe('TournamentManager', () => {
  it('uses seeded pairings and adds one ineligible pacer for an odd roster', () => {
    const participants = participantDrafts(13);
    const pools = scriptPools(30, 6);
    const first = createManager(participants, pools, false, 417);
    const second = createManager(participants, pools, false, 417);

    expect(first.getQualifierHeats().map(({ participantIds }) => participantIds)).toEqual(
      second.getQualifierHeats().map(({ participantIds }) => participantIds),
    );
    expect(first.getQualifierHeats()).toHaveLength(7);
    expect(first.getQualifierHeats().every(({ halfDurationMs }) =>
      halfDurationMs === QUALIFIER_HALF_DURATION_MS)).toBe(true);

    const snapshot = first.snapshot();
    const pacers = snapshot.participants.filter(({ rankingEligible }) => !rankingEligible);
    expect(pacers).toHaveLength(1);
    expect(snapshot.heats.filter(({ participantIds }) => participantIds.includes(pacers[0]!.id)))
      .toHaveLength(1);
    expect(new Set(snapshot.consumedScriptIds).size).toBe(14);
  });

  it('swaps lanes, ranks confirmed qualifier halves, and crowns from a 2x30s final', () => {
    const manager = createManager(participantDrafts(2), scriptPools(8, 6), true);
    const qualifier = manager.getQualifierHeats()[0]!;

    const qualifierFirst = playHalf(manager, qualifier.id, {
      [`event-1-participant-1`]: score(180),
      [`event-1-participant-2`]: score(90),
    });
    manager.confirmHalf(qualifier.id);
    const qualifierSecond = playHalf(manager, qualifier.id, {
      [`event-1-participant-1`]: score(170),
      [`event-1-participant-2`]: score(100),
    });
    manager.confirmHalf(qualifier.id);

    expect(laneOf(qualifierFirst, 'event-1-participant-1')).toBe('left');
    expect(laneOf(qualifierSecond, 'event-1-participant-1')).toBe('right');
    expect(manager.getLeaderboard()[0]).toMatchObject({
      participantId: 'event-1-participant-1',
      score: 350,
      halvesConfirmed: 2,
    });

    const finalHeat = manager.startFinal();
    expect(finalHeat.halfDurationMs).toBe(FINAL_HALF_DURATION_MS);
    playHalf(manager, finalHeat.id, {
      [`event-1-participant-1`]: score(210),
      [`event-1-participant-2`]: score(140),
    });
    manager.confirmHalf(finalHeat.id);
    playHalf(manager, finalHeat.id, {
      [`event-1-participant-1`]: score(220),
      [`event-1-participant-2`]: score(150),
    });
    manager.confirmHalf(finalHeat.id);

    expect(manager.finalizeChampion().id).toBe('event-1-participant-1');
    expect(manager.snapshot()).toMatchObject({
      phase: 'completed',
      championId: 'event-1-participant-1',
    });
  });

  it('keeps a voided attempt for audit and redraws only from an unused script', () => {
    const manager = createManager(participantDrafts(2), scriptPools(8, 4), true);
    const heat = manager.getQualifierHeats()[0]!;
    const originalScriptId = manager.beginHalf(heat.id).scriptId;
    manager.recordHalfResult(
      heat.id,
      payload(originalScriptId, heat.halfDurationMs, {
        'event-1-participant-1': score(100),
        'event-1-participant-2': score(90),
      }),
    );

    manager.voidHalf(heat.id, 'camera disconnected');
    const redrawnScriptId = manager.redrawScript(heat.id);

    expect(redrawnScriptId).not.toBe(originalScriptId);
    const snapshot = manager.snapshot();
    expect(snapshot.consumedScriptIds).toContain(originalScriptId);
    expect(snapshot.consumedScriptIds).toContain(redrawnScriptId);
    expect(snapshot.heats[0]?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'void',
          technicalReason: 'camera disconnected',
        }),
      ]),
    );
  });

  it('audits and redraws a half aborted before the game produced scores', () => {
    const manager = createManager(participantDrafts(2), scriptPools(8, 4), true);
    const heat = manager.getQualifierHeats()[0]!;
    const original = manager.beginHalf(heat.id).scriptId;

    const aborted = manager.abortHalfAndRedraw(heat.id, 'tracking lost');

    expect(aborted.replacementScriptId).not.toBe(original);
    expect(aborted.results).toHaveLength(2);
    expect(aborted.results.every(({ status, technicalReason }) =>
      status === 'void' && technicalReason === 'tracking lost')).toBe(true);
    expect(manager.beginHalf(heat.id).scriptId).toBe(aborted.replacementScriptId);
  });

  it('rejects a result that does not represent the locked half duration', () => {
    const manager = createManager(participantDrafts(2), scriptPools(8, 4), true);
    const heat = manager.getQualifierHeats()[0]!;
    const assignment = manager.beginHalf(heat.id);

    expect(() => manager.recordHalfResult(
      heat.id,
      payload(assignment.scriptId, 10_000, {
        'event-1-participant-1': score(100),
        'event-1-participant-2': score(90),
      }),
    )).toThrow(TournamentRuleError);
  });

  it('enforces a 13-person production minimum while allowing compact tests', () => {
    expect(() => createManager(participantDrafts(2), scriptPools(8, 4), false)).toThrow(
      TournamentRuleError,
    );
    expect(() => createManager(participantDrafts(2), scriptPools(8, 4), true)).not.toThrow();
  });

  it('locks the formal 10s practice and minimum 30s side-swap rest defaults', () => {
    const manager = createManager(participantDrafts(2), scriptPools(8, 4), true);
    expect(manager.snapshot().config).toMatchObject({
      intermissionMs: DEFAULT_INTERMISSION_MS,
      practiceDurationMs: DEFAULT_PRACTICE_DURATION_MS,
    });

    expect(() => TournamentManager.create(
      {
        eventId: 'too-short-rest',
        title: 'Tournament',
        difficulty: 'normal',
        scriptPoolVersion: 'validated-v1',
        participants: participantDrafts(2),
        seed: 1,
        intermissionMs: 29_999,
      },
      scriptPools(8, 4),
      { allowSmallRoster: true },
    )).toThrow(/at least 30 seconds/);
  });

  it('runs two 10s swapped tiebreak halves and uses the winner to resolve a tied final', () => {
    const manager = createManager(participantDrafts(2), scriptPools(8, 6), true);
    const qualifier = manager.getQualifierHeats()[0]!;
    playHalf(manager, qualifier.id, {
      'event-1-participant-1': score(200),
      'event-1-participant-2': score(100),
    });
    manager.confirmHalf(qualifier.id);
    playHalf(manager, qualifier.id, {
      'event-1-participant-1': score(200),
      'event-1-participant-2': score(100),
    });
    manager.confirmHalf(qualifier.id);

    const final = manager.startFinal();
    for (let half = 0; half < 2; half += 1) {
      playHalf(manager, final.id, {
        'event-1-participant-1': score(150),
        'event-1-participant-2': score(150),
      });
      manager.confirmHalf(final.id);
    }
    expect(() => manager.finalizeChampion()).toThrow(TournamentTieError);

    const tiebreak = manager.startTiebreak(
      ['event-1-participant-1', 'event-1-participant-2'],
      'final',
    );
    expect(tiebreak.halfDurationMs).toBe(TIEBREAK_HALF_DURATION_MS);
    for (let half = 0; half < 2; half += 1) {
      const assignment = playHalf(manager, tiebreak.id, {
        'event-1-participant-1': score(250),
        'event-1-participant-2': score(100),
      });
      expect(laneOf(assignment, 'event-1-participant-1')).toBe(half === 0 ? 'left' : 'right');
      manager.confirmHalf(tiebreak.id);
    }
    const winner = manager.resolveTiebreak(tiebreak.id);
    expect(winner.id).toBe('event-1-participant-1');
    expect(manager.finalizeChampion(winner.id).id).toBe('event-1-participant-1');
  });
});

function createManager(
  participants: readonly ParticipantDraft[],
  pools: TournamentScriptPools,
  allowSmallRoster: boolean,
  seed = 123,
): TournamentManager {
  return TournamentManager.create(
    {
      eventId: 'event-1',
      title: 'Tournament',
      difficulty: 'normal',
      scriptPoolVersion: 'validated-v1',
      participants,
      seed,
      createdAt: 1_000,
    },
    pools,
    { allowSmallRoster, clock: () => 1_000 },
  );
}

function participantDrafts(count: number): ParticipantDraft[] {
  return Array.from({ length: count }, (_, index) => ({
    displayName: `Player ${index + 1}`,
    activeHand: index % 2 === 0 ? 'right' : 'left',
    posture: index % 3 === 0 ? 'seated' : 'standing',
  }));
}

function scriptPools(qualifierCount: number, finalCount: number): TournamentScriptPools {
  return {
    qualifier: Array.from({ length: qualifierCount }, (_, index) => `q-${index + 1}`),
    final: Array.from({ length: finalCount }, (_, index) => `f-${index + 1}`),
    tiebreak: Array.from({ length: 12 }, (_, index) => `t-${index + 1}`),
  };
}

function playHalf(
  manager: TournamentManager,
  heatId: string,
  scores: Record<string, ScoreBreakdown>,
): HalfAssignment {
  const assignment = manager.beginHalf(heatId);
  manager.recordHalfResult(
    heatId,
    payload(assignment.scriptId, assignment.durationMs, scores),
  );
  return assignment;
}

function payload(
  scriptId: string,
  elapsedMs: number,
  scores: Record<string, ScoreBreakdown>,
): RoundFinishedPayload {
  return { scriptId, elapsedMs, scores };
}

function score(value: number): ScoreBreakdown {
  return {
    score: value,
    fruitHits: value,
    fruitMisses: 0,
    bombsHit: 0,
    combo: value,
    maxCombo: value,
  };
}

function laneOf(assignment: HalfAssignment, participantId: string): 'left' | 'right' | undefined {
  return assignment.players.find((player) => player.participantId === participantId)?.lane;
}
