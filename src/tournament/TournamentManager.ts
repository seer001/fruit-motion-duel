import type {
  CompetitionPhase,
  Difficulty,
  DominantHand,
  HalfResult,
  Heat,
  Lane,
  Participant,
  PlayerPosture,
  RoundFinishedPayload,
  ScoreBreakdown,
  TournamentEvent,
} from '../types/game';

export const MINIMUM_EVENT_PARTICIPANTS = 13;
export const MAXIMUM_EVENT_PARTICIPANTS = 30;
export const QUALIFIER_HALF_DURATION_MS = 25_000;
export const FINAL_HALF_DURATION_MS = 30_000;
export const TIEBREAK_HALF_DURATION_MS = 10_000;
export const DEFAULT_INTERMISSION_MS = 30_000;
export const DEFAULT_PRACTICE_DURATION_MS = 10_000;

const HALF_COUNT = 2;
const MAX_RESULT_DURATION_DRIFT_MS = 1_000;

export interface ParticipantDraft {
  id?: string;
  displayName: string;
  activeHand?: DominantHand;
  posture?: PlayerPosture;
  createdAt?: number;
}

export interface TournamentScriptPools {
  qualifier: readonly string[];
  final: readonly string[];
  tiebreak?: readonly string[];
}

export interface CreateTournamentInput {
  eventId: string;
  title: string;
  difficulty: Difficulty;
  scriptPoolVersion: string;
  participants: readonly ParticipantDraft[];
  seed: number;
  createdAt?: number;
  intermissionMs?: number;
  practiceDurationMs?: number;
  pacerName?: string;
}

export interface TournamentManagerOptions {
  /** Keeps production validation strict while allowing compact unit fixtures. */
  allowSmallRoster?: boolean;
  clock?: () => number;
}

export interface RecordHalfOptions {
  completedAt?: number;
  trackingPauses?: Readonly<Record<string, number>>;
}

export interface HalfAssignment {
  heatId: string;
  phase: CompetitionPhase;
  halfIndex: 0 | 1;
  durationMs: number;
  scriptId: string;
  players: ReadonlyArray<{
    participantId: string;
    lane: Lane;
  }>;
}

export interface LeaderboardEntry extends ScoreBreakdown {
  rank: number;
  participantId: string;
  displayName: string;
  halvesConfirmed: number;
}

export interface AbortedHalf {
  results: HalfResult[];
  replacementScriptId: string;
}

export type TiebreakPurpose = 'qualifier' | 'final';

export class TournamentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TournamentRuleError';
  }
}

export class ScriptPoolExhaustedError extends TournamentRuleError {
  constructor(phase: CompetitionPhase) {
    super(`No unused ${phase} script remains in the locked script pool`);
    this.name = 'ScriptPoolExhaustedError';
  }
}

export class TournamentTieError extends TournamentRuleError {
  constructor(message: string) {
    super(message);
    this.name = 'TournamentTieError';
  }
}

/**
 * Owns tournament invariants. It deliberately does not choose scripts on host
 * input: every assignment and technical redraw comes from the locked pool.
 */
export class TournamentManager {
  private readonly scriptPools: TournamentScriptPools;
  private readonly clock: () => number;
  private tournamentEvent: TournamentEvent;

  private constructor(
    event: TournamentEvent,
    scriptPools: TournamentScriptPools,
    clock: () => number,
  ) {
    validateScriptPools(scriptPools);
    validateEventSnapshot(event);
    this.tournamentEvent = cloneEvent(event);
    this.scriptPools = scriptPools;
    this.clock = clock;
  }

