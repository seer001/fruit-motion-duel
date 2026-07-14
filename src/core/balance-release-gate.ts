import type { Difficulty, PlayerPosture } from '../types/game';

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const POSTURES: readonly PlayerPosture[] = ['standing', 'seated'];
const EPSILON = 1e-12;

/**
 * One measured play session. Rates are fractions in the inclusive range 0–1.
 * Repeated sessions are allowed: they are averaged per participant before the
 * group comparison so one frequent tester cannot dominate the release result.
 */
export interface BalanceValidationSample {
  participantId: string;
  difficulty: Difficulty;
  posture: PlayerPosture;
  score: number;
  hitRate: number;
  bombMistouchRate: number;
  validTrackingRate: number;
}

export interface BalanceReleaseThresholds {
  minimumPairedParticipants: number;
  minimumScoreRatio: number;
  maximumScoreRatio: number;
  maximumHitRateGap: number;
  maximumBombMistouchRateGap: number;
  minimumValidTrackingRate: number;
}

export const DEFAULT_BALANCE_RELEASE_THRESHOLDS = {
  minimumPairedParticipants: 24,
  minimumScoreRatio: 0.95,
  maximumScoreRatio: 1.05,
  maximumHitRateGap: 0.03,
  maximumBombMistouchRateGap: 0.01,
  minimumValidTrackingRate: 0.985,
} as const satisfies BalanceReleaseThresholds;

export type BalanceGateFailure =
  | 'insufficient-paired-participants'
  | 'score-ratio-out-of-range'
  | 'hit-rate-gap-too-large'
  | 'bomb-mistouch-rate-gap-too-large'
  | 'standing-valid-tracking-rate-too-low'
  | 'seated-valid-tracking-rate-too-low';

export interface PostureMeans {
  standing: number | null;
  seated: number | null;
}

export interface DifficultyBalanceGateResult {
  difficulty: Difficulty;
  /** Players with at least one seated and one standing sample at this difficulty. */
  pairedParticipantCount: number;
  pairedParticipantIds: string[];
  scoreMeans: PostureMeans;
  /** Seated mean divided by standing mean. */
  scoreRatio: number | null;
  hitRateMeans: PostureMeans;
  hitRateGap: number | null;
  bombMistouchRateMeans: PostureMeans;
  bombMistouchRateGap: number | null;
  validTrackingRateMeans: PostureMeans;
  failures: BalanceGateFailure[];
  passed: boolean;
}

export interface BalanceReleaseGateReport {
  thresholds: BalanceReleaseThresholds;
  difficulties: Record<Difficulty, DifficultyBalanceGateResult>;
  eligibleDifficulties: Difficulty[];
  /** True only when every difficulty independently passes the field-test gate. */
  passed: boolean;
}

interface MetricTotals {
  score: number;
  hitRate: number;
  bombMistouchRate: number;
  validTrackingRate: number;
  count: number;
}

interface ParticipantSamples {
  standing: MetricTotals;
  seated: MetricTotals;
}

function emptyTotals(): MetricTotals {
  return {
    score: 0,
    hitRate: 0,
    bombMistouchRate: 0,
    validTrackingRate: 0,
    count: 0,
  };
}

function mean(total: number, count: number): number {
  return total / count;
}

function within(value: number | null, minimum: number, maximum: number): boolean {
  return value !== null && value + EPSILON >= minimum && value - EPSILON <= maximum;
}

function atMost(value: number | null, maximum: number): boolean {
  return value !== null && value - EPSILON <= maximum;
}

function atLeast(value: number | null, minimum: number): boolean {
  return value !== null && value + EPSILON >= minimum;
}

