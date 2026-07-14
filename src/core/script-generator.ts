import {
  SCRIPT_SAFETY_BY_DIFFICULTY,
  STANDARD_HALF_DURATION_MS,
  getBalance,
  getExpectedObjectCounts,
} from '../config/balance';
import type {
  CompetitionPhase,
  Difficulty,
  ScriptDefinition,
  ScriptFingerprint,
  ScriptObject,
} from '../types/game';
import { fingerprintScript, validateScript } from './script-validation';
import {
  DEFAULT_VIRTUAL_ONE_HAND_COHORT,
  simulateScriptForVirtualPlayer,
} from './script-pool-simulator';

export type ScriptPoolTier = 'qualifier' | 'final' | 'reserve';

export const SCRIPT_POOL_SIZES = {
  qualifier: 48,
  final: 8,
  reserve: 16,
} as const satisfies Record<ScriptPoolTier, number>;

const FRUIT_TYPES = [
  'apple',
  'orange',
  'watermelon',
  'kiwi',
  'dragonfruit',
] as const;

const MAX_GENERATION_ATTEMPTS = 256;

interface TemplatePoint {
  x: number;
  apexY: number;
}

interface ScriptTemplate {
  spawnTimes: number[];
  flightMs: number;
  points: TemplatePoint[];
  referenceFingerprint: ScriptFingerprint;
}

interface SimulatedCandidate {
  script: ScriptDefinition;
  meanScore: number;
  attempt: number;
}

export interface HiddenScriptPoolOptions {
  masterSeed: number | string;
  version?: string;
  durationsMs?: Partial<Record<ScriptPoolTier, number>>;
}

export interface GenerateScriptOptions extends HiddenScriptPoolOptions {
  difficulty: Difficulty;
  tier: ScriptPoolTier;
  index: number;
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function normalizeMasterSeed(seed: number | string): number {
  if (typeof seed === 'string') return hashString(seed);
  if (!Number.isFinite(seed)) throw new TypeError('masterSeed must be finite');
  return Math.trunc(seed) >>> 0;
}

function deriveSeed(masterSeed: number, label: string): number {
  return hashString(`${masterSeed}:${label}`);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const value = result[index];
    const swap = result[swapIndex];
    if (value === undefined || swap === undefined) continue;
    result[index] = swap;
    result[swapIndex] = value;
  }
  return result;
}

function phaseForTier(tier: ScriptPoolTier): Exclude<CompetitionPhase, 'practice'> {
  switch (tier) {
    case 'qualifier':
      return 'qualifier';
    case 'final':
      return 'final';
    case 'reserve':
      return 'tiebreak';
  }
}

function durationForTier(
  tier: ScriptPoolTier,
  durations?: Partial<Record<ScriptPoolTier, number>>,
): number {
  const duration = durations?.[tier] ?? STANDARD_HALF_DURATION_MS;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError(`${tier} duration must be a positive finite number`);
  }
  return Math.round(duration);
}

function makeTemplatePoints(total: number, seed: number): TemplatePoint[] {
  const random = mulberry32(seed);
  return Array.from({ length: total }, (_, index) => {
    const quadrant = index % 4;
    const left = quadrant === 0 || quadrant === 2;
    const upper = quadrant === 0 || quadrant === 1;
    return {
      x: left ? 0.18 + random() * 0.25 : 0.57 + random() * 0.25,
      apexY: upper ? 0.22 + random() * 0.2 : 0.52 + random() * 0.14,
    };
  });
}

