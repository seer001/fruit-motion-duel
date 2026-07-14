import { describe, expect, it } from 'vitest';

import type { Difficulty, PlayerPosture } from '../types/game';
import {
  DEFAULT_BALANCE_RELEASE_THRESHOLDS,
  evaluateBalanceReleaseGate,
  type BalanceValidationSample,
} from './balance-release-gate';

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const POSTURES: readonly PlayerPosture[] = ['standing', 'seated'];

function crossoverSamples(participantCount = 24): BalanceValidationSample[] {
  return DIFFICULTIES.flatMap((difficulty) =>
    Array.from({ length: participantCount }, (_, index) =>
      POSTURES.map((posture): BalanceValidationSample => ({
        participantId: `player-${index + 1}`,
        difficulty,
        posture,
        score: posture === 'standing' ? 1_000 : 950,
        hitRate: posture === 'standing' ? 0.8 : 0.83,
        bombMistouchRate: posture === 'standing' ? 0.01 : 0.02,
        validTrackingRate: 0.985,
      })),
    ).flat(),
  );
}

describe('balance release gate', () => {
  it('passes all difficulties at the inclusive 24-player field-test boundaries', () => {
    const report = evaluateBalanceReleaseGate(crossoverSamples());

    expect(report.thresholds).toEqual(DEFAULT_BALANCE_RELEASE_THRESHOLDS);
    expect(report.passed).toBe(true);
    expect(report.eligibleDifficulties).toEqual(['easy', 'normal', 'hard']);
    for (const difficulty of DIFFICULTIES) {
      const result = report.difficulties[difficulty];
      expect(result).toMatchObject({
        pairedParticipantCount: 24,
        scoreRatio: 0.95,
        passed: true,
        failures: [],
      });
      expect(result.hitRateGap).toBeCloseTo(0.03);
      expect(result.bombMistouchRateGap).toBeCloseTo(0.01);
      expect(result.validTrackingRateMeans.standing).toBeCloseTo(0.985);
      expect(result.validTrackingRateMeans.seated).toBeCloseTo(0.985);
    }
  });

  it('fails only the affected difficulty and reports every breached threshold', () => {
    const samples = crossoverSamples().map((sample) => {
      if (sample.difficulty !== 'hard') return sample;
      return {
        ...sample,
        score: sample.posture === 'seated' ? 1_060 : 1_000,
        hitRate: sample.posture === 'seated' ? 0.84 : 0.8,
        bombMistouchRate: sample.posture === 'seated' ? 0.021 : 0.01,
        validTrackingRate: 0.984,
      };
    });

    const report = evaluateBalanceReleaseGate(samples);

    expect(report.passed).toBe(false);
    expect(report.eligibleDifficulties).toEqual(['easy', 'normal']);
    expect(report.difficulties.hard.failures).toEqual([
      'score-ratio-out-of-range',
      'hit-rate-gap-too-large',
      'bomb-mistouch-rate-gap-too-large',
      'standing-valid-tracking-rate-too-low',
      'seated-valid-tracking-rate-too-low',
    ]);
  });

  it('counts only participants with both postures at the same difficulty', () => {
    const samples = crossoverSamples().filter(
      (sample) =>
        !(sample.difficulty === 'normal' && sample.participantId === 'player-24' && sample.posture === 'seated'),
    );
    samples.push({
      participantId: 'standing-only-extra',
      difficulty: 'normal',
      posture: 'standing',
      score: 1_000,
      hitRate: 0.8,
      bombMistouchRate: 0.01,
      validTrackingRate: 0.99,
    });

    const result = evaluateBalanceReleaseGate(samples).difficulties.normal;

    expect(result.pairedParticipantCount).toBe(23);
    expect(result.pairedParticipantIds).not.toContain('player-24');
    expect(result.pairedParticipantIds).not.toContain('standing-only-extra');
    expect(result.failures).toContain('insufficient-paired-participants');
    expect(result.passed).toBe(false);
  });

  it('averages repeated sessions per participant before comparing posture groups', () => {
    const samples: BalanceValidationSample[] = DIFFICULTIES.flatMap((difficulty) => [
      {
        participantId: 'frequent-player',
        difficulty,
        posture: 'standing',
        score: 0,
        hitRate: 0.7,
        bombMistouchRate: 0.02,
        validTrackingRate: 0.99,
      },
      {
        participantId: 'frequent-player',
        difficulty,
        posture: 'standing',
        score: 200,
        hitRate: 0.9,
        bombMistouchRate: 0,
        validTrackingRate: 0.99,
      },
      {
        participantId: 'frequent-player',
        difficulty,
        posture: 'seated',
        score: 100,
        hitRate: 0.8,
        bombMistouchRate: 0.01,
        validTrackingRate: 0.99,
      },
    ]);

    const report = evaluateBalanceReleaseGate(samples, {
      ...DEFAULT_BALANCE_RELEASE_THRESHOLDS,
      minimumPairedParticipants: 1,
    });

    expect(report.passed).toBe(true);
    expect(report.difficulties.easy.scoreMeans).toEqual({ standing: 100, seated: 100 });
    expect(report.difficulties.easy.scoreRatio).toBe(1);
  });

  it('rejects malformed rates instead of silently producing a release decision', () => {
    const sample = crossoverSamples().at(0)!;
    expect(() =>
      evaluateBalanceReleaseGate([{ ...sample, validTrackingRate: 1.01 }]),
    ).toThrow(/validTrackingRate/);
    expect(() =>
      evaluateBalanceReleaseGate([{ ...sample, participantId: '  ' }]),
    ).toThrow(/participantId/);
  });
});