  static create(
    input: CreateTournamentInput,
    scriptPools: TournamentScriptPools,
    options: TournamentManagerOptions = {},
  ): TournamentManager {
    const now = options.clock ?? Date.now;
    const createdAt = input.createdAt ?? now();
    const minimum = options.allowSmallRoster === true ? 2 : MINIMUM_EVENT_PARTICIPANTS;

    validateCreateInput(input, minimum);
    validateScriptPools(scriptPools);

    const participants = createParticipants(input, createdAt);
    const shuffledCompetitors = seededShuffle(participants, input.seed);
    const scheduledParticipants = [...shuffledCompetitors];

    if (scheduledParticipants.length % 2 === 1) {
      const pacerId = uniquePacerId(input.eventId, new Set(participants.map(({ id }) => id)));
      const pacer: Participant = {
        id: pacerId,
        displayName: input.pacerName?.trim() || '陪玩員',
        activeHand: 'right',
        posture: 'standing',
        rankingEligible: false,
        createdAt: createdAt + participants.length,
      };
      participants.push(pacer);
      scheduledParticipants.push(pacer);
    }

    const qualifierHeatCount = scheduledParticipants.length / 2;
    const requiredQualifierScripts = qualifierHeatCount * HALF_COUNT;
    if (scriptPools.qualifier.length < requiredQualifierScripts) {
      throw new TournamentRuleError(
        `Qualifier pool needs at least ${requiredQualifierScripts} scripts for ${qualifierHeatCount} heats`,
      );
    }
    if (scriptPools.final.length < HALF_COUNT) {
      throw new TournamentRuleError('Final pool needs at least two scripts');
    }

    const consumedScriptIds: string[] = [];
    const heats: Heat[] = [];

    for (let index = 0; index < qualifierHeatCount; index += 1) {
      const first = scheduledParticipants[index * 2];
      const second = scheduledParticipants[index * 2 + 1];
      if (first === undefined || second === undefined) {
        throw new TournamentRuleError('Every qualifier heat must have two tracked players');
      }

      const heatId = `${input.eventId}-qualifier-${index + 1}`;
      heats.push({
        id: heatId,
        phase: 'qualifier',
        participantIds: [first.id, second.id],
        status: 'queued',
        currentHalf: 0,
        halfDurationMs: QUALIFIER_HALF_DURATION_MS,
        scriptIds: [
          drawScript(input.eventId, 'qualifier', scriptPools, consumedScriptIds),
          drawScript(input.eventId, 'qualifier', scriptPools, consumedScriptIds),
        ],
        results: [],
      });
    }

    const event: TournamentEvent = {
      schemaVersion: 1,
      config: {
        id: input.eventId.trim(),
        title: input.title.trim(),
        difficulty: input.difficulty,
        qualifierHalfDurationMs: QUALIFIER_HALF_DURATION_MS,
        finalHalfDurationMs: FINAL_HALF_DURATION_MS,
        intermissionMs: input.intermissionMs ?? DEFAULT_INTERMISSION_MS,
        practiceDurationMs: input.practiceDurationMs ?? DEFAULT_PRACTICE_DURATION_MS,
        scriptPoolVersion: input.scriptPoolVersion.trim(),
        createdAt,
        lockedAt: createdAt,
      },
      participants,
      heats,
      consumedScriptIds,
      phase: 'qualifiers',
      updatedAt: createdAt,
    };

    return new TournamentManager(event, scriptPools, now);
  }

  static fromSnapshot(
    event: TournamentEvent,
    scriptPools: TournamentScriptPools,
    options: Pick<TournamentManagerOptions, 'clock'> = {},
  ): TournamentManager {
    return new TournamentManager(event, scriptPools, options.clock ?? Date.now);
  }

  snapshot(): TournamentEvent {
    return cloneEvent(this.tournamentEvent);
  }

  getQualifierHeats(): Heat[] {
    return this.tournamentEvent.heats
      .filter(({ phase }) => phase === 'qualifier')
      .map(cloneHeat);
  }

  getFinalHeat(): Heat | null {
    const heat = this.tournamentEvent.heats.find(({ phase }) => phase === 'final');
    return heat === undefined ? null : cloneHeat(heat);
  }

  getTiebreakHeats(): Heat[] {
    return this.tournamentEvent.heats
      .filter(({ phase }) => phase === 'tiebreak')
      .map(cloneHeat);
  }

  getHalfAssignment(heatId: string): HalfAssignment {
    const heat = this.findHeat(heatId);
    const halfIndex = assertPlayableHalfIndex(heat.currentHalf);
    const scriptId = heat.scriptIds[halfIndex];
    if (scriptId === undefined) {
      throw new TournamentRuleError(`Heat ${heat.id} has no script for half ${halfIndex + 1}`);
    }

    return {
      heatId: heat.id,
      phase: heat.phase,
      halfIndex,
      durationMs: heat.halfDurationMs,
      scriptId,
      players: heat.participantIds.flatMap((participantId, participantIndex) => {
        if (participantId === undefined) {
          return [];
        }
        return [{ participantId, lane: laneFor(participantIndex, halfIndex) }];
      }),
    };
  }

