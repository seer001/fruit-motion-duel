import type {
  Difficulty,
  Point,
  ScoreBreakdown,
  ScriptDefinition,
  ScriptObject,
} from '../types/game';
import { ScoreEngine } from './score-engine';

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const DEFAULT_SCORE_TOLERANCE = 0.02;
const EPSILON = 1e-12;
const STARTING_WRIST: Point = { x: 0.5, y: 0.86 };

/**
 * A deliberately small, fixed cohort spanning novice to expert play. Values use
 * player-lane coordinates, so handSpeed is normalized lane lengths per second.
 */
export interface VirtualOneHandPlayer {
  id: string;
  reactionMs: number;
  recoveryMs: number;
  handSpeed: number;
  fruitPrecision: number;
  bombControl: number;
}

export const DEFAULT_VIRTUAL_ONE_HAND_COHORT: readonly VirtualOneHandPlayer[] =
  Object.freeze([
    Object.freeze({
      id: 'novice-steady',
      reactionMs: 330,
      recoveryMs: 145,
      handSpeed: 0.92,
      fruitPrecision: 0.78,
      bombControl: 0.76,
    }),
    Object.freeze({
      id: 'novice-fast',
      reactionMs: 285,
      recoveryMs: 130,
      handSpeed: 1.08,
      fruitPrecision: 0.8,
      bombControl: 0.72,
    }),
    Object.freeze({
      id: 'casual-balanced',
      reactionMs: 250,
      recoveryMs: 115,
      handSpeed: 1.2,
      fruitPrecision: 0.86,
      bombControl: 0.84,
    }),
    Object.freeze({
      id: 'casual-controlled',
      reactionMs: 235,
      recoveryMs: 105,
      handSpeed: 1.14,
      fruitPrecision: 0.89,
      bombControl: 0.92,
    }),
    Object.freeze({
      id: 'advanced-mobile',
      reactionMs: 195,
      recoveryMs: 85,
      handSpeed: 1.48,
      fruitPrecision: 0.93,
      bombControl: 0.9,
    }),
    Object.freeze({
      id: 'expert-controlled',
      reactionMs: 165,
      recoveryMs: 70,
      handSpeed: 1.62,
      fruitPrecision: 0.96,
      bombControl: 0.97,
    }),
  ] satisfies VirtualOneHandPlayer[]);

/**
 * Explicit limits of this release-gate model. These strings can be surfaced by
 * a CLI/report without duplicating the assumptions in another layer.
 */
export const SCRIPT_POOL_SIMULATOR_ASSUMPTIONS = Object.freeze([
  'One active wrist starts at the bottom-centre of a normalized player lane.',
  'A fruit is attempted near its apex after the virtual player reaction delay.',
  'Reachability depends on reaction time, recovery time, hand speed, fruit radius and deterministic precision variation.',
  'Bomb hits approximate a one-hand sweep crossing a bomb; no pose, renderer or hardware latency is simulated.',
  'Canonical left/right and dominant-hand mirrors are distance-preserving and therefore share one simulation.',
  'This is a deterministic pre-screen only; it does not replace the required 24-player seated/standing field test.',
] as const);

export interface VirtualPlayerScriptResult {
  playerId: string;
  breakdown: ScoreBreakdown;
}

export interface ScriptScoreSimulation {
  scriptId: string;
  difficulty: Difficulty;
  phase: ScriptDefinition['phase'];
  durationMs: number;
  playerResults: VirtualPlayerScriptResult[];
  meanScore: number;
  difficultyPoolMean: number;
  lowerAllowedScore: number;
  upperAllowedScore: number;
  relativeDeviation: number;
  withinTolerance: boolean;
}

export interface ScriptPoolSimulationOptions {
  /** Defaults to the plan's same-difficulty mean +/-2% rule. */
  scoreTolerance?: number;
  /** Defaults to DEFAULT_VIRTUAL_ONE_HAND_COHORT. */
  cohort?: readonly VirtualOneHandPlayer[];
}

export interface ScriptPoolSimulationReport {
  scoreTolerance: number;
  cohort: readonly VirtualOneHandPlayer[];
  difficultyMeans: Partial<Record<Difficulty, number>>;
  scripts: ScriptScoreSimulation[];
  outlierScriptIds: string[];
  passed: boolean;
  assumptions: typeof SCRIPT_POOL_SIMULATOR_ASSUMPTIONS;
}