function validateThresholds(thresholds: BalanceReleaseThresholds): void {
  if (!Number.isInteger(thresholds.minimumPairedParticipants) || thresholds.minimumPairedParticipants <= 0) {
    throw new RangeError('minimumPairedParticipants must be a positive integer');
  }

  const rates: Array<[keyof BalanceReleaseThresholds, number]> = [
    ['minimumScoreRatio', thresholds.minimumScoreRatio],
    ['maximumScoreRatio', thresholds.maximumScoreRatio],
    ['maximumHitRateGap', thresholds.maximumHitRateGap],
    ['maximumBombMistouchRateGap', thresholds.maximumBombMistouchRateGap],
    ['minimumValidTrackingRate', thresholds.minimumValidTrackingRate],
  ];
  for (const [name, value] of rates) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative finite number`);
    }
  }
  if (thresholds.maximumScoreRatio < thresholds.minimumScoreRatio) {
    throw new RangeError('maximumScoreRatio must be greater than or equal to minimumScoreRatio');
  }
  if (
    thresholds.maximumHitRateGap > 1 ||
    thresholds.maximumBombMistouchRateGap > 1 ||
    thresholds.minimumValidTrackingRate > 1
  ) {
    throw new RangeError('rate thresholds must be fractions in the range 0–1');
  }
}

function validateSample(sample: BalanceValidationSample, index: number): void {
  if (sample.participantId.trim().length === 0) {
    throw new TypeError(`samples[${index}].participantId must not be empty`);
  }
  if (!DIFFICULTIES.includes(sample.difficulty)) {
    throw new TypeError(`samples[${index}].difficulty is invalid`);
  }
  if (!POSTURES.includes(sample.posture)) {
    throw new TypeError(`samples[${index}].posture is invalid`);
  }
  if (!Number.isFinite(sample.score) || sample.score < 0) {
    throw new RangeError(`samples[${index}].score must be a non-negative finite number`);
  }
  for (const field of ['hitRate', 'bombMistouchRate', 'validTrackingRate'] as const) {
    const value = sample[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`samples[${index}].${field} must be a fraction in the range 0–1`);
    }
  }
}

function evaluateDifficulty(
  difficulty: Difficulty,
  samples: readonly BalanceValidationSample[],
  thresholds: BalanceReleaseThresholds,
): DifficultyBalanceGateResult {
  const participants = new Map<string, ParticipantSamples>();

  for (const sample of samples) {
    if (sample.difficulty !== difficulty) continue;
    let participant = participants.get(sample.participantId);
    if (!participant) {
      participant = { standing: emptyTotals(), seated: emptyTotals() };
      participants.set(sample.participantId, participant);
    }
    const totals = participant[sample.posture];
    totals.score += sample.score;
    totals.hitRate += sample.hitRate;
    totals.bombMistouchRate += sample.bombMistouchRate;
    totals.validTrackingRate += sample.validTrackingRate;
    totals.count += 1;
  }

  const pairedParticipantIds = [...participants.entries()]
    .filter(([, value]) => value.standing.count > 0 && value.seated.count > 0)
    .map(([participantId]) => participantId)
    .sort();

  const groupTotals: Record<PlayerPosture, MetricTotals> = {
    standing: emptyTotals(),
    seated: emptyTotals(),
  };

  for (const participantId of pairedParticipantIds) {
    const participant = participants.get(participantId)!;
    for (const posture of POSTURES) {
      const source = participant[posture];
      const target = groupTotals[posture];
      target.score += mean(source.score, source.count);
      target.hitRate += mean(source.hitRate, source.count);
      target.bombMistouchRate += mean(source.bombMistouchRate, source.count);
      target.validTrackingRate += mean(source.validTrackingRate, source.count);
      target.count += 1;
    }
  }

  const groupMean = (posture: PlayerPosture, field: keyof Omit<MetricTotals, 'count'>) => {
    const totals = groupTotals[posture];
    return totals.count === 0 ? null : mean(totals[field], totals.count);
  };
  const postureMeans = (field: keyof Omit<MetricTotals, 'count'>): PostureMeans => ({
    standing: groupMean('standing', field),
    seated: groupMean('seated', field),
  });

  const scoreMeans = postureMeans('score');
  const scoreRatio =
    scoreMeans.standing === null || scoreMeans.seated === null
      ? null
      : scoreMeans.standing === 0
        ? scoreMeans.seated === 0
          ? 1
          : null
        : scoreMeans.seated / scoreMeans.standing;
  const hitRateMeans = postureMeans('hitRate');
  const hitRateGap =
    hitRateMeans.standing === null || hitRateMeans.seated === null
      ? null
      : Math.abs(hitRateMeans.seated - hitRateMeans.standing);
  const bombMistouchRateMeans = postureMeans('bombMistouchRate');
  const bombMistouchRateGap =
    bombMistouchRateMeans.standing === null || bombMistouchRateMeans.seated === null
      ? null
      : Math.abs(bombMistouchRateMeans.seated - bombMistouchRateMeans.standing);
  const validTrackingRateMeans = postureMeans('validTrackingRate');

  const failures: BalanceGateFailure[] = [];
  if (pairedParticipantIds.length < thresholds.minimumPairedParticipants) {
    failures.push('insufficient-paired-participants');
  }
  if (!within(scoreRatio, thresholds.minimumScoreRatio, thresholds.maximumScoreRatio)) {
    failures.push('score-ratio-out-of-range');
  }
  if (!atMost(hitRateGap, thresholds.maximumHitRateGap)) {
    failures.push('hit-rate-gap-too-large');
  }
  if (!atMost(bombMistouchRateGap, thresholds.maximumBombMistouchRateGap)) {
    failures.push('bomb-mistouch-rate-gap-too-large');
  }
  if (!atLeast(validTrackingRateMeans.standing, thresholds.minimumValidTrackingRate)) {
    failures.push('standing-valid-tracking-rate-too-low');
  }
  if (!atLeast(validTrackingRateMeans.seated, thresholds.minimumValidTrackingRate)) {
    failures.push('seated-valid-tracking-rate-too-low');
  }

  return {
    difficulty,
    pairedParticipantCount: pairedParticipantIds.length,
    pairedParticipantIds,
    scoreMeans,
    scoreRatio,
    hitRateMeans,
    hitRateGap,
    bombMistouchRateMeans,
    bombMistouchRateGap,
    validTrackingRateMeans,
    failures,
    passed: failures.length === 0,
  };
}

/**
 * Evaluates the physical sitting/standing crossover test. A difficulty is
 * eligible for a shared leaderboard only when all of its gates pass; the
 * report itself passes only when Easy, Normal and Hard all pass independently.
 */
export function evaluateBalanceReleaseGate(
  samples: readonly BalanceValidationSample[],
  thresholds: BalanceReleaseThresholds = DEFAULT_BALANCE_RELEASE_THRESHOLDS,
): BalanceReleaseGateReport {
  validateThresholds(thresholds);
  samples.forEach(validateSample);

  const results = DIFFICULTIES.map((difficulty) =>
    evaluateDifficulty(difficulty, samples, thresholds),
  );
  const difficulties = Object.fromEntries(
    results.map((result) => [result.difficulty, result]),
  ) as Record<Difficulty, DifficultyBalanceGateResult>;
  const eligibleDifficulties = results
    .filter((result) => result.passed)
    .map((result) => result.difficulty);

  return {
    thresholds: { ...thresholds },
    difficulties,
    eligibleDifficulties,
    passed: eligibleDifficulties.length === DIFFICULTIES.length,
  };
}