  beginHalf(heatId: string): HalfAssignment {
    const heat = this.findHeat(heatId);
    if (heat.status !== 'queued' && heat.status !== 'calibrating') {
      throw new TournamentRuleError(`Cannot start heat ${heat.id} while it is ${heat.status}`);
    }
    this.assertEventPhaseAllows(heat);
    const assignment = this.getHalfAssignment(heatId);
    heat.status = 'playing';
    this.touch();
    return assignment;
  }

  recordHalfResult(
    heatId: string,
    payload: RoundFinishedPayload,
    options: RecordHalfOptions = {},
  ): HalfResult[] {
    const heat = this.findHeat(heatId);
    if (heat.status !== 'playing') {
      throw new TournamentRuleError(`Cannot record a result while heat ${heat.id} is ${heat.status}`);
    }

    const halfIndex = assertPlayableHalfIndex(heat.currentHalf);
    const expectedScriptId = heat.scriptIds[halfIndex];
    if (payload.scriptId !== expectedScriptId) {
      throw new TournamentRuleError(
        `Result script ${payload.scriptId} does not match assigned script ${String(expectedScriptId)}`,
      );
    }
    if (
      !Number.isFinite(payload.elapsedMs) ||
      Math.abs(payload.elapsedMs - heat.halfDurationMs) > MAX_RESULT_DURATION_DRIFT_MS
    ) {
      throw new TournamentRuleError(
        `Half elapsed time must match the locked ${heat.halfDurationMs}ms duration`,
      );
    }

    const participantIds = heat.participantIds.filter(
      (participantId): participantId is string => participantId !== undefined,
    );
    const completedAt = options.completedAt ?? this.clock();
    const attemptNumber =
      heat.results.filter((result) => result.halfIndex === halfIndex).length /
        participantIds.length +
      1;
    const results = participantIds.map((participantId, participantIndex): HalfResult => {
      const score = payload.scores[participantId];
      if (score === undefined) {
        throw new TournamentRuleError(`Missing score for participant ${participantId}`);
      }
      validateScore(score);

      const trackingPauses = options.trackingPauses?.[participantId] ?? 0;
      if (!Number.isInteger(trackingPauses) || trackingPauses < 0) {
        throw new TournamentRuleError('Tracking pause count must be a non-negative integer');
      }

      return {
        id: `${heat.id}-half-${halfIndex + 1}-attempt-${attemptNumber}-player-${participantId}`,
        heatId: heat.id,
        participantId,
        halfIndex,
        lane: laneFor(participantIndex, halfIndex),
        scriptId: payload.scriptId,
        status: 'provisional',
        durationMs: heat.halfDurationMs,
        trackingPauses,
        completedAt,
        ...score,
      };
    });

    heat.results.push(...results);
    heat.status = 'review';
    this.touch();
    return results.map(cloneHalfResult);
  }

  confirmHalf(heatId: string): HalfResult[] {
    const heat = this.findHeat(heatId);
    if (heat.status !== 'review') {
      throw new TournamentRuleError(`Heat ${heat.id} is not awaiting host review`);
    }
    const halfIndex = assertPlayableHalfIndex(heat.currentHalf);
    const provisional = this.currentAttemptResults(heat, halfIndex, 'provisional');
    this.assertCompleteAttempt(heat, provisional);

    for (const result of provisional) {
      result.status = 'confirmed';
    }

    if (halfIndex === 0) {
      heat.currentHalf = 1;
      heat.status = 'calibrating';
    } else {
      heat.currentHalf = HALF_COUNT;
      heat.status = 'completed';
    }
    this.touch();
    return provisional.map(cloneHalfResult);
  }

  voidHalf(heatId: string, technicalReason: string): HalfResult[] {
    const reason = technicalReason.trim();
    if (reason.length === 0) {
      throw new TournamentRuleError('A technical void requires a reason');
    }

    const heat = this.findHeat(heatId);
    if (heat.status !== 'review') {
      throw new TournamentRuleError(`Heat ${heat.id} is not awaiting host review`);
    }
    const halfIndex = assertPlayableHalfIndex(heat.currentHalf);
    const provisional = this.currentAttemptResults(heat, halfIndex, 'provisional');
    this.assertCompleteAttempt(heat, provisional);

    for (const result of provisional) {
      result.status = 'void';
      result.technicalReason = reason;
    }
    heat.status = 'void';
    this.touch();
    return provisional.map(cloneHalfResult);
  }

