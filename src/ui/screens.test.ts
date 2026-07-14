import { describe, expect, it } from 'vitest';

import type { Participant, ScoreBreakdown } from '../types/game';
import {
  calibrationScreen,
  casualSetupScreen,
  homeScreen,
  soloPracticeResultScreen,
  soloPracticeSetupScreen,
} from './screens';

const PLAYER: Participant = {
  id: 'solo-1',
  displayName: '果影',
  activeHand: 'left',
  posture: 'seated',
  rankingEligible: false,
  createdAt: 1,
};

const SCORE: ScoreBreakdown = {
  score: 1_460,
  fruitHits: 15,
  fruitMisses: 5,
  bombsHit: 1,
  combo: 0,
  maxCombo: 9,
};

function videoDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: `${deviceId}-group`,
    kind: 'videoinput',
    label,
    toJSON: () => ({}),
  };
}

describe('single-player practice screens', () => {
  it('renders a dedicated home entry and all setup controls', () => {
    const home = homeScreen({
      cameraReady: false,
      modelReady: true,
      demoMode: true,
      savedEvent: null,
      devices: [],
    });
    expect(home).toContain('id="choose-solo-practice"');
    expect(home).toContain('單人練習');

    const setup = soloPracticeSetupScreen({
      playerName: PLAYER.displayName,
      activeHand: PLAYER.activeHand,
      posture: PLAYER.posture,
      difficulty: 'normal',
      durationMs: 45_000,
    });
    expect(setup).toContain('id="solo-practice-form"');
    expect(setup).toContain('value="left" checked');
    expect(setup).toContain('value="seated" checked');
    expect(setup).toContain('value="normal" checked');
    expect(setup).toContain('value="45000" checked');
  });

  it('recommends an iPhone Continuity Camera and explains the LiDAR boundary', () => {
    const home = homeScreen({
      cameraReady: true,
      modelReady: true,
      demoMode: false,
      cameraLabel: 'FaceTime HD Camera',
      activeDeviceId: 'mac',
      savedEvent: null,
      devices: [
        videoDevice('mac', 'FaceTime HD Camera'),
        videoDevice('phone', 'iPhone 16 Pro Camera'),
      ],
    });

    expect(home.indexOf('<option value="phone"')).toBeLessThan(
      home.indexOf('<option value="mac"'),
    );
    expect(home).toContain('value="mac" selected');
    expect(home).toContain('iPhone 接續互通');
    expect(home).toContain('id="refresh-cameras"');
    expect(home).toContain('無法讀取 LiDAR 深度圖');
  });

  it('renders a one-player calibration layout without a center divider', () => {
    const markup = calibrationScreen(
      [{ participant: PLAYER, lane: 'left', progress: 0.5 }],
      { halfLabel: '單人練習', demoMode: false },
    );
    expect(markup).toContain('站在鏡頭中央');
    expect(markup).toContain('calibration-layout is-single');
    expect(markup).not.toContain('class="safe-divider"');
  });

  it('calculates accuracy and renders practice-only results', () => {
    const markup = soloPracticeResultScreen(PLAYER, SCORE, 45_000, 'normal');
    expect(markup).toContain('1,460');
    expect(markup).toContain('75%');
    expect(markup).toContain('最長連擊');
    expect(markup).toContain('同設定再練一次');
    expect(markup).toContain('不計入正式賽排名');
  });
});

describe('casual duel screens', () => {
  it('configures one active hand per player instead of advertising dual wrists', () => {
    const home = homeScreen({
      cameraReady: false,
      modelReady: true,
      demoMode: true,
      savedEvent: null,
      devices: [],
    });
    const setup = casualSetupScreen();

    expect(home).toContain('每人單一指定主手');
    expect(setup).toContain('name="leftHand"');
    expect(setup).toContain('name="rightHand"');
    expect(setup).toContain('雙人合計固定兩點');
    expect(setup).not.toContain('雙腕皆可切');
  });
});
