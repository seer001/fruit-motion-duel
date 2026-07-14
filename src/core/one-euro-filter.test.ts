import { describe, expect, it } from 'vitest';

import { OneEuroFilter, OneEuroPointFilter } from './one-euro-filter';

describe('OneEuroFilter', () => {
  it('preserves a constant input', () => {
    const filter = new OneEuroFilter();
    expect(filter.filter(0.25, 0)).toBe(0.25);
    expect(filter.filter(0.25, 16)).toBeCloseTo(0.25);
    expect(filter.filter(0.25, 32)).toBeCloseTo(0.25);
  });

  it('responds faster to motion with a positive beta', () => {
    const slow = new OneEuroFilter({ beta: 0, minCutoff: 0.5 });
    const responsive = new OneEuroFilter({ beta: 2, minCutoff: 0.5 });
    slow.filter(0, 0);
    responsive.filter(0, 0);

    expect(responsive.filter(1, 16)).toBeGreaterThan(slow.filter(1, 16));
  });

  it('ignores stale timestamps and can reset', () => {
    const filter = new OneEuroFilter();
    filter.filter(0, 100);
    const current = filter.filter(1, 116);
    expect(filter.filter(9, 100)).toBe(current);
    filter.reset(4, 200);
    expect(filter.filter(4, 216)).toBe(4);
  });

  it('filters points on both axes', () => {
    const filter = new OneEuroPointFilter();
    expect(filter.filter({ x: 0.2, y: 0.8 }, 0)).toEqual({ x: 0.2, y: 0.8 });
  });
});
