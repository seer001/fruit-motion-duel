import type { BalanceDefinition, Difficulty } from '../types/game';

export const STANDARD_HALF_DURATION_MS = 25_000;

/**
 * Tournament values are expressed in player-local coordinates.  In particular,
 * radiusRatio and minimumSliceSpeed must not be interpreted as screen pixels.
 */
export const BALANCE_BY_DIFFICULTY = {
  easy: {
    difficulty: 'easy',
    fruitsPer25Seconds: 20,
    bombsPer25Seconds: 1,
    maxConcurrent: 2,
    radiusRatio: 0.075,
    minFlightMs: 2_050,
    maxFlightMs: 2_250,
    minimumSliceSpeed: 0.45,
  },
  normal: {
    difficulty: 'normal',
    fruitsPer25Seconds: 28,
    bombsPer25Seconds: 3,
    maxConcurrent: 3,
    radiusRatio: 0.065,
    minFlightMs: 1_750,
    maxFlightMs: 2_050,
    minimumSliceSpeed: 0.55,
  },
  hard: {
    difficulty: 'hard',
    fruitsPer25Seconds: 36,
    bombsPer25Seconds: 5,
    maxConcurrent: 4,
    radiusRatio: 0.055,
    minFlightMs: 1_400,
    maxFlightMs: 1_750,
    minimumSliceSpeed: 0.65,
  },
} as const satisfies Record<Difficulty, BalanceDefinition>;

export interface ScriptSafetyDefinition {
  /** Minimum time between consecutive launches. */
  minimumReactionMs: number;
  /**
   * A fruit and bomb closer in time than this must be separated spatially by
   * minimumFruitBombDistance.
   */
  fruitBombWindowMs: number;
  minimumFruitBombDistance: number;
}

export const SCRIPT_SAFETY_BY_DIFFICULTY = {
  easy: {
    minimumReactionMs: 650,
    fruitBombWindowMs: 850,
    minimumFruitBombDistance: 0.24,
  },
  normal: {
    minimumReactionMs: 450,
    fruitBombWindowMs: 700,
    minimumFruitBombDistance: 0.2,
  },
  hard: {
    minimumReactionMs: 320,
    fruitBombWindowMs: 575,
    minimumFruitBombDistance: 0.17,
  },
} as const satisfies Record<Difficulty, ScriptSafetyDefinition>;

export const SCRIPT_COMPARABILITY_TOLERANCE = 0.02;

export function getBalance(difficulty: Difficulty): BalanceDefinition {
  return BALANCE_BY_DIFFICULTY[difficulty];
}

export function getExpectedObjectCounts(
  difficulty: Difficulty,
  durationMs = STANDARD_HALF_DURATION_MS,
): { fruits: number; bombs: number } {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('durationMs must be a positive finite number');
  }

  const balance = getBalance(difficulty);
  const durationScale = durationMs / STANDARD_HALF_DURATION_MS;
  return {
    fruits: Math.max(1, Math.round(balance.fruitsPer25Seconds * durationScale)),
    bombs: Math.max(0, Math.round(balance.bombsPer25Seconds * durationScale)),
  };
}