function makeTemplate(
  masterSeed: number,
  difficulty: Difficulty,
  durationMs: number,
): ScriptTemplate {
  const balance = getBalance(difficulty);
  const counts = getExpectedObjectCounts(difficulty, durationMs);
  const total = counts.fruits + counts.bombs;
  const startAtMs = Math.min(400, Math.round(durationMs * 0.08));
  const desiredFlightMs = Math.round((balance.minFlightMs + balance.maxFlightMs) / 2);
  const availableMs = durationMs - startAtMs - desiredFlightMs - 100;
  const gapMs = total > 1 ? availableMs / (total - 1) : availableMs;
  const safety = SCRIPT_SAFETY_BY_DIFFICULTY[difficulty];
  if (availableMs <= 0 || (total > 1 && gapMs < safety.minimumReactionMs)) {
    throw new RangeError(
      `${durationMs}ms is too short for the ${difficulty} object count and reaction window`,
    );
  }

  const maximumFlightForConcurrency = Math.floor(gapMs * balance.maxConcurrent - 1);
  const flightMs = Math.min(desiredFlightMs, maximumFlightForConcurrency);
  if (flightMs < balance.minFlightMs) {
    throw new RangeError(`${difficulty} script cannot satisfy its concurrency limit`);
  }

  const endAtMs = durationMs - flightMs - 100;
  const spawnTimes = Array.from({ length: total }, (_, index) =>
    total === 1
      ? startAtMs
      : Math.round(startAtMs + ((endAtMs - startAtMs) * index) / (total - 1)),
  );
  const points = makeTemplatePoints(
    total,
    deriveSeed(masterSeed, `template:${difficulty}:${durationMs}`),
  );
  const referenceObjects: ScriptObject[] = spawnTimes.map((spawnAtMs, index) => {
    const point = points[index];
    if (point === undefined) throw new Error('template point missing');
    return {
      id: `reference-${index}`,
      kind: index < counts.bombs ? 'bomb' : 'fruit',
      spawnAtMs,
      x: point.x,
      apexY: point.apexY,
      radiusRatio: balance.radiusRatio,
      flightMs,
      ...(index < counts.bombs ? {} : { fruitType: FRUIT_TYPES[index % FRUIT_TYPES.length] }),
    };
  });

  return {
    spawnTimes,
    flightMs,
    points,
    referenceFingerprint: fingerprintScript(referenceObjects, durationMs),
  };
}

function chooseBombIndices(total: number, bombs: number, random: () => number): Set<number> {
  const chosen = new Set<number>();
  for (let bomb = 0; bomb < bombs; bomb += 1) {
    const binStart = Math.floor(((bomb + 0.35) * total) / bombs);
    const binEnd = Math.max(binStart, Math.ceil(((bomb + 0.9) * total) / bombs) - 1);
    let candidate = binStart + Math.floor(random() * (binEnd - binStart + 1));
    candidate = Math.max(1, Math.min(total - 2, candidate));
    while (chosen.has(candidate)) candidate = (candidate + 1) % total;
    chosen.add(candidate);
  }
  return chosen;
}

function cloneScript(script: ScriptDefinition): ScriptDefinition {
  return {
    ...script,
    objects: script.objects.map((object) => ({ ...object })),
    fingerprint: {
      ...script.fingerprint,
      quadrantCounts: [...script.fingerprint.quadrantCounts],
    },
  };
}

function virtualCohortMeanScore(script: ScriptDefinition): number {
  const total = DEFAULT_VIRTUAL_ONE_HAND_COHORT.reduce(
    (sum, player) => sum + simulateScriptForVirtualPlayer(script, player).breakdown.score,
    0,
  );
  return total / DEFAULT_VIRTUAL_ONE_HAND_COHORT.length;
}

function selectMedianCandidate(candidates: readonly SimulatedCandidate[]): ScriptDefinition {
  if (candidates.length === 0) throw new Error('no valid script candidate was generated');
  const scores = candidates.map(({ meanScore }) => meanScore).sort((left, right) => left - right);
  const median = scores[Math.floor(scores.length / 2)];
  if (median === undefined) throw new Error('script candidate median is unavailable');
  const selected = [...candidates].sort(
    (left, right) =>
      Math.abs(left.meanScore - median) - Math.abs(right.meanScore - median) ||
      left.attempt - right.attempt,
  )[0];
  if (!selected) throw new Error('script candidate selection failed');
  return selected.script;
}

function generateFromPool(
  pool: DeterministicScriptPool,
  difficulty: Difficulty,
  tier: ScriptPoolTier,
  index: number,
): ScriptDefinition {
  return pool.getScript(difficulty, tier, index);
}

export class DeterministicScriptPool {
  readonly version: string;
  private readonly masterSeed: number;
  private readonly durationsMs: Partial<Record<ScriptPoolTier, number>>;
  private readonly scriptCache = new Map<string, ScriptDefinition>();
  private readonly templateCache = new Map<string, ScriptTemplate>();

  constructor(options: HiddenScriptPoolOptions) {
    this.masterSeed = normalizeMasterSeed(options.masterSeed);
    this.version = options.version ?? 'balanced-v1';
    this.durationsMs = { ...options.durationsMs };
  }