  /** Records a zero-score audit attempt when hardware fails before a result exists. */
  abortHalf(heatId: string, technicalReason: string): HalfResult[] {
    const reason = technicalReason.trim();
    if (reason.length === 0) {
      throw new TournamentRuleError('A technical abort requires a reason');
    }

    const heat = this.findHeat(heatId);
    if (heat.status !== 'playing') {
      throw new TournamentRuleError(`Cannot abort heat ${heat.id} while it is ${heat.status}`);
    }
    const halfIndex = assertPlayableHalfIndex(heat.currentHalf);
    const scriptId = heat.scriptIds[halfIndex];
    if (scriptId === undefined) {
      throw new TournamentRuleError(`Heat ${heat.id} has no active script`);
    }
    const participantIds = heat.participantIds.filter(
      (participantId): participantId is string => participantId !== undefined,
    );
    const attemptNumber =
      heat.results.filter((result) => result.halfIndex === halfIndex).length /
        participantIds.length +
      1;
    const completedAt = this.clock();
    const results = participantIds.map((participantId, participantIndex): HalfResult => ({
      id: `${heat.id}-half-${halfIndex + 1}-attempt-${attemptNumber}-player-${participantId}`,
      heatId: heat.id,
      participantId,
      halfIndex,
      lane: laneFor(participantIndex, halfIndex),
      scriptId,
      status: 'void',
      durationMs: heat.halfDurationMs,
      trackingPauses: 0,
      technicalReason: reason,
      completedAt,
      score: 0,
      fruitHits: 0,
      fruitMisses: 0,
      bombsHit: 0,
      combo: 0,
      maxCombo: 0,
    }));
    heat.results.push(...results);
    heat.status = 'void';
    this.touch();
    return results.map(cloneHalfResult);
  }

  redrawScript(heatId: string): string {
    const heat = this.findHeat(heatId);
    if (heat.status !== 'void') {
      throw new TournamentRuleError('A script can only be redrawn after a technical void');
    }
    const halfIndex = assertPlayableHalfIndex(heat.currentHalf);
    this.assertScriptsAvailable(heat.phase, 1);
    const scriptId = drawScript(
      this.tournamentEvent.config.id,
      heat.phase,
      this.scriptPools,
      this.tournamentEvent.consumedScriptIds,
    );
    heat.scriptIds[halfIndex] = scriptId;
    heat.status = 'calibrating';
    this.touch();
    return scriptId;
  }

  voidHalfAndRedraw(heatId: string, technicalReason: string): string {
    this.assertScriptsAvailable(this.findHeat(heatId).phase, 1);
    this.voidHalf(heatId, technicalReason);
    return this.redrawScript(heatId);
  }

  abortHalfAndRedraw(heatId: string, technicalReason: string): AbortedHalf {
    this.assertScriptsAvailable(this.findHeat(heatId).phase, 1);
    const results = this.abortHalf(heatId, technicalReason);
    return {
      results,
      replacementScriptId: this.redrawScript(heatId),
    };
  }

  getLeaderboard(phase: 'qualifier' | 'final' = 'qualifier'): LeaderboardEntry[] {
    const eligibleParticipants = new Map(
      this.tournamentEvent.participants
        .filter(({ rankingEligible }) => rankingEligible)
        .map((participant) => [participant.id, participant] as const),
    );
    const totals = new Map<string, LeaderboardEntry>();

    for (const heat of this.tournamentEvent.heats) {
      if (heat.phase !== phase) {
        continue;
      }
      for (const result of heat.results) {
        if (result.status !== 'confirmed') {
          continue;
        }
        const participant = eligibleParticipants.get(result.participantId);
        if (participant === undefined) {
          continue;
        }

        const entry = totals.get(participant.id) ?? emptyLeaderboardEntry(participant);
        entry.score += result.score;
        entry.fruitHits += result.fruitHits;
        entry.fruitMisses += result.fruitMisses;
        entry.bombsHit += result.bombsHit;
        entry.combo += result.combo;
        entry.maxCombo = Math.max(entry.maxCombo, result.maxCombo);
        entry.halvesConfirmed += 1;
        totals.set(participant.id, entry);
      }
    }

    const leaderboard = [...totals.values()].sort((left, right) => {
      const performanceOrder = comparePerformance(left, right);
      if (performanceOrder !== 0) {
        return performanceOrder;
      }
      return left.participantId.localeCompare(right.participantId);
    });

    let rank = 0;
    for (let index = 0; index < leaderboard.length; index += 1) {
      const entry = leaderboard[index];
      if (entry === undefined) {
        continue;
      }
      const previous = leaderboard[index - 1];
      if (previous === undefined || comparePerformance(previous, entry) !== 0) {
        rank = index + 1;
      }
      entry.rank = rank;
    }

    return leaderboard.map((entry) => ({ ...entry }));
  }

