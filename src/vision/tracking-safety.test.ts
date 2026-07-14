import { describe, expect, it } from 'vitest';

import { assessTrackingSafety, hasVisionHeartbeatExpired } from './tracking-safety';

describe('assessTrackingSafety', () => {
  it('ignores spectators without pausing enrolled players', () => {
    expect(assessTrackingSafety([], 2, 1_400)).toEqual({
      ignoredSpectators: 2,
      knifeDisabledParticipantIds: [],
      pauseParticipantIds: [],
      mustPause: false,
    });
  });

  it('stops a missing knife during short overlap without pausing the clock', () => {
    const result = assessTrackingSafety(
      [{ participantId: 'left', unavailableForMs: 850 }],
      1,
      1_400,
    );
    expect(result.knifeDisabledParticipantIds).toEqual(['left']);
    expect(result.mustPause).toBe(false);
    expect(result.ignoredSpectators).toBe(1);
  });

  it('pauses only after an enrolled player remains lost past the grace window', () => {
    const result = assessTrackingSafety(
      [
        { participantId: 'left', unavailableForMs: 1_401 },
        { participantId: 'right', unavailableForMs: 300 },
      ],
      3,
      1_400,
    );
    expect(result.pauseParticipantIds).toEqual(['left']);
    expect(result.mustPause).toBe(true);
  });
});

describe('hasVisionHeartbeatExpired', () => {
  it('pauses only after the no-result grace window', () => {
    expect(hasVisionHeartbeatExpired(1_000, 2_399, 1_400)).toBe(false);
    expect(hasVisionHeartbeatExpired(1_000, 2_400, 1_400)).toBe(true);
  });
});
