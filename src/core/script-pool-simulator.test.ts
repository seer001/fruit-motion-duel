import { describe, expect, it } from 'vitest';

import type { ScriptDefinition } from '../types/game';
import { generateScript } from './script-generator';
import {
  DEFAULT_VIRTUAL_ONE_HAND_COHORT,
  SCRIPT_POOL_SIMULATOR_ASSUMPTIONS,
  simulateScriptForVirtualPlayer,
  simulateScriptPool,
  type VirtualOneHandPlayer,
} from './script-pool-simulator';

function cloneScript(
  source: ScriptDefinition,
  id: string,
  mutateObject?: (object: ScriptDefinition['objects'][number], index: number) => void,
): ScriptDefinition {
  const objects = source.objects.map((object, index) => {
    const cloned = { ...object };
    mutateObject?.(cloned, index);
    return cloned;
  });
  return {
    ...source,
    id,
    objects,
    fingerprint: {
      ...source.fingerprint,
      quadrantCounts: [...source.fingerprint.quadrantCounts],
    },
  };
}

describe('deterministic script-pool simulator', () => {
  it('uses a frozen fixed cohort and publishes the field-test limitation', () => {
    expect(DEFAULT_VIRTUAL_ONE_HAND_COHORT).toHaveLength(6);
    expect(Object.isFrozen(DEFAULT_VIRTUAL_ONE_HAND_COHORT)).toBe(true);
    expect(DEFAULT_VIRTUAL_ONE_HAND_COHORT.every((player) => Object.isFrozen(player))).toBe(true);
    expect(SCRIPT_POOL_SIMULATOR_ASSUMPTIONS.join(' ')).toContain('24-player');
  });

  it('is deterministic and ignores cosmetic script/object ids', () => {
    const first = generateScript({
      masterSeed: 'sim-repeatability',
      difficulty: 'normal',
      tier: 'qualifier',
      index: 0,
    });
    const cosmeticClone = cloneScript(first, 'same-structure-new-id', (object, index) => {
      object.id = `renamed-${index}`;
    });
    const inputSnapshot = JSON.stringify([first, cosmeticClone]);

    const report = simulateScriptPool([first, cosmeticClone]);
    const repeated = simulateScriptPool([first, cosmeticClone]);

    expect(repeated).toEqual(report);
    expect(report.passed).toBe(true);
    expect(report.outlierScriptIds).toEqual([]);
    expect(report.scripts[0]?.meanScore).toBe(report.scripts[1]?.meanScore);
    expect(report.scripts[0]?.playerResults).toEqual(report.scripts[1]?.playerResults);
    expect(JSON.stringify([first, cosmeticClone])).toBe(inputSnapshot);
  });

  it('records a complete score breakdown for every fruit with one active wrist', () => {
    const script = generateScript({
      masterSeed: 'one-player-breakdown',
      difficulty: 'hard',
      tier: 'qualifier',
      index: 2,
    });
    const fruitCount = script.objects.filter((object) => object.kind === 'fruit').length;
    const result = simulateScriptForVirtualPlayer(script, DEFAULT_VIRTUAL_ONE_HAND_COHORT[2]!);

    expect(result.playerId).toBe('casual-balanced');
    expect(result.breakdown.fruitHits + result.breakdown.fruitMisses).toBe(fruitCount);
    expect(result.breakdown.bombsHit).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.score).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.maxCombo).toBeGreaterThanOrEqual(result.breakdown.combo);
  });

  it('flags a materially harder script outside its same-difficulty pool mean +/-2%', () => {
    const base = generateScript({
      masterSeed: 'outlier-audit',
      difficulty: 'normal',
      tier: 'qualifier',
      index: 3,
    });
    // A large reference group keeps one severe outlier from moving the pool mean
    // enough to make the known-good scripts fail the symmetric 2% rule as well.
    const referenceScripts = Array.from({ length: 80 }, (_, index) =>
      cloneScript(base, `reference-${index}`),
    );
    const outlier = cloneScript(base, 'deliberately-unreachable', (object, index) => {
      if (object.kind !== 'fruit') return;
      object.x = index % 2 === 0 ? 0 : 1;
      object.apexY = index % 3 === 0 ? 0 : 0.76;
      object.radiusRatio = 0.001;
      object.flightMs = 1;
    });

    const report = simulateScriptPool([...referenceScripts, outlier]);
    const outlierResult = report.scripts.find((result) => result.scriptId === outlier.id)!;

    expect(report.passed).toBe(false);
    expect(report.outlierScriptIds).toContain(outlier.id);
    expect(outlierResult.withinTolerance).toBe(false);
    expect(outlierResult.meanScore).toBeLessThan(outlierResult.lowerAllowedScore);
    expect(report.scripts.find((result) => result.scriptId === 'reference-0')?.withinTolerance).toBe(
      true,
    );
  });

  it('computes independent means for each difficulty represented in one audit', () => {
    const easy = generateScript({
      masterSeed: 'mixed-difficulty',
      difficulty: 'easy',
      tier: 'qualifier',
      index: 0,
    });
    const hard = generateScript({
      masterSeed: 'mixed-difficulty',
      difficulty: 'hard',
      tier: 'qualifier',
      index: 0,
    });
    const report = simulateScriptPool([
      easy,
      cloneScript(easy, 'easy-copy'),
      hard,
      cloneScript(hard, 'hard-copy'),
    ]);

    const easyScores = report.scripts
      .filter((result) => result.difficulty === 'easy')
      .map((result) => result.meanScore);
    const hardScores = report.scripts
      .filter((result) => result.difficulty === 'hard')
      .map((result) => result.meanScore);
    expect(report.difficultyMeans.easy).toBe(
      easyScores.reduce((sum, score) => sum + score, 0) / easyScores.length,
    );
    expect(report.difficultyMeans.hard).toBe(
      hardScores.reduce((sum, score) => sum + score, 0) / hardScores.length,
    );
    expect(report.passed).toBe(true);
  });

  it('release-audits all 48/8/16 generated pools at the locked 2% gate', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      for (const { tier, size, durationMs } of [
        { tier: 'qualifier', size: 48, durationMs: 25_000 },
        { tier: 'final', size: 8, durationMs: 30_000 },
        { tier: 'reserve', size: 16, durationMs: 10_000 },
      ] as const) {
        const scripts = Array.from({ length: size }, (_, index) =>
          generateScript({
            masterSeed: `release-pool-${difficulty}`,
            difficulty,
            tier,
            index,
            durationsMs: { [tier]: durationMs },
          }),
        );
        const report = simulateScriptPool(scripts);
        expect(report.outlierScriptIds, `${difficulty}/${tier} outliers`).toEqual([]);
        expect(report.passed).toBe(true);
      }
    }
  });

  it('rejects misleading pool shapes and malformed cohorts', () => {
    const script = generateScript({
      masterSeed: 'invalid-simulator-input',
      difficulty: 'easy',
      tier: 'qualifier',
      index: 0,
    });
    const differentDuration = cloneScript(script, 'different-duration');
    differentDuration.durationMs += 1_000;

    expect(() => simulateScriptPool([])).toThrow(/scripts must not be empty/);
    expect(() => simulateScriptPool([script], { scoreTolerance: 1 })).toThrow(
      /scoreTolerance/,
    );
    expect(() => simulateScriptPool([script, differentDuration])).toThrow(
      /share phase and duration/,
    );
    expect(() => simulateScriptPool([script, cloneScript(script, script.id)])).toThrow(
      /duplicate script id/,
    );

    const malformedPlayer: VirtualOneHandPlayer = {
      ...DEFAULT_VIRTUAL_ONE_HAND_COHORT[0]!,
      fruitPrecision: 1.1,
    };
    expect(() => simulateScriptPool([script], { cohort: [malformedPlayer] })).toThrow(
      /fruitPrecision/,
    );
    expect(() =>
      simulateScriptPool([script], {
        cohort: [
          DEFAULT_VIRTUAL_ONE_HAND_COHORT[0]!,
          { ...DEFAULT_VIRTUAL_ONE_HAND_COHORT[0]! },
        ],
      }),
    ).toThrow(/duplicate cohort player id/);
  });
});