  getHeatLeaderboard(heatId: string): LeaderboardEntry[] {
    const heat = this.findHeat(heatId);
    const participants = new Map(
      this.tournamentEvent.participants.map((participant) => [participant.id, participant] as const),
    );
    const totals = new Map<string, LeaderboardEntry>();

    for (const result of heat.results) {
      if (result.status !== 'confirmed') continue;
      const participant = participants.get(result.participantId);
      if (participant === undefined || !participant.rankingEligible) continue;
      const entry = totals.get(participant.id) ?? emptyLeaderboardEntry(participant);
      entry.score += result.score;
      entry.fruitHits += result.fruitHits;
      entry.fruitMisses += result.fruitMisses;
      entry.bombsHit += result.bombsHit;
      entry.combo += result.combo;
      entry.maxCombo = Math.max(entry.maxCombo, result.maxCombo);
      entry.halvesConfirmed += 1;
      totals.set(participant.id, entry);
    }

    const leaderboard = [...totals.values()].sort((left, right) => {
      const order = comparePerformance(left, right);
      return order || left.participantId.localeCompare(right.participantId);
    });
    let rank = 0;
    leaderboard.forEach((entry, index) => {
      const previous = leaderboard[index - 1];
      if (previous === undefined || comparePerformance(previous, entry) !== 0) rank = index + 1;
      entry.rank = rank;
    });
    return leaderboard.map((entry) => ({ ...entry }));
  }

  startTiebreak(
    participantIds: readonly [string, string],
    purpose: TiebreakPurpose,
  ): Heat {
    if (this.tournamentEvent.phase !== (purpose === 'qualifier' ? 'qualifiers' : 'final')) {
      throw new TournamentRuleError(`Cannot start a ${purpose} tiebreak in this event phase`);
    }
    if (participantIds[0] === participantIds[1]) {
      throw new TournamentRuleError('Tiebreak participants must be different');
    }
    participantIds.forEach((participantId) => {
      const participant = this.findParticipant(participantId);
      if (!participant.rankingEligible) {
        throw new TournamentRuleError('A non-ranking pacer cannot enter a tiebreak');
      }
    });
    this.assertScriptsAvailable('tiebreak', HALF_COUNT);
    const sequence = this.getTiebreakHeats().length + 1;
    const heat: Heat = {
      id: `${this.tournamentEvent.config.id}-tiebreak-${purpose}-${sequence}`,
      phase: 'tiebreak',
      participantIds: [participantIds[0], participantIds[1]],
      status: 'queued',
      currentHalf: 0,
      halfDurationMs: TIEBREAK_HALF_DURATION_MS,
      scriptIds: [
        drawScript(
          this.tournamentEvent.config.id,
          'tiebreak',
          this.scriptPools,
          this.tournamentEvent.consumedScriptIds,
        ),
        drawScript(
          this.tournamentEvent.config.id,
          'tiebreak',
          this.scriptPools,
          this.tournamentEvent.consumedScriptIds,
        ),
      ],
      results: [],
    };
    this.tournamentEvent.heats.push(heat);
    this.touch();
    return cloneHeat(heat);
  }

  resolveTiebreak(heatId: string): Participant {
    const heat = this.findHeat(heatId);
    if (heat.phase !== 'tiebreak' || heat.status !== 'completed') {
      throw new TournamentRuleError('Both tiebreak halves must be confirmed first');
    }
    const leaderboard = this.getHeatLeaderboard(heatId);
    const first = leaderboard[0];
    const second = leaderboard[1];
    if (first === undefined || second === undefined) {
      throw new TournamentRuleError('A tiebreak requires two complete participant results');
    }
    if (comparePerformance(first, second) === 0) {
      throw new TournamentTieError('The tiebreak is still tied and must be repeated');
    }
    return { ...this.findParticipant(first.participantId) };
  }