  getPoolSize(tier: ScriptPoolTier): number {
    return SCRIPT_POOL_SIZES[tier];
  }

  getScript(difficulty: Difficulty, tier: ScriptPoolTier, index: number): ScriptDefinition {
    const poolSize = this.getPoolSize(tier);
    if (!Number.isInteger(index) || index < 0 || index >= poolSize) {
      throw new RangeError(`${tier} script index must be between 0 and ${poolSize - 1}`);
    }
    const cacheKey = `${difficulty}:${tier}:${index}`;
    const cached = this.scriptCache.get(cacheKey);
    if (cached !== undefined) return cloneScript(cached);

    const durationMs = durationForTier(tier, this.durationsMs);
    const templateKey = `${difficulty}:${durationMs}`;
    let template = this.templateCache.get(templateKey);
    if (template === undefined) {
      template = makeTemplate(this.masterSeed, difficulty, durationMs);
      this.templateCache.set(templateKey, template);
    }
    const balance = getBalance(difficulty);
    const counts = getExpectedObjectCounts(difficulty, durationMs);
    const scriptSeed = deriveSeed(this.masterSeed, `${this.version}:${cacheKey}`);
    const idHash = deriveSeed(scriptSeed, 'id').toString(16).padStart(8, '0');
    const scriptId = `${this.version}-${difficulty}-${tier}-${idHash}`;

    const candidates: SimulatedCandidate[] = [];
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const random = mulberry32(deriveSeed(scriptSeed, `attempt:${attempt}`));
      const points = shuffled(template.points, random);
      const bombIndices = chooseBombIndices(template.spawnTimes.length, counts.bombs, random);
      const objects: ScriptObject[] = template.spawnTimes.map((spawnAtMs, objectIndex) => {
        const point = points[objectIndex];
        if (point === undefined) throw new Error('shuffled template point missing');
        const isBomb = bombIndices.has(objectIndex);
        return {
          id: `${scriptId}-object-${objectIndex}`,
          kind: isBomb ? 'bomb' : 'fruit',
          spawnAtMs,
          x: point.x,
          apexY: point.apexY,
          radiusRatio: balance.radiusRatio,
          flightMs: template.flightMs,
          ...(isBomb
            ? {}
            : { fruitType: FRUIT_TYPES[Math.floor(random() * FRUIT_TYPES.length)] }),
        };
      });
      const script: ScriptDefinition = {
        id: scriptId,
        version: this.version,
        difficulty,
        phase: phaseForTier(tier),
        durationMs,
        seed: scriptSeed,
        objects,
        fingerprint: fingerprintScript(objects, durationMs),
      };
      const validation = validateScript(script, {
        referenceFingerprint: template.referenceFingerprint,
      });
      if (validation.valid) {
        candidates.push({
          script,
          meanScore: virtualCohortMeanScore(script),
          attempt,
        });
      }
    }

    if (candidates.length > 0) {
      // Candidate generation deliberately over-samples and discards simulated
      // difficulty outliers. Selecting the median keeps every published pool
      // centred before the full same-difficulty +/-2% audit is run.
      const selected = selectMedianCandidate(candidates);
      this.scriptCache.set(cacheKey, selected);
      return cloneScript(selected);
    }

    throw new Error(`unable to generate a valid ${difficulty}/${tier} script at index ${index}`);
  }

  nextUnconsumed(
    difficulty: Difficulty,
    tier: ScriptPoolTier,
    consumedIds: Iterable<string>,
  ): ScriptDefinition {
    const consumed = consumedIds instanceof Set ? consumedIds : new Set(consumedIds);
    for (let index = 0; index < this.getPoolSize(tier); index += 1) {
      const script = this.getScript(difficulty, tier, index);
      if (!consumed.has(script.id)) return script;
    }
    throw new Error(`${difficulty}/${tier} script pool is exhausted`);
  }
}

export function createHiddenScriptPool(
  options: HiddenScriptPoolOptions,
): DeterministicScriptPool {
  return new DeterministicScriptPool(options);
}

export function generateScript(options: GenerateScriptOptions): ScriptDefinition {
  return generateFromPool(
    new DeterministicScriptPool(options),
    options.difficulty,
    options.tier,
    options.index,
  );
}
