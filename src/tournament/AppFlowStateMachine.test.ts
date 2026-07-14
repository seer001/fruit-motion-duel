import { describe, expect, it } from 'vitest';

import { AppFlowStateMachine, IllegalHostActionError } from './AppFlowStateMachine';

describe('AppFlowStateMachine', () => {
  it('guards host actions through qualifiers, lane swap, final and champion', () => {
    const flow = new AppFlowStateMachine(2);

    expect(flow.allowedActions()).toEqual(['approve-device']);
    expect(() => flow.send('start-half')).toThrow(IllegalHostActionError);
    flow.send('approve-device');
    flow.send('lock-roster');

    completeHeat(flow, true);
    expect(flow.snapshot()).toMatchObject({
      state: 'leaderboard',
      completedQualifierHeats: 1,
    });
    expect(flow.can('start-final')).toBe(false);
    flow.send('next-qualifier');

    completeHeat(flow, false);
    expect(flow.can('next-qualifier')).toBe(false);
    expect(flow.can('start-final')).toBe(true);
    flow.send('start-final');
    expect(flow.snapshot()).toMatchObject({ state: 'final', competitionPhase: 'final' });
    flow.send('prepare-final');
    completeHeat(flow, false);
    expect(flow.snapshot().state).toBe('champion');
    expect(flow.allowedActions()).toEqual([]);
  });

  it('returns a technical void to calibration without replaying practice', () => {
    const flow = new AppFlowStateMachine(1);
    flow.send('approve-device');
    flow.send('lock-roster');
    flow.send('approve-calibration');
    flow.send('start-countdown');
    flow.send('start-half');
    flow.send('finish-half');
    flow.send('void-half');

    expect(flow.snapshot()).toMatchObject({
      state: 'calibration',
      halfIndex: 0,
      practiceRequired: false,
    });
    expect(flow.send('approve-calibration').state).toBe('countdown');
  });
});

function completeHeat(flow: AppFlowStateMachine, exercisePause: boolean): void {
  flow.send('approve-calibration');
  flow.send('start-countdown');
  flow.send('start-half');

  if (exercisePause) {
    flow.send('pause-half');
    expect(flow.snapshot().paused).toBe(true);
    expect(() => flow.send('finish-half')).toThrow(IllegalHostActionError);
    flow.send('resume-half');
  }

  flow.send('finish-half');
  expect(flow.snapshot().state).toBe('swap');
  flow.send('confirm-half');
  expect(flow.can('void-half')).toBe(false);
  flow.send('confirm-swap');
  expect(flow.snapshot()).toMatchObject({ state: 'calibration', halfIndex: 1 });
  flow.send('approve-calibration');
  flow.send('start-half');
  flow.send('finish-half');
  expect(flow.snapshot().state).toBe('review');
  flow.send('confirm-half');
}