interface FruitAttempt {
  object: ScriptObject;
  objectIndex: number;
  targetAtMs: number;
  hit: boolean;
}

interface SuccessfulFruitTarget {
  point: Point;
  targetAtMs: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * A common-random-number sample shared by every comparable script. Keeping the
 * latent player draw fixed makes differences represent script geometry rather
 * than Monte Carlo noise from each script seed.
 */
function deterministicUnit(
  script: ScriptDefinition,
  playerId: string,
  objectIndex: number,
  purpose: 'fruit' | 'bomb',
): number {
  const hash = hashString(
    `${script.difficulty}:${script.phase}:${script.durationMs}:${playerId}:${objectIndex}:${purpose}`,
  );
  return hash / 4_294_967_296;
}

function validatePlayer(player: VirtualOneHandPlayer, index: number): void {
  if (player.id.trim().length === 0) {
    throw new TypeError(`cohort[${index}].id must not be empty`);
  }
  for (const field of ['reactionMs', 'recoveryMs', 'handSpeed'] as const) {
    const value = player[field];
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`cohort[${index}].${field} must be a non-negative finite number`);
    }
  }
  if (player.handSpeed === 0) {
    throw new RangeError(`cohort[${index}].handSpeed must be greater than zero`);
  }
  for (const field of ['fruitPrecision', 'bombControl'] as const) {
    const value = player[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`cohort[${index}].${field} must be a fraction in the range 0-1`);
    }
  }
}

function validateScriptInput(script: ScriptDefinition, index: number): void {
  if (script.id.trim().length === 0) {
    throw new TypeError(`scripts[${index}].id must not be empty`);
  }
  if (!DIFFICULTIES.includes(script.difficulty)) {
    throw new TypeError(`scripts[${index}].difficulty is invalid`);
  }
  if (!Number.isFinite(script.durationMs) || script.durationMs <= 0) {
    throw new RangeError(`scripts[${index}].durationMs must be a positive finite number`);
  }
  if (!Number.isFinite(script.seed)) {
    throw new RangeError(`scripts[${index}].seed must be finite`);
  }
  if (script.objects.length === 0) {
    throw new RangeError(`scripts[${index}].objects must not be empty`);
  }

  const objectIds = new Set<string>();
  script.objects.forEach((object, objectIndex) => {
    if (object.id.trim().length === 0 || objectIds.has(object.id)) {
      throw new TypeError(
        `scripts[${index}].objects[${objectIndex}].id must be non-empty and unique`,
      );
    }
    objectIds.add(object.id);
    if (
      !Number.isFinite(object.spawnAtMs) ||
      object.spawnAtMs < 0 ||
      !Number.isFinite(object.flightMs) ||
      object.flightMs <= 0 ||
      object.spawnAtMs + object.flightMs > script.durationMs ||
      !Number.isFinite(object.x) ||
      object.x < 0 ||
      object.x > 1 ||
      !Number.isFinite(object.apexY) ||
      object.apexY < 0 ||
      object.apexY > 1 ||
      !Number.isFinite(object.radiusRatio) ||
      object.radiusRatio <= 0
    ) {
      throw new RangeError(`scripts[${index}].objects[${objectIndex}] has invalid geometry or timing`);
    }
  });
}

function assertComparableDifficultyPools(scripts: readonly ScriptDefinition[]): void {
  const shapeByDifficulty = new Map<Difficulty, { phase: ScriptDefinition['phase']; durationMs: number }>();
  for (const script of scripts) {
    const existing = shapeByDifficulty.get(script.difficulty);
    if (!existing) {
      shapeByDifficulty.set(script.difficulty, {
        phase: script.phase,
        durationMs: script.durationMs,
      });
      continue;
    }
    if (existing.phase !== script.phase || existing.durationMs !== script.durationMs) {
      throw new Error(
        `${script.difficulty} scripts must share phase and duration before comparing their mean scores`,
      );
    }
  }
}

function targetPoint(object: ScriptObject): Point {
  return { x: object.x, y: object.apexY };
}

function targetTime(object: ScriptObject): number {
  return object.spawnAtMs + object.flightMs * 0.5;
}

