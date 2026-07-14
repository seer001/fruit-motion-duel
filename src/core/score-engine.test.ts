import { describe, expect, it } from 'vitest';

import { BOMB_PENALTY, ScoreEngine, comboBonus } from './score-engine';

describe('ScoreEngine', () => {
  it('uses the integer combo tiers', () => {
    expect([1, 4, 5, 9, 10, 19, 20].map(comboBonus)).toEqual([
      0, 0, 20, 20, 40, 40, 60,
    ]);

    const engine = new ScoreEngine();
    for (let combo = 1; combo <= 20; combo += 1) {
      engine.apply({ id: `fruit-${combo}`, type: 'fruit-hit' });
    }
    expect(engine.snapshot()).toMatchObject({
      score: 2_560,
      fruitHits: 20,
      combo: 20,
      maxCombo: 20,
    });
  });

  it('resets combo on a miss without deducting score', () => {
    const engine = new ScoreEngine();
    engine.apply({ id: 'hit', type: 'fruit-hit' });
    const result = engine.apply({ id: 'miss', type: 'fruit-miss' });

    expect(result.delta).toBe(0);
    expect(result.breakdown).toMatchObject({
      score: 100,
      fruitHits: 1,
      fruitMisses: 1,
      combo: 0,
      maxCombo: 1,
    });
  });

  it('deducts bombs, resets combo, and never goes below zero', () => {
    const engine = new ScoreEngine();
    const atZero = engine.apply({ id: 'bomb-1', type: 'bomb-hit' });
    expect(atZero.breakdown.score).toBe(0);

    engine.apply({ id: 'fruit', type: 'fruit-hit' });
    const bomb = engine.apply({ id: 'bomb-2', type: 'bomb-hit' });
    expect(bomb.delta).toBe(-100);
    expect(bomb.breakdown).toMatchObject({
      score: 0,
      bombsHit: 2,
      combo: 0,
    });
    expect(BOMB_PENALTY).toBe(200);
  });

  it('is idempotent by event id', () => {
    const engine = new ScoreEngine();
    const event = { id: 'same-fruit', type: 'fruit-hit' } as const;

    expect(engine.apply(event).applied).toBe(true);
    expect(engine.apply(event)).toMatchObject({ applied: false, delta: 0 });
    expect(engine.snapshot()).toMatchObject({ score: 100, fruitHits: 1 });
  });
});