  startFinal(finalistOverride?: readonly [string, string]): Heat {
    if (this.tournamentEvent.phase !== 'qualifiers') {
      throw new TournamentRuleError('The final can only start after qualifiers');
    }
    const qualifierHeats = this.tournamentEvent.heats.filter(
      ({ phase }) => phase === 'qualifier',
    );
    if (qualifierHeats.length === 0 || qualifierHeats.some(({ status }) => status !== 'completed')) {
      throw new TournamentRuleError('Every qualifier heat must be confirmed before the final');
    }

    const leaderboard = this.getLeaderboard('qualifier');
    const first = finalistOverride === undefined
      ? leaderboard[0]
      : leaderboard.find(({ participantId }) => participantId === finalistOverride[0]);
    const second = finalistOverride === undefined
      ? leaderboard[1]
      : leaderboard.find(({ participantId }) => participantId === finalistOverride[1]);
    if (first === undefined || second === undefined) {
      throw new TournamentRuleError('At least two eligible qualifier results are required');
    }
    const third = leaderboard[2];
    if (finalistOverride === undefined && third !== undefined && comparePerformance(second, third) === 0) {
      throw new TournamentTieError('The qualifier cutoff is tied and requires a tiebreak');
    }

    this.assertScriptsAvailable('final', HALF_COUNT);
    const finalHeat: Heat = {
      id: `${this.tournamentEvent.config.id}-final`,
      phase: 'final',
      participantIds: [first.participantId, second.participantId],
      status: 'queued',
      currentHalf: 0,
      halfDurationMs: FINAL_HALF_DURATION_MS,
      scriptIds: [
        drawScript(
          this.tournamentEvent.config.id,
          'final',
          this.scriptPools,
          this.tournamentEvent.consumedScriptIds,
        ),
        drawScript(
          this.tournamentEvent.config.id,
          'final',
          this.scriptPools,
          this.tournamentEvent.consumedScriptIds,
        ),
      ],
      results: [],
    };
    this.tournamentEvent.heats.push(finalHeat);
    this.tournamentEvent.phase = 'final';
    this.touch();
    return cloneHeat(finalHeat);
  }

  finalizeChampion(championOverrideId?: string): Participant {
    if (this.tournamentEvent.phase !== 'final') {
      throw new TournamentRuleError('There is no active final to complete');
    }
    const finalHeat = this.tournamentEvent.heats.find(({ phase }) => phase === 'final');
    if (finalHeat === undefined || finalHeat.status !== 'completed') {
      throw new TournamentRuleError('Both final halves must be confirmed first');
    }

    const leaderboard = this.getLeaderboard('final');
    const winner = leaderboard[0];
    const runnerUp = leaderboard[1];
    if (winner === undefined || runnerUp === undefined) {
      throw new TournamentRuleError('The final needs two eligible completed results');
    }
    if (championOverrideId === undefined && comparePerformance(winner, runnerUp) === 0) {
      throw new TournamentTieError('The final is tied and requires a tiebreak');
    }

    const championId = championOverrideId ?? winner.participantId;
    if (!finalHeat.participantIds.includes(championId)) {
      throw new TournamentRuleError('Champion override must be one of the two finalists');
    }
    const participant = this.findParticipant(championId);
    this.tournamentEvent.championId = participant.id;
    this.tournamentEvent.phase = 'completed';
    this.touch();
    return { ...participant };
  }

  getChampion(): Participant | null {
    const championId = this.tournamentEvent.championId;
    return championId === undefined ? null : { ...this.findParticipant(championId) };
  }

  private currentAttemptResults(
    heat: Heat,
    halfIndex: number,
    status: HalfResult['status'],
  ): HalfResult[] {
    const scriptId = heat.scriptIds[halfIndex];
    return heat.results.filter(
      (result) =>
        result.halfIndex === halfIndex && result.scriptId === scriptId && result.status === status,
    );
  }

  private assertCompleteAttempt(heat: Heat, results: readonly HalfResult[]): void {
    const participantCount = heat.participantIds.filter(
      (participantId) => participantId !== undefined,
    ).length;
    if (results.length !== participantCount) {
      throw new TournamentRuleError('A host decision must cover every player in the half');
    }
  }