function fruitAttempts(
  script: ScriptDefinition,
  player: VirtualOneHandPlayer,
): FruitAttempt[] {
  const fruits = script.objects
    .map((object, objectIndex) => ({ object, objectIndex }))
    .filter(({ object }) => object.kind === 'fruit')
    .sort(
      (left, right) =>
        targetTime(left.object) - targetTime(right.object) || left.objectIndex - right.objectIndex,
    );

  let wrist = STARTING_WRIST;
  let lastHitAtMs = 0;
  return fruits.map(({ object, objectIndex }) => {
    const atMs = targetTime(object);
    const movementStartsAtMs = Math.max(
      lastHitAtMs + player.recoveryMs,
      object.spawnAtMs + player.reactionMs,
    );
    const movementMs = Math.max(0, atMs - movementStartsAtMs);
    const travel = distance(wrist, targetPoint(object));
    const reachableDistance = player.handSpeed * (movementMs / 1_000);
    const reachRatio = travel <= EPSILON ? 2 : reachableDistance / travel;
    const reachFactor = clamp((reachRatio - 0.5) / 0.65, 0, 1);
    const reactionHeadroom = object.flightMs * 0.5 - player.reactionMs;
    const timingFactor = clamp((reactionHeadroom + 80) / 420, 0, 1);
    const radiusFactor = clamp(object.radiusRatio / 0.07, 0.72, 1.08);
    const edgeFactor = 1 - Math.max(0, Math.abs(object.x - 0.5) - 0.32) * 0.35;
    const hitChance = clamp(
      player.fruitPrecision *
        (0.55 + 0.45 * reachFactor) *
        (0.72 + 0.28 * timingFactor) *
        radiusFactor *
        edgeFactor,
      0,
      0.995,
    );
    const hit = deterministicUnit(script, player.id, objectIndex, 'fruit') < hitChance;

    if (hit) {
      wrist = targetPoint(object);
      lastHitAtMs = atMs;
    }
    return { object, objectIndex, targetAtMs: atMs, hit };
  });
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return distance(point, start);
  const projection = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    0,
    1,
  );
  return distance(point, {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  });
}

function bombWasHit(
  script: ScriptDefinition,
  bomb: ScriptObject,
  objectIndex: number,
  successfulTargets: readonly SuccessfulFruitTarget[],
  player: VirtualOneHandPlayer,
): boolean {
  if (successfulTargets.length === 0) return false;
  const bombAtMs = targetTime(bomb);
  const bombPoint = targetPoint(bomb);
  let closestSweepDistance = Number.POSITIVE_INFINITY;
  let timingAffinity = 0;

  for (let index = 0; index < successfulTargets.length; index += 1) {
    const current = successfulTargets[index];
    if (!current) continue;
    const previous = successfulTargets[index - 1] ?? {
      point: STARTING_WRIST,
      targetAtMs: 0,
    };
    const timeGap = current.targetAtMs - previous.targetAtMs;
    if (timeGap <= 0) continue;
    const timeDistance =
      bombAtMs < previous.targetAtMs
        ? previous.targetAtMs - bombAtMs
        : bombAtMs > current.targetAtMs
          ? bombAtMs - current.targetAtMs
          : 0;
    if (timeDistance > 550) continue;
    const sweepDistance = distanceToSegment(bombPoint, previous.point, current.point);
    if (sweepDistance < closestSweepDistance) {
      closestSweepDistance = sweepDistance;
      timingAffinity = 1 - timeDistance / 550;
    }
  }

  if (!Number.isFinite(closestSweepDistance)) return false;
  const sweepRadius = bomb.radiusRatio + 0.045;
  const proximity = clamp(1 - closestSweepDistance / sweepRadius, 0, 1);
  const risk = proximity * timingAffinity * (1 - player.bombControl) * 1.8;
  return deterministicUnit(script, player.id, objectIndex, 'bomb') < risk;
}

