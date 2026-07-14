import type { HalfResult, Participant, ScoreBreakdown } from '../types/game';

export interface RankingEntry extends ScoreBreakdown {
  participantId: string;
  displayName: string;
  halfCount: number;
  rank: number;
  unresolvedTie: boolean;
}

export interface RankParticipantsOptions {
  expectedHalfCount?: number;
  includeIncomplete?: boolean;
}

export interface FinalistSelection {
  selected: RankingEntry[];
  cutoffTie: RankingEntry[];
  requiresTiebreak: boolean;
}

type RankingComparable = Pick<
  RankingEntry,
  'score' | 'bombsHit' | 'fruitMisses'
>;

/** Score, then fewer bomb hits, then fewer misses.  Zero means a real tiebreak. */
export function compareRankingEntries(
  left: RankingComparable,
  right: RankingComparable,
): number {
  return (
    right.score - left.score ||
    left.bombsHit - right.bombsHit ||
    left.fruitMisses - right.fruitMisses
  );
}

export function isUnresolvedTie(left: RankingComparable, right: RankingComparable): boolean {
  return compareRankingEntries(left, right) === 0;
}

function emptyBreakdown(): ScoreBreakdown {
  return {
    score: 0,
    fruitHits: 0,
    fruitMisses: 0,
    bombsHit: 0,
    combo: 0,
    maxCombo: 0,
  };
}

export function rankParticipants(
  participants: readonly Participant[],
  halfResults: readonly HalfResult[],
  options: RankParticipantsOptions = {},
): RankingEntry[] {
  const expectedHalfCount = options.expectedHalfCount ?? 2;
  if (!Number.isInteger(expectedHalfCount) || expectedHalfCount <= 0) {
    throw new RangeError('expectedHalfCount must be a positive integer');
  }

  const confirmedByParticipant = new Map<string, HalfResult[]>();
  const seenResultIds = new Set<string>();
  for (const result of halfResults) {
    if (result.status !== 'confirmed' || seenResultIds.has(result.id)) continue;
    seenResultIds.add(result.id);
    const existing = confirmedByParticipant.get(result.participantId) ?? [];
    existing.push(result);
    confirmedByParticipant.set(result.participantId, existing);
  }

  const aggregated: RankingEntry[] = [];
  for (const participant of participants) {
    if (!participant.rankingEligible) continue;
    const results = confirmedByParticipant.get(participant.id) ?? [];
    if (!options.includeIncomplete && results.length !== expectedHalfCount) continue;

    const totals = emptyBreakdown();
    let latest: HalfResult | undefined;
    for (const result of results) {
      totals.score += result.score;
      totals.fruitHits += result.fruitHits;
      totals.fruitMisses += result.fruitMisses;
      totals.bombsHit += result.bombsHit;
      totals.maxCombo = Math.max(totals.maxCombo, result.maxCombo);
      if (latest === undefined || result.completedAt > latest.completedAt) latest = result;
    }
    totals.combo = latest?.combo ?? 0;
    aggregated.push({
      ...totals,
      participantId: participant.id,
      displayName: participant.displayName,
      halfCount: results.length,
      rank: 0,
      unresolvedTie: false,
    });
  }

  aggregated.sort(compareRankingEntries);
  for (let index = 0; index < aggregated.length; index += 1) {
    const current = aggregated[index];
    if (current === undefined) continue;
    const previous = aggregated[index - 1];
    current.rank =
      previous !== undefined && isUnresolvedTie(current, previous) ? previous.rank : index + 1;
    current.unresolvedTie =
      (previous !== undefined && isUnresolvedTie(current, previous)) ||
      (aggregated[index + 1] !== undefined &&
        isUnresolvedTie(current, aggregated[index + 1]!));
  }
  return aggregated;
}

export function selectFinalists(
  ranking: readonly RankingEntry[],
  places = 2,
): FinalistSelection {
  if (!Number.isInteger(places) || places <= 0) {
    throw new RangeError('places must be a positive integer');
  }
  if (ranking.length <= places) {
    return { selected: ranking.slice(), cutoffTie: [], requiresTiebreak: false };
  }

  const cutoff = ranking[places - 1];
  if (cutoff === undefined) {
    return { selected: [], cutoffTie: [], requiresTiebreak: false };
  }
  const tiedAtCutoff = ranking.filter((entry) => isUnresolvedTie(entry, cutoff));
  const safelyAbove = ranking.filter(
    (entry) => compareRankingEntries(entry, cutoff) < 0 && !isUnresolvedTie(entry, cutoff),
  );
  const slotsRemaining = places - safelyAbove.length;
  if (tiedAtCutoff.length > slotsRemaining) {
    return {
      selected: safelyAbove,
      cutoffTie: tiedAtCutoff,
      requiresTiebreak: true,
    };
  }
  return {
    selected: ranking.slice(0, places),
    cutoffTie: [],
    requiresTiebreak: false,
  };
}
