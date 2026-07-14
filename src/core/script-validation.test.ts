import { describe, expect, it } from 'vitest';

import type { ScriptDefinition, ScriptFingerprint, ScriptObject } from '../types/game';
import {
  compareFingerprints,
  fingerprintScript,
  validateScript,
} from './script-validation';

describe('script fingerprint and validator', () => {
  const objects: ScriptObject[] = [
    {
      id: 'fruit',
      kind: 'fruit',
      spawnAtMs: 500,
      x: 0.2,
      apexY: 0.3,
      radiusRatio: 0.075,
      flightMs: 2_100,
      fruitType: 'apple',
    },
    {
      id: 'bomb',
      kind: 'bomb',
      spawnAtMs: 1_600,
      x: 0.8,
      apexY: 0.6,
      radiusRatio: 0.075,
      flightMs: 2_100,
    },
  ];

  it('calculates counts, quadrants, concurrency, reaction and travel', () => {
    expect(fingerprintScript(objects, 5_000)).toMatchObject({
      fruits: 1,
      bombs: 1,
      quadrantCounts: [1, 0, 0, 1],
      peakConcurrent: 2,
      minimumReactionMs: 1_100,
    });
  });

  it('uses a two-percent bound for continuous comparison metrics', () => {
    const reference: ScriptFingerprint = {
      fruits: 20,
      bombs: 1,
      totalTravel: 30,
      quadrantCounts: [6, 5, 5, 5],
      peakConcurrent: 2,
      minimumReactionMs: 1_000,
    };
    const within = { ...reference, totalTravel: 30.6, minimumReactionMs: 980 };
    const outside = { ...reference, totalTravel: 30.61 };
    expect(compareFingerprints(within, reference).comparable).toBe(true);
    expect(compareFingerprints(outside, reference).comparable).toBe(false);
  });

  it('reports unsafe fruit/bomb proximity and a stale fingerprint', () => {
    const crowded = objects.map((object, index) => ({
      ...object,
      id: `${object.id}-${index}`,
      spawnAtMs: index === 0 ? 500 : 1_000,
      x: 0.2,
      apexY: 0.3,
    }));
    const script: ScriptDefinition = {
      id: 'invalid',
      version: 'test',
      difficulty: 'easy',
      phase: 'qualifier',
      durationMs: 25_000,
      seed: 1,
      objects: crowded,
      fingerprint: fingerprintScript(objects, 25_000),
    };
    const codes = validateScript(script).issues.map((issue) => issue.code);
    expect(codes).toContain('fruit-bomb-spacing');
    expect(codes).toContain('fingerprint-mismatch');
    expect(codes).toContain('fruit-count');
  });
});