/** Simulates one canonical script for one virtual single-wrist player. */
export function simulateScriptForVirtualPlayer(
  script: ScriptDefinition,
  player: VirtualOneHandPlayer,
): VirtualPlayerScriptResult {
  validateScriptInput(script, 0);
  validatePlayer(player, 0);
  const attempts = fruitAttempts(script, player);
  const successfulTargets = attempts
    .filter((attempt) => attempt.hit)
    .map((attempt) => ({
      point: targetPoint(attempt.object),
      targetAtMs: attempt.targetAtMs,
    }));
  const outcomes: Array<{
    atMs: number;
    objectIndex: number;
    type: 'fruit-hit' | 'fruit-miss' | 'bomb-hit';
  }> = attempts.map((attempt) => ({
    atMs: attempt.targetAtMs,
    objectIndex: attempt.objectIndex,
    type: attempt.hit ? 'fruit-hit' : 'fruit-miss',
  }));

  script.objects.forEach((object, objectIndex) => {
    if (
      object.kind === 'bomb' &&
      bombWasHit(script, object, objectIndex, successfulTargets, player)
    ) {
      outcomes.push({ atMs: targetTime(object), objectIndex, type: 'bomb-hit' });
    }
  });
  outcomes.sort((left, right) => left.atMs - right.atMs || left.objectIndex - right.objectIndex);

  const score = new ScoreEngine();
  outcomes.forEach((outcome) => {
    score.apply({ id: `${outcome.objectIndex}:${outcome.type}`, type: outcome.type });
  });
  return { playerId: player.id, breakdown: score.snapshot() };
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function relativeDeviation(value: number, reference: number): number {
  if (reference === 0) return value === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(value - reference) / reference;
}

/**
 * Runs a deterministic fixed-cohort audit and flags scripts outside their own
 * difficulty pool mean by the configured relative tolerance (2% by default).
 */
export function simulateScriptPool(
  scripts: readonly ScriptDefinition[],
  options: ScriptPoolSimulationOptions = {},
): ScriptPoolSimulationReport {
  if (scripts.length === 0) throw new RangeError('scripts must not be empty');
  const scoreTolerance = options.scoreTolerance ?? DEFAULT_SCORE_TOLERANCE;
  if (!Number.isFinite(scoreTolerance) || scoreTolerance < 0 || scoreTolerance >= 1) {
    throw new RangeError('scoreTolerance must be a finite fraction in the range 0-1');
  }
  const cohort = options.cohort ?? DEFAULT_VIRTUAL_ONE_HAND_COHORT;
  if (cohort.length === 0) throw new RangeError('cohort must not be empty');

  const playerIds = new Set<string>();
  cohort.forEach((player, index) => {
    validatePlayer(player, index);
    if (playerIds.has(player.id)) throw new TypeError(`duplicate cohort player id: ${player.id}`);
    playerIds.add(player.id);
  });
  const scriptIds = new Set<string>();
  scripts.forEach((script, index) => {
    validateScriptInput(script, index);
    if (scriptIds.has(script.id)) throw new TypeError(`duplicate script id: ${script.id}`);
    scriptIds.add(script.id);
  });
  assertComparableDifficultyPools(scripts);

  const raw = scripts.map((script) => {
    const playerResults = cohort.map((player) =>
      simulateScriptForVirtualPlayer(script, player),
    );
    return {
      script,
      playerResults,
      meanScore: mean(playerResults.map((result) => result.breakdown.score)),
    };
  });

  const difficultyMeans: Partial<Record<Difficulty, number>> = {};
  for (const difficulty of DIFFICULTIES) {
    const scores = raw
      .filter((result) => result.script.difficulty === difficulty)
      .map((result) => result.meanScore);
    if (scores.length > 0) difficultyMeans[difficulty] = mean(scores);
  }

  const simulations: ScriptScoreSimulation[] = raw.map((result) => {
    const difficultyPoolMean = difficultyMeans[result.script.difficulty];
    if (difficultyPoolMean === undefined) throw new Error('difficulty pool mean missing');
    const lowerAllowedScore = difficultyPoolMean * (1 - scoreTolerance);
    const upperAllowedScore = difficultyPoolMean * (1 + scoreTolerance);
    const deviation = relativeDeviation(result.meanScore, difficultyPoolMean);
    return {
      scriptId: result.script.id,
      difficulty: result.script.difficulty,
      phase: result.script.phase,
      durationMs: result.script.durationMs,
      playerResults: result.playerResults,
      meanScore: result.meanScore,
      difficultyPoolMean,
      lowerAllowedScore,
      upperAllowedScore,
      relativeDeviation: deviation,
      withinTolerance: deviation <= scoreTolerance + EPSILON,
    };
  });
  const outlierScriptIds = simulations
    .filter((simulation) => !simulation.withinTolerance)
    .map((simulation) => simulation.scriptId);

  return {
    scoreTolerance,
    cohort: cohort.map((player) => ({ ...player })),
    difficultyMeans,
    scripts: simulations,
    outlierScriptIds,
    passed: outlierScriptIds.length === 0,
    assumptions: SCRIPT_POOL_SIMULATOR_ASSUMPTIONS,
  };
}
