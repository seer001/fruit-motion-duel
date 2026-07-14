import {
  SCRIPT_COMPARABILITY_TOLERANCE,
  SCRIPT_SAFETY_BY_DIFFICULTY,
  getBalance,
  getExpectedObjectCounts,
} from '../config/balance';
import type {
  BalanceDefinition,
  Difficulty,
  ScriptDefinition,
  ScriptFingerprint,
  ScriptObject,
} from '../types/game';

export type ScriptValidationIssueCode =
  | 'duplicate-id'
  | 'invalid-object'
  | 'fruit-count'
  | 'bomb-count'
  | 'peak-concurrent'
  | 'reaction-window'
  | 'fruit-bomb-spacing'
  | 'flight-window'
  | 'fingerprint-mismatch'
  | 'not-comparable';

export interface ScriptValidationIssue {
  code: ScriptValidationIssueCode;
  message: string;
  objectIds?: string[];
}

export interface FingerprintComparison {
  comparable: boolean;
  tolerance: number;
  totalTravelDifference: number;
  minimumReactionDifference: number;
  reasons: string[];
}

export interface ScriptValidationOptions {
  balance?: BalanceDefinition;
  referenceFingerprint?: ScriptFingerprint;
  comparabilityTolerance?: number;
}

export interface ScriptValidationResult {
  valid: boolean;
  issues: ScriptValidationIssue[];
  fingerprint: ScriptFingerprint;
  comparison?: FingerprintComparison;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function relativeDifference(value: number, reference: number): number {
  if (reference === 0) return value === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(value - reference) / Math.abs(reference);
}

/** Travel from the lane's bottom-centre launch point to the apex and back. */
export function objectTravel(object: Pick<ScriptObject, 'x' | 'apexY'>): number {
  return 2 * Math.hypot(object.x - 0.5, 1 - object.apexY);
}

export function calculatePeakConcurrent(objects: readonly ScriptObject[]): number {
  const sorted = objects.slice().sort((a, b) => a.spawnAtMs - b.spawnAtMs);
  let peak = 0;
  for (const current of sorted) {
    let concurrent = 0;
    for (const candidate of sorted) {
      if (
        candidate.spawnAtMs <= current.spawnAtMs &&
        candidate.spawnAtMs + candidate.flightMs > current.spawnAtMs
      ) {
        concurrent += 1;
      }
    }
    peak = Math.max(peak, concurrent);
  }
  return peak;
}

export function calculateMinimumReactionMs(
  objects: readonly ScriptObject[],
  durationMs: number,
): number {
  if (objects.length < 2) return durationMs;
  const spawnTimes = objects.map((object) => object.spawnAtMs).sort((a, b) => a - b);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < spawnTimes.length; index += 1) {
    const previous = spawnTimes[index - 1];
    const current = spawnTimes[index];
    if (previous === undefined || current === undefined) continue;
    minimum = Math.min(minimum, current - previous);
  }
  return Number.isFinite(minimum) ? minimum : durationMs;
}

export function fingerprintScript(
  objects: readonly ScriptObject[],
  durationMs: number,
): ScriptFingerprint {
  const quadrantCounts: [number, number, number, number] = [0, 0, 0, 0];
  let fruits = 0;
  let bombs = 0;
  let totalTravel = 0;

  for (const object of objects) {
    if (object.kind === 'fruit') fruits += 1;
    else bombs += 1;
    totalTravel += objectTravel(object);

    const quadrant: 0 | 1 | 2 | 3 =
      object.apexY < 0.5
        ? object.x < 0.5
          ? 0
          : 1
        : object.x < 0.5
          ? 2
          : 3;
    quadrantCounts[quadrant] += 1;
  }

  return {
    fruits,
    bombs,
    totalTravel: roundMetric(totalTravel),
    quadrantCounts,
    peakConcurrent: calculatePeakConcurrent(objects),
    minimumReactionMs: calculateMinimumReactionMs(objects, durationMs),
  };
}

export function compareFingerprints(
  candidate: ScriptFingerprint,
  reference: ScriptFingerprint,
  tolerance = SCRIPT_COMPARABILITY_TOLERANCE,
): FingerprintComparison {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('comparability tolerance must be non-negative');
  }

  const reasons: string[] = [];
  if (candidate.fruits !== reference.fruits) reasons.push('fruit count differs');
  if (candidate.bombs !== reference.bombs) reasons.push('bomb count differs');
  if (candidate.peakConcurrent !== reference.peakConcurrent) {
    reasons.push('peak concurrency differs');
  }
  if (candidate.quadrantCounts.some((count, index) => count !== reference.quadrantCounts[index])) {
    reasons.push('quadrant distribution differs');
  }

  const totalTravelDifference = relativeDifference(
    candidate.totalTravel,
    reference.totalTravel,
  );
  const minimumReactionDifference = relativeDifference(
    candidate.minimumReactionMs,
    reference.minimumReactionMs,
  );
  const comparisonEpsilon = 1e-12;
  if (totalTravelDifference > tolerance + comparisonEpsilon) {
    reasons.push('total travel exceeds tolerance');
  }
  if (minimumReactionDifference > tolerance + comparisonEpsilon) {
    reasons.push('minimum reaction window exceeds tolerance');
  }

  return {
    comparable: reasons.length === 0,
    tolerance,
    totalTravelDifference,
    minimumReactionDifference,
    reasons,
  };
}

