import { describe, expect, it } from 'vitest';

import { getExpectedObjectCounts } from '../config/balance';
import type { Difficulty } from '../types/game';
import {
  SCRIPT_POOL_SIZES,
  createHiddenScriptPool,
  generateScript,
} from './script-generator';
import { compareFingerprints, validateScript } from './script-validation';

describe('deterministic hidden script pool', () => {
  it('publishes the required pool capacities', () => {
    expect(SCRIPT_POOL_SIZES).toEqual({ qualifier: 48, final: 8, reserve: 16 });
  });

  it.each(['easy', 'normal', 'hard'] satisfies Difficulty[])(
    'generates valid deterministic %s scripts with the initial counts',
    (difficulty) => {
      const first = generateScript({
        masterSeed: 'event-secret',
        difficulty,
        tier: 'qualifier',
        index: 0,
      });
      const repeated = generateScript({
        masterSeed: 'event-secret',
        difficulty,
        tier: 'qualifier',
        index: 0,
      });
      const counts = getExpectedObjectCounts(difficulty);

      expect(repeated).toEqual(first);
      expect(first.objects.filter((object) => object.kind === 'fruit')).toHaveLength(counts.fruits);
      expect(first.objects.filter((object) => object.kind === 'bomb')).toHaveLength(counts.bombs);
      expect(validateScript(first).valid).toBe(true);
    },
  );

  it('does not repeat ids and keeps a pool within the 2% equivalence envelope', () => {
    const pool = createHiddenScriptPool({ masterSeed: 42 });
    const scripts = Array.from({ length: SCRIPT_POOL_SIZES.final }, (_, index) =>
      pool.getScript('hard', 'final', index),
    );
    expect(new Set(scripts.map((script) => script.id)).size).toBe(scripts.length);
    const reference = scripts[0]?.fingerprint;
    expect(reference).toBeDefined();
    for (const script of scripts.slice(1)) {
      expect(compareFingerprints(script.fingerprint, reference!).comparable).toBe(true);
    }
  });

  it('returns defensive copies and skips consumed scripts', () => {
    const pool = createHiddenScriptPool({ masterSeed: 7 });
    const first = pool.getScript('normal', 'qualifier', 0);
    const originalX = first.objects[0]?.x;
    if (first.objects[0] !== undefined) first.objects[0].x = 99;
    expect(pool.getScript('normal', 'qualifier', 0).objects[0]?.x).toBe(originalX);

    const next = pool.nextUnconsumed('normal', 'qualifier', [first.id]);
    expect(next.id).not.toBe(first.id);
  });

  it('can lazily materialize every reserved slot without violating validation', () => {
    const pool = createHiddenScriptPool({ masterSeed: 'full-pool-audit' });
    const ids = new Set<string>();
    for (const difficulty of ['easy', 'normal', 'hard'] satisfies Difficulty[]) {
      for (const tier of ['qualifier', 'final', 'reserve'] as const) {
        for (let index = 0; index < SCRIPT_POOL_SIZES[tier]; index += 1) {
          const script = pool.getScript(difficulty, tier, index);
          expect(validateScript(script).valid).toBe(true);
          ids.add(script.id);
        }
      }
    }
    expect(ids.size).toBe(
      3 *
        (SCRIPT_POOL_SIZES.qualifier +
          SCRIPT_POOL_SIZES.final +
          SCRIPT_POOL_SIZES.reserve),
    );
  });
});