  private assertEventPhaseAllows(heat: Heat): void {
    if (heat.phase === 'qualifier' && this.tournamentEvent.phase !== 'qualifiers') {
      throw new TournamentRuleError('Qualifier play is closed');
    }
    if (heat.phase === 'final' && this.tournamentEvent.phase !== 'final') {
      throw new TournamentRuleError('Final play is not active');
    }
    if (heat.phase === 'tiebreak' && this.tournamentEvent.phase === 'completed') {
      throw new TournamentRuleError('Tiebreak play is closed');
    }
  }

  private assertScriptsAvailable(phase: CompetitionPhase, required: number): void {
    const pool = scriptsForPhase(this.scriptPools, phase);
    const consumed = new Set(this.tournamentEvent.consumedScriptIds);
    const available = pool.filter((scriptId) => !consumed.has(scriptId)).length;
    if (available < required) {
      throw new ScriptPoolExhaustedError(phase);
    }
  }

  private findHeat(heatId: string): Heat {
    const heat = this.tournamentEvent.heats.find(({ id }) => id === heatId);
    if (heat === undefined) {
      throw new TournamentRuleError(`Unknown heat: ${heatId}`);
    }
    return heat;
  }

  private findParticipant(participantId: string): Participant {
    const participant = this.tournamentEvent.participants.find(({ id }) => id === participantId);
    if (participant === undefined) {
      throw new TournamentRuleError(`Unknown participant: ${participantId}`);
    }
    return participant;
  }

  private touch(): void {
    this.tournamentEvent.updatedAt = Math.max(
      this.clock(),
      this.tournamentEvent.updatedAt + 1,
    );
  }
}

export function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const shuffled = [...values];
  const random = mulberry32(seed >>> 0);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const replacement = shuffled[swapIndex];
    if (current === undefined || replacement === undefined) {
      continue;
    }
    shuffled[index] = replacement;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function createParticipants(input: CreateTournamentInput, createdAt: number): Participant[] {
  const participants = input.participants.map((draft, index): Participant => ({
    id: draft.id?.trim() || `${input.eventId.trim()}-participant-${index + 1}`,
    displayName: draft.displayName.trim(),
    activeHand: draft.activeHand ?? 'right',
    posture: draft.posture ?? 'standing',
    rankingEligible: true,
    createdAt: draft.createdAt ?? createdAt + index,
  }));
  const ids = new Set(participants.map(({ id }) => id));
  if (ids.size !== participants.length) {
    throw new TournamentRuleError('Participant IDs must be unique');
  }
  return participants;
}

function validateCreateInput(input: CreateTournamentInput, minimum: number): void {
  if (input.eventId.trim().length === 0) {
    throw new TournamentRuleError('Event ID is required');
  }
  if (input.title.trim().length === 0) {
    throw new TournamentRuleError('Event title is required');
  }
  if (input.scriptPoolVersion.trim().length === 0) {
    throw new TournamentRuleError('Script pool version is required');
  }
  if (input.participants.length < minimum || input.participants.length > MAXIMUM_EVENT_PARTICIPANTS) {
    throw new TournamentRuleError(
      `Roster must contain ${minimum}-${MAXIMUM_EVENT_PARTICIPANTS} ranking participants`,
    );
  }
  if (input.participants.some(({ displayName }) => displayName.trim().length === 0)) {
    throw new TournamentRuleError('Every participant needs a display name');
  }
  if (!Number.isInteger(input.seed)) {
    throw new TournamentRuleError('Pairing seed must be an integer');
  }
  if (
    input.intermissionMs !== undefined &&
    (!Number.isFinite(input.intermissionMs) || input.intermissionMs < DEFAULT_INTERMISSION_MS)
  ) {
    throw new TournamentRuleError('Side-swap rest must be at least 30 seconds');
  }
  if (
    input.practiceDurationMs !== undefined &&
    (!Number.isFinite(input.practiceDurationMs) || input.practiceDurationMs <= 0)
  ) {
    throw new TournamentRuleError('Practice duration must be positive');
  }
}

