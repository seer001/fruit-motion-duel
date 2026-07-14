import { describe, expect, it, vi } from 'vitest';

const phaserHarness = vi.hoisted(() => {
  class FakeEventEmitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    off(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
      return true;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }
  }

  interface FakeLoop {
    started: boolean;
    running: boolean;
    targetFps: number;
    fpsLimit: number;
    hasFpsLimit: boolean;
    _limitRate: number;
    _target: number;
    sleep: ReturnType<typeof vi.fn>;
    wake: ReturnType<typeof vi.fn>;
  }

  interface FakeGameInstance {
    loop: FakeLoop;
    destroy: ReturnType<typeof vi.fn>;
    config: unknown;
  }

  return {
    FakeEventEmitter,
    games: [] as FakeGameInstance[],
  };
});

vi.mock('phaser', () => ({
  default: {
    Scene: class {},
    Events: { EventEmitter: phaserHarness.FakeEventEmitter },
    Scale: { FIT: 'fit', CENTER_BOTH: 'center-both' },
    WEBGL: 'webgl',
    Game: class {
      readonly loop = {
        started: true,
        running: true,
        targetFps: 60,
        fpsLimit: 60,
        hasFpsLimit: true,
        _limitRate: 1_000 / 60,
        _target: 1_000 / 60,
        sleep: vi.fn(() => { this.loop.running = false; }),
        wake: vi.fn(() => { this.loop.running = true; }),
      };
      readonly destroy = vi.fn();

      constructor(readonly config: { scene: Array<{ bus: { emit(event: string): void } }> }) {
        phaserHarness.games.push(this);
        config.scene[0]?.bus.emit('scene-ready');
      }
    },
  },
}));

import type { AudioManager } from '../audio/AudioManager';
import {
  DEFAULT_FRUIT_DUEL_RENDER_SETTINGS,
  FRUIT_DUEL_EFFECT_PROFILES,
  FruitDuelGame,
  createFruitDuelRendererConfig,
  getFruitDuelEffectProfile,
  type FruitDuelRenderSettings,
} from './FruitDuelGame';

describe('fruit duel renderer configuration', () => {
  it.each([30, 45, 60] as const)('applies and enforces a %i FPS render limit', (targetFps) => {
    const config = createFruitDuelRendererConfig({
      ...DEFAULT_FRUIT_DUEL_RENDER_SETTINGS,
      targetFps,
    });

    expect(config.fps).toEqual({ target: targetFps, limit: targetFps, smoothStep: true });
  });

  it('keeps antialias and transparency as initialization-level values', () => {
    const opaque: FruitDuelRenderSettings = {
      targetFps: 30,
      antialias: false,
      transparent: false,
      effectsQuality: 'off',
    };
    const transparent: FruitDuelRenderSettings = {
      ...opaque,
      antialias: true,
      transparent: true,
    };

    expect(createFruitDuelRendererConfig(opaque)).toMatchObject({
      antialias: false,
      transparent: false,
      backgroundColor: '#07111f',
    });
    expect(createFruitDuelRendererConfig(transparent)).toMatchObject({
      antialias: true,
      transparent: true,
      backgroundColor: 'rgba(0,0,0,0)',
    });
  });
});

describe('fruit duel effects profiles', () => {
  it('uses the existing full effect values for high quality', () => {
    expect(getFruitDuelEffectProfile('high')).toMatchObject({
      sliceParticleCount: 10,
      cameraShakeDurationMs: 250,
      cameraShakeIntensity: 0.009,
      showSlicePopup: true,
      showMultiSliceBadge: true,
      trailStyle: 'full',
    });
  });

  it('turns off optional effects while retaining a simple blade trail', () => {
    expect(getFruitDuelEffectProfile('off')).toEqual({
      sliceParticleCount: 0,
      cameraShakeDurationMs: 0,
      cameraShakeIntensity: 0,
      showSlicePopup: false,
      showMultiSliceBadge: false,
      trailStyle: 'simple',
    });
  });

  it('uses bounded low and medium particle budgets from one immutable profile table', () => {
    expect(FRUIT_DUEL_EFFECT_PROFILES.low.sliceParticleCount).toBe(4);
    expect(FRUIT_DUEL_EFFECT_PROFILES.medium.sliceParticleCount).toBe(7);
    expect(Object.isFrozen(FRUIT_DUEL_EFFECT_PROFILES)).toBe(true);
    expect(Object.values(FRUIT_DUEL_EFFECT_PROFILES).every(Object.isFrozen)).toBe(true);
  });
});

describe('fruit duel renderer lifecycle', () => {
  it('makes sleep, wake, and destroy idempotent around one Phaser instance', async () => {
    const duel = new FruitDuelGame(
      {} as HTMLElement,
      {} as AudioManager,
      DEFAULT_FRUIT_DUEL_RENDER_SETTINGS,
    );
    await duel.ready;
    const phaser = phaserHarness.games.at(-1)!;

    duel.sleep();
    duel.sleep();
    expect(phaser.loop.sleep).toHaveBeenCalledTimes(1);
    expect(phaser.loop.running).toBe(false);

    duel.wake();
    duel.wake();
    expect(phaser.loop.wake).toHaveBeenCalledTimes(1);
    expect(phaser.loop.running).toBe(true);

    duel.destroy();
    duel.destroy();
    expect(phaser.destroy).toHaveBeenCalledTimes(1);
  });

  it('wakes a sleeping loop once so Phaser can consume deferred destruction', async () => {
    const duel = new FruitDuelGame(
      {} as HTMLElement,
      {} as AudioManager,
      DEFAULT_FRUIT_DUEL_RENDER_SETTINGS,
    );
    await duel.ready;
    const phaser = phaserHarness.games.at(-1)!;

    duel.sleep();
    duel.destroy();

    expect(phaser.destroy).toHaveBeenCalledTimes(1);
    expect(phaser.loop.wake).toHaveBeenCalledTimes(1);
  });

  it('changes the live FPS limiter and effects without rebuilding Phaser', async () => {
    const gameCount = phaserHarness.games.length;
    const duel = new FruitDuelGame(
      {} as HTMLElement,
      {} as AudioManager,
      DEFAULT_FRUIT_DUEL_RENDER_SETTINGS,
    );
    await duel.ready;
    const phaser = phaserHarness.games.at(-1)!;

    duel.setTargetFps(30);
    duel.setEffectsQuality('low');
    duel.setTargetFps(30);
    duel.setEffectsQuality('low');

    expect(phaser.loop.targetFps).toBe(30);
    expect(phaser.loop.fpsLimit).toBe(30);
    expect(phaser.loop._limitRate).toBeCloseTo(1_000 / 30);
    expect(phaser.loop.sleep).toHaveBeenCalledTimes(1);
    expect(phaser.loop.wake).toHaveBeenCalledTimes(1);
    expect(duel.currentRenderSettings).toMatchObject({
      targetFps: 30,
      effectsQuality: 'low',
    });
    expect(phaserHarness.games).toHaveLength(gameCount + 1);
  });
});