function fingerprintsEqual(left: ScriptFingerprint, right: ScriptFingerprint): boolean {
  return (
    left.fruits === right.fruits &&
    left.bombs === right.bombs &&
    left.peakConcurrent === right.peakConcurrent &&
    left.minimumReactionMs === right.minimumReactionMs &&
    Math.abs(left.totalTravel - right.totalTravel) < 0.000_001 &&
    left.quadrantCounts.every((count, index) => count === right.quadrantCounts[index])
  );
}

function fruitBombSpacingIssues(
  objects: readonly ScriptObject[],
  difficulty: Difficulty,
): ScriptValidationIssue[] {
  const safety = SCRIPT_SAFETY_BY_DIFFICULTY[difficulty];
  const fruits = objects.filter((object) => object.kind === 'fruit');
  const bombs = objects.filter((object) => object.kind === 'bomb');
  const issues: ScriptValidationIssue[] = [];

  for (const bomb of bombs) {
    for (const fruit of fruits) {
      const timeDistance = Math.abs(bomb.spawnAtMs - fruit.spawnAtMs);
      if (timeDistance >= safety.fruitBombWindowMs) continue;
      const spatialDistance = Math.hypot(bomb.x - fruit.x, bomb.apexY - fruit.apexY);
      if (spatialDistance < safety.minimumFruitBombDistance) {
        issues.push({
          code: 'fruit-bomb-spacing',
          message: `${bomb.id} and ${fruit.id} are too close in time and space`,
          objectIds: [bomb.id, fruit.id],
        });
      }
    }
  }
  return issues;
}

export function validateScript(
  script: ScriptDefinition,
  options: ScriptValidationOptions = {},
): ScriptValidationResult {
  const balance = options.balance ?? getBalance(script.difficulty);
  if (balance.difficulty !== script.difficulty) {
    throw new Error('balance difficulty must match script difficulty');
  }
  const issues: ScriptValidationIssue[] = [];
  const seenIds = new Set<string>();

  for (const object of script.objects) {
    if (seenIds.has(object.id)) {
      issues.push({ code: 'duplicate-id', message: `duplicate object id: ${object.id}` });
    }
    seenIds.add(object.id);

    if (
      !Number.isFinite(object.spawnAtMs) ||
      object.spawnAtMs < 0 ||
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
      issues.push({
        code: 'invalid-object',
        message: `${object.id} has coordinates or timing outside the script`,
        objectIds: [object.id],
      });
    }
    if (object.flightMs < balance.minFlightMs || object.flightMs > balance.maxFlightMs) {
      issues.push({
        code: 'flight-window',
        message: `${object.id} flight time is outside the difficulty window`,
        objectIds: [object.id],
      });
    }
  }

  const fingerprint = fingerprintScript(script.objects, script.durationMs);
  const expected = getExpectedObjectCounts(script.difficulty, script.durationMs);
  if (fingerprint.fruits !== expected.fruits) {
    issues.push({
      code: 'fruit-count',
      message: `expected ${expected.fruits} fruits, got ${fingerprint.fruits}`,
    });
  }
  if (fingerprint.bombs !== expected.bombs) {
    issues.push({
      code: 'bomb-count',
      message: `expected ${expected.bombs} bombs, got ${fingerprint.bombs}`,
    });
  }
  if (fingerprint.peakConcurrent > balance.maxConcurrent) {
    issues.push({
      code: 'peak-concurrent',
      message: `peak concurrency ${fingerprint.peakConcurrent} exceeds ${balance.maxConcurrent}`,
    });
  }
  const minimumReaction = SCRIPT_SAFETY_BY_DIFFICULTY[script.difficulty].minimumReactionMs;
  if (fingerprint.minimumReactionMs < minimumReaction) {
    issues.push({
      code: 'reaction-window',
      message: `minimum reaction ${fingerprint.minimumReactionMs}ms is below ${minimumReaction}ms`,
    });
  }
  issues.push(...fruitBombSpacingIssues(script.objects, script.difficulty));

  if (!fingerprintsEqual(script.fingerprint, fingerprint)) {
    issues.push({
      code: 'fingerprint-mismatch',
      message: 'stored fingerprint does not match script objects',
    });
  }

  const comparison = options.referenceFingerprint
    ? compareFingerprints(
        fingerprint,
        options.referenceFingerprint,
        options.comparabilityTolerance,
      )
    : undefined;
  if (comparison !== undefined && !comparison.comparable) {
    issues.push({
      code: 'not-comparable',
      message: comparison.reasons.join('; '),
    });
  }

  return comparison === undefined
    ? { valid: issues.length === 0, issues, fingerprint }
    : { valid: issues.length === 0, issues, fingerprint, comparison };
}