function validateScriptPools(scriptPools: TournamentScriptPools): void {
  const allIds = [
    ...scriptPools.qualifier,
    ...scriptPools.final,
    ...(scriptPools.tiebreak ?? []),
  ];
  if (allIds.some((id) => id.trim().length === 0)) {
    throw new TournamentRuleError('Script IDs cannot be blank');
  }
  if (new Set(allIds).size !== allIds.length) {
    throw new TournamentRuleError('Script IDs must be unique across every phase pool');
  }
}

function validateEventSnapshot(event: TournamentEvent): void {
  if (event.schemaVersion !== 1) {
    throw new TournamentRuleError(`Unsupported event schema ${String(event.schemaVersion)}`);
  }
  const participantIds = event.participants.map(({ id }) => id);
  if (new Set(participantIds).size !== participantIds.length) {
    throw new TournamentRuleError('Stored participant IDs are not unique');
  }
  const heatIds = event.heats.map(({ id }) => id);
  if (new Set(heatIds).size !== heatIds.length) {
    throw new TournamentRuleError('Stored heat IDs are not unique');
  }
}

function validateScore(score: ScoreBreakdown): void {
  const integerFields = [
    score.score,
    score.fruitHits,
    score.fruitMisses,
    score.bombsHit,
    score.combo,
    score.maxCombo,
  ];
  if (integerFields.some((value) => !Number.isInteger(value))) {
    throw new TournamentRuleError('Score fields must be integers');
  }
  if (
    score.fruitHits < 0 ||
    score.fruitMisses < 0 ||
    score.bombsHit < 0 ||
    score.combo < 0 ||
    score.maxCombo < 0
  ) {
    throw new TournamentRuleError('Score counters cannot be negative');
  }
}

function laneFor(participantIndex: number, halfIndex: 0 | 1): Lane {
  const startsLeft = participantIndex === 0;
  return startsLeft === (halfIndex === 0) ? 'left' : 'right';
}

function assertPlayableHalfIndex(halfIndex: number): 0 | 1 {
  if (halfIndex !== 0 && halfIndex !== 1) {
    throw new TournamentRuleError(`Half ${halfIndex + 1} is not playable`);
  }
  return halfIndex;
}

function scriptsForPhase(
  pools: TournamentScriptPools,
  phase: CompetitionPhase,
): readonly string[] {
  if (phase === 'qualifier') {
    return pools.qualifier;
  }
  if (phase === 'final') {
    return pools.final;
  }
  if (phase === 'tiebreak') {
    return pools.tiebreak ?? [];
  }
  return [];
}

function drawScript(
  eventId: string,
  phase: CompetitionPhase,
  pools: TournamentScriptPools,
  consumedScriptIds: string[],
): string {
  const consumed = new Set(consumedScriptIds);
  const available = scriptsForPhase(pools, phase).filter((scriptId) => !consumed.has(scriptId));
  if (available.length === 0) {
    throw new ScriptPoolExhaustedError(phase);
  }
  const drawSeed = hashString(`${eventId}:${phase}:${consumedScriptIds.length}`);
  const scriptId = seededShuffle(available, drawSeed)[0];
  if (scriptId === undefined) {
    throw new ScriptPoolExhaustedError(phase);
  }
  consumedScriptIds.push(scriptId);
  return scriptId;
}

function emptyLeaderboardEntry(participant: Participant): LeaderboardEntry {
  return {
    rank: 0,
    participantId: participant.id,
    displayName: participant.displayName,
    score: 0,
    fruitHits: 0,
    fruitMisses: 0,
    bombsHit: 0,
    combo: 0,
    maxCombo: 0,
    halvesConfirmed: 0,
  };
}

/** Negative means left ranks ahead of right. */
function comparePerformance(left: LeaderboardEntry, right: LeaderboardEntry): number {
  return (
    right.score - left.score ||
    left.bombsHit - right.bombsHit ||
    left.fruitMisses - right.fruitMisses ||
    right.fruitHits - left.fruitHits ||
    right.maxCombo - left.maxCombo
  );
}

function uniquePacerId(eventId: string, participantIds: ReadonlySet<string>): string {
  const base = `${eventId.trim()}-pacer`;
  let id = base;
  let suffix = 2;
  while (participantIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function cloneEvent(event: TournamentEvent): TournamentEvent {
  return structuredClone(event);
}

function cloneHeat(heat: Heat): Heat {
  return structuredClone(heat);
}

function cloneHalfResult(result: HalfResult): HalfResult {
  return structuredClone(result);
}
