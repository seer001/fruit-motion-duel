import Phaser from 'phaser';

import { AudioManager } from '../audio/AudioManager';
import { getBalance } from '../config/balance';
import { sweepIntersectsCircleAtLatestSample } from '../core/collision';
import { ScoreEngine } from '../core/score-engine';
import {
  selectActiveBladeTrails,
  selectFreshUnconsumedBladeTrails,
  stabilizeActiveBladeTrails,
} from './blade-trail-policy';
import type {
  GameRoundConfig,
  Point,
  RoundFinishedPayload,
  ScoreBreakdown,
  ScriptObject,
  SliceTrail,
} from '../types/game';

const LOGICAL_WIDTH = 1920;
const LOGICAL_HEIGHT = 1080;
const LANE_MARGIN = 48;
const CENTER_GAP = 120;
const LEFT_LANE = { minX: LANE_MARGIN, maxX: LOGICAL_WIDTH / 2 - CENTER_GAP / 2 };
const RIGHT_LANE = { minX: LOGICAL_WIDTH / 2 + CENTER_GAP / 2, maxX: LOGICAL_WIDTH - LANE_MARGIN };
const SOLO_ARENA = { minX: LANE_MARGIN, maxX: LOGICAL_WIDTH - LANE_MARGIN };
const BLADE_COLLISION_RADIUS = 32;
const BLADE_CURSOR_RADIUS = 32;
const BLADE_CURSOR_HALO_RADIUS = 48;
const TRAIL_VISIBLE_MS = 180;
const SCORING_RESULT_FRESHNESS_MS = 180;

interface ActiveTarget {
  eventId: string;
  ownerId: string;
  descriptor: ScriptObject;
  visual: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Arc;
  radius: number;
  elapsedMs: number;
  rotationRate: number;
}

export interface FruitDuelCallbacks {
  onCountdown?: (value: string | null) => void;
  onStarted?: () => void;
  onScore?: (participantId: string, score: ScoreBreakdown, delta: number) => void;
  onTick?: (remainingMs: number) => void;
  onFinished?: (result: RoundFinishedPayload) => void;
  onNotice?: (message: string, kind: 'combo' | 'bomb' | 'slice') => void;
}

type GameBusEvent =
  | 'scene-ready'
  | 'round-prepare'
  | 'round-countdown'
  | 'round-pause'
  | 'round-resume'
  | 'round-abort'
  | 'trails';

export class FruitDuelGame {
  readonly ready: Promise<void>;

  private readonly bus = new Phaser.Events.EventEmitter();
  private readonly game: Phaser.Game;
  private resolveReady!: () => void;

  constructor(parent: HTMLElement, audio: AudioManager, callbacks: FruitDuelCallbacks = {}) {
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });

    const scene = new DuelScene(this.bus, audio, callbacks);
    this.game = new Phaser.Game({
      type: Phaser.WEBGL,
      parent,
      width: LOGICAL_WIDTH,
      height: LOGICAL_HEIGHT,
      transparent: true,
      backgroundColor: 'rgba(0,0,0,0)',
      antialias: true,
      render: {
        antialias: true,
        pixelArt: false,
        roundPixels: false,
        powerPreference: 'high-performance',
      },
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      fps: {
        target: 60,
        smoothStep: true,
      },
      scene: [scene],
      audio: {
        noAudio: true,
      },
    });

    this.bus.once('scene-ready', () => this.resolveReady());
  }

  async prepareRound(config: GameRoundConfig, countdownSeconds = 3): Promise<void> {
    await this.ready;
    this.bus.emit('round-prepare', config);
    this.bus.emit('round-countdown', countdownSeconds);
  }

  updateTrails(trails: SliceTrail[]): void {
    this.bus.emit('trails', trails);
  }

  pause(reason = '主持人暫停'): void {
    this.bus.emit('round-pause', reason);
  }

  resume(): void {
    this.bus.emit('round-resume');
  }

  abort(): void {
    this.bus.emit('round-abort');
  }

  destroy(): void {
    this.bus.removeAllListeners();
    this.game.destroy(true);
  }
}

class DuelScene extends Phaser.Scene {
  private readonly bus: Phaser.Events.EventEmitter;
  private readonly audioManager: AudioManager;
  private readonly callbacks: FruitDuelCallbacks;
  private round: GameRoundConfig | null = null;
  private scores = new Map<string, ScoreEngine>();
  private activeTargets: ActiveTarget[] = [];
  private trails: SliceTrail[] = [];
  private scoringTrails: SliceTrail[] = [];
  private lastConsumedTrailAt = new Map<string, number>();
  private elapsedMs = 0;
  private nextSpawnIndex = 0;
  private running = false;
  private roundPaused = false;
  private lastTickBucket = -1;
  private trailGraphics!: Phaser.GameObjects.Graphics;
  private backdropGraphics!: Phaser.GameObjects.Graphics;
  private centerMessage!: Phaser.GameObjects.Text;
  private countdownTimers: Phaser.Time.TimerEvent[] = [];

  constructor(bus: Phaser.Events.EventEmitter, audio: AudioManager, callbacks: FruitDuelCallbacks) {
    super({ key: 'DuelScene', active: true });
    this.bus = bus;
    this.audioManager = audio;
    this.callbacks = callbacks;
  }

  create(): void {
    this.backdropGraphics = this.add.graphics().setDepth(-10);
    this.trailGraphics = this.add.graphics().setDepth(50);
    this.centerMessage = this.add
      .text(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT * 0.48, '', {
        color: '#f7fbff',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '112px',
        fontStyle: 'bold',
        stroke: '#06101b',
        strokeThickness: 18,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setAlpha(0);

    this.drawArena();
    this.bus.on('round-prepare', this.prepareRound, this);
    this.bus.on('round-countdown', this.beginCountdown, this);
    this.bus.on('round-pause', this.pauseRound, this);
    this.bus.on('round-resume', this.resumeRound, this);
    this.bus.on('round-abort', this.abortRound, this);
    this.bus.on('trails', (trails: SliceTrail[]) => {
      if (!this.round) {
        this.trails = [];
        this.scoringTrails = [];
        return;
      }
      const owners = this.round.players.map(({ participant, lane }) => ({
        participantId: participant.id,
        lane,
        activeHand: participant.activeHand,
      }));
      this.scoringTrails = selectActiveBladeTrails(trails, owners);
      this.trails = stabilizeActiveBladeTrails(
        this.trails,
        this.scoringTrails,
        owners,
        performance.now(),
        TRAIL_VISIBLE_MS,
      );
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.bus.off('round-prepare', this.prepareRound, this);
      this.bus.off('round-countdown', this.beginCountdown, this);
      this.bus.off('round-pause', this.pauseRound, this);
      this.bus.off('round-resume', this.resumeRound, this);
      this.bus.off('round-abort', this.abortRound, this);
    });
    this.bus.emit('scene-ready');
  }

  update(_time: number, delta: number): void {
    this.drawTrails();
    if (!this.running || this.roundPaused || !this.round) return;

    this.elapsedMs = Math.min(this.round.durationMs, this.elapsedMs + Math.min(delta, 50));
    this.spawnDueObjects();
    this.updateTargets(delta);
    this.detectSlices();

    const remainingMs = Math.max(0, this.round.durationMs - this.elapsedMs);
    const tickBucket = Math.floor(remainingMs / 100);
    if (tickBucket !== this.lastTickBucket) {
      this.lastTickBucket = tickBucket;
      this.callbacks.onTick?.(remainingMs);
    }

    if (this.elapsedMs >= this.round.durationMs) {
      this.finishRound();
    }
  }

  private drawArena(solo = false): void {
    this.backdropGraphics.clear();
    if (solo) {
      this.backdropGraphics.fillStyle(0xaa8cff, 0.075);
      this.backdropGraphics.fillRoundedRect(
        SOLO_ARENA.minX,
        92,
        SOLO_ARENA.maxX - SOLO_ARENA.minX,
        LOGICAL_HEIGHT - 152,
        42,
      );
      return;
    }
    this.backdropGraphics.fillStyle(0x22cfff, 0.055);
    this.backdropGraphics.fillRoundedRect(
      LEFT_LANE.minX,
      92,
      LEFT_LANE.maxX - LEFT_LANE.minX,
      LOGICAL_HEIGHT - 152,
      42,
    );
    this.backdropGraphics.fillStyle(0xff724c, 0.055);
    this.backdropGraphics.fillRoundedRect(
      RIGHT_LANE.minX,
      92,
      RIGHT_LANE.maxX - RIGHT_LANE.minX,
      LOGICAL_HEIGHT - 152,
      42,
    );
    this.backdropGraphics.fillStyle(0xffbf47, 0.08);
    this.backdropGraphics.fillRect(LOGICAL_WIDTH / 2 - CENTER_GAP / 2, 0, CENTER_GAP, LOGICAL_HEIGHT);
    this.backdropGraphics.lineStyle(3, 0xffffff, 0.13);
    this.backdropGraphics.lineBetween(LOGICAL_WIDTH / 2, 0, LOGICAL_WIDTH / 2, LOGICAL_HEIGHT);
  }

  private prepareRound(config: GameRoundConfig): void {
    this.cancelCountdown();
    this.clearTargets();
    this.round = config;
    this.drawArena(config.players.length === 1);
    this.scores = new Map(config.players.map(({ participant }) => [participant.id, new ScoreEngine()]));
    this.elapsedMs = 0;
    this.nextSpawnIndex = 0;
    this.lastTickBucket = -1;
    this.running = false;
    this.roundPaused = false;
    this.trails = [];
    this.scoringTrails = [];
    this.lastConsumedTrailAt.clear();
    this.centerMessage.setAlpha(0).setText('');
    config.players.forEach(({ participant }) => {
      this.callbacks.onScore?.(participant.id, this.scores.get(participant.id)!.snapshot(), 0);
    });
    this.callbacks.onTick?.(config.durationMs);
  }

  private beginCountdown(seconds: number): void {
    if (!this.round) return;
    this.cancelCountdown();
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const values = Array.from({ length: safeSeconds }, (_, index) => String(safeSeconds - index));
    values.push('GO!');

    values.forEach((value, index) => {
      const timer = this.time.delayedCall(index * 760, () => {
        this.centerMessage.setText(value).setScale(1.35).setAlpha(1);
        this.tweens.add({
          targets: this.centerMessage,
          scale: 1,
          alpha: value === 'GO!' ? 1 : 0.18,
          duration: 620,
          ease: 'Cubic.Out',
        });
        this.callbacks.onCountdown?.(value);
        this.audioManager.play(value === 'GO!' ? 'combo' : 'countdown');
      });
      this.countdownTimers.push(timer);
    });

    const startTimer = this.time.delayedCall(values.length * 760, () => {
      this.centerMessage.setAlpha(0);
      this.callbacks.onCountdown?.(null);
      // Motion performed before GO must never be replayed into the first fruit.
      this.scoringTrails = [];
      this.lastConsumedTrailAt.clear();
      this.running = true;
      this.callbacks.onStarted?.();
    });
    this.countdownTimers.push(startTimer);
  }

  private cancelCountdown(): void {
    this.countdownTimers.forEach((timer) => timer.remove(false));
    this.countdownTimers = [];
    this.callbacks.onCountdown?.(null);
  }

  private spawnDueObjects(): void {
    if (!this.round) return;
    const objects = this.round.script.objects;
    while (this.nextSpawnIndex < objects.length) {
      const descriptor = objects[this.nextSpawnIndex];
      if (!descriptor || descriptor.spawnAtMs > this.elapsedMs) break;
      this.round.players.forEach(({ participant, lane }) => {
        this.spawnTarget(descriptor, participant.id, lane, participant.activeHand);
      });
      this.nextSpawnIndex += 1;
    }
  }

  private spawnTarget(
    descriptor: ScriptObject,
    ownerId: string,
    lane: 'left' | 'right',
    activeHand: 'left' | 'right',
  ): void {
    const bounds = this.round?.players.length === 1
      ? SOLO_ARENA
      : lane === 'left'
        ? LEFT_LANE
        : RIGHT_LANE;
    let localX = descriptor.x;
    if (this.round?.players.length !== 1 && lane === 'right') localX = 1 - localX;
    if (activeHand === 'left') localX = 1 - localX;
    const x = Phaser.Math.Linear(bounds.minX + 80, bounds.maxX - 80, Phaser.Math.Clamp(localX, 0, 1));
    const radius = Phaser.Math.Clamp(
      descriptor.radiusRatio * (bounds.maxX - bounds.minX),
      descriptor.kind === 'bomb' ? 46 : 42,
      94,
    );
    const visual = this.createTargetVisual(descriptor, radius).setPosition(x, LOGICAL_HEIGHT + radius + 24);
    const body = visual.getAt(0) as Phaser.GameObjects.Arc;
    this.activeTargets.push({
      eventId: `${descriptor.id}:${ownerId}`,
      ownerId,
      descriptor,
      visual,
      body,
      radius,
      elapsedMs: 0,
      rotationRate: Phaser.Math.FloatBetween(-0.0014, 0.0014),
    });
  }

  private createTargetVisual(descriptor: ScriptObject, radius: number): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0).setDepth(12);
    if (descriptor.kind === 'bomb') {
      const shadow = this.add.circle(5, 8, radius, 0x000000, 0.35);
      const body = this.add.circle(0, 0, radius, 0x111923, 1).setStrokeStyle(7, 0x657486, 0.9);
      const shine = this.add.circle(-radius * 0.28, -radius * 0.3, radius * 0.2, 0xffffff, 0.22);
      const fuse = this.add.rectangle(radius * 0.42, -radius * 0.7, radius * 0.18, radius * 0.62, 0x9d6b42).setRotation(0.65);
      const spark = this.add.star(radius * 0.65, -radius * 0.98, 7, radius * 0.14, radius * 0.3, 0xffcf52);
      const icon = this.add.text(0, radius * 0.05, '!', {
        color: '#ffcf52',
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${Math.round(radius * 1.05)}px`,
        fontStyle: 'bold',
      }).setOrigin(0.5);
      container.add([shadow, body, shine, fuse, spark, icon]);
      return container;
    }

    const fruitVisuals: Record<NonNullable<ScriptObject['fruitType']>, { emoji: string; color: number }> = {
      apple: { emoji: '🍎', color: 0xf04f57 },
      orange: { emoji: '🍊', color: 0xffa52d },
      watermelon: { emoji: '🍉', color: 0x45c86b },
      kiwi: { emoji: '🥝', color: 0x9bc75b },
      dragonfruit: { emoji: '🐲', color: 0xff69a6 },
    };
    const fruit = fruitVisuals[descriptor.fruitType ?? 'apple'];
    const shadow = this.add.ellipse(6, 9, radius * 1.8, radius * 1.72, 0x000000, 0.28);
    const body = this.add.circle(0, 0, radius, fruit.color, 0.97).setStrokeStyle(6, 0xffffff, 0.22);
    const shine = this.add.ellipse(-radius * 0.28, -radius * 0.3, radius * 0.34, radius * 0.54, 0xffffff, 0.35).setRotation(0.45);
    const leaf = this.add.ellipse(radius * 0.12, -radius * 0.93, radius * 0.48, radius * 0.25, 0x79e96c).setRotation(-0.5);
    const emoji = this.add.text(0, radius * 0.04, fruit.emoji, {
      fontFamily: 'Apple Color Emoji, system-ui',
      fontSize: `${Math.round(radius * 1.05)}px`,
    }).setOrigin(0.5);
    container.add([body, shadow, shine, leaf, emoji]);
    container.sendToBack(shadow);
    return container;
  }

  private updateTargets(delta: number): void {
    const missed: ActiveTarget[] = [];
    this.activeTargets.forEach((target) => {
      target.elapsedMs += delta;
      const t = Phaser.Math.Clamp(target.elapsedMs / target.descriptor.flightMs, 0, 1);
      const startY = LOGICAL_HEIGHT + target.radius + 24;
      const apexY = Phaser.Math.Clamp(target.descriptor.apexY, 0.12, 0.7) * LOGICAL_HEIGHT;
      target.visual.y = startY - (startY - apexY) * 4 * t * (1 - t);
      target.visual.rotation += target.rotationRate * delta;
      if (t >= 1) missed.push(target);
    });

    missed.forEach((target) => this.missTarget(target));
  }

  private detectSlices(): void {
    if (!this.round) return;
    const now = performance.now();
    const freshTrails = selectFreshUnconsumedBladeTrails(
      this.scoringTrails,
      this.lastConsumedTrailAt,
      now,
      SCORING_RESULT_FRESHNESS_MS,
    );
    const laneWidth = LEFT_LANE.maxX - LEFT_LANE.minX;
    // Balance values are player-local lane widths per second; collision points
    // are already expressed in the 1920×1080 logical canvas.
    const minimumSpeed = getBalance(this.round.difficulty).minimumSliceSpeed * laneWidth;

    const sliced: ActiveTarget[] = [];
    for (const target of [...this.activeTargets]) {
      const ownerTrails = freshTrails.filter(
        (trail) => trail.participantId === target.ownerId && trail.confidence >= 0.55,
      );
      const hit = ownerTrails.some((trail) =>
        sweepIntersectsCircleAtLatestSample(
          trail,
          { x: target.visual.x, y: target.visual.y, radius: target.radius * 0.82 },
          { strokeRadius: BLADE_COLLISION_RADIUS, minimumSpeedPerSecond: minimumSpeed },
        ),
      );
      if (hit) sliced.push(target);
    }

    freshTrails.forEach((trail) => {
      if (trail.receivedAtMs !== undefined) {
        this.lastConsumedTrailAt.set(trail.participantId, trail.receivedAtMs);
      }
    });

    sliced.forEach((target) => this.hitTarget(target));
    const fruitSlices = sliced.filter(({ descriptor }) => descriptor.kind === 'fruit').length;
    if (fruitSlices >= 2) {
      // Multi-slice is intentionally cosmetic: it never changes the score.
      this.audioManager.play('combo');
      this.showMultiSliceBadge(fruitSlices);
      this.callbacks.onNotice?.(`${fruitSlices} 果連切！`, 'combo');
    }
  }

  private hitTarget(target: ActiveTarget): void {
    const engine = this.scores.get(target.ownerId);
    if (!engine) return;
    const result = engine.apply({
      id: target.eventId,
      type: target.descriptor.kind === 'bomb' ? 'bomb-hit' : 'fruit-hit',
    });
    if (!result.applied) return;

    const pan = target.visual.x < LOGICAL_WIDTH / 2 ? -0.65 : 0.65;
    if (target.descriptor.kind === 'bomb') {
      this.audioManager.play('bomb', pan);
      this.cameras.main.shake(250, 0.009);
      this.flashTarget(target, 0xff315d);
      this.callbacks.onNotice?.('炸彈！連擊歸零', 'bomb');
    } else {
      const variant = (result.breakdown.fruitHits - 1) % 4;
      const sliceCues = ['slice-0', 'slice-1', 'slice-2', 'slice-3'] as const;
      this.audioManager.play(sliceCues[variant] ?? 'slice-0', pan);
      this.sliceBurst(target);
      if ([5, 10, 20].includes(result.breakdown.combo)) {
        this.audioManager.play('combo', pan);
        this.callbacks.onNotice?.(`${result.breakdown.combo} 連擊！`, 'combo');
      } else {
        this.callbacks.onNotice?.(`+${Math.max(0, result.delta)}`, 'slice');
      }
    }
    this.callbacks.onScore?.(target.ownerId, result.breakdown, result.delta);
    this.removeTarget(target);
  }

  private missTarget(target: ActiveTarget): void {
    if (target.descriptor.kind === 'fruit') {
      const result = this.scores.get(target.ownerId)?.apply({ id: target.eventId, type: 'fruit-miss' });
      if (result?.applied) this.callbacks.onScore?.(target.ownerId, result.breakdown, 0);
    }
    this.removeTarget(target);
  }

  private sliceBurst(target: ActiveTarget): void {
    const color = target.body.fillColor;
    for (let index = 0; index < 10; index += 1) {
      const drop = this.add.circle(target.visual.x, target.visual.y, Phaser.Math.Between(5, 13), color, 0.85).setDepth(25);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const distance = Phaser.Math.Between(55, 150);
      this.tweens.add({
        targets: drop,
        x: drop.x + Math.cos(angle) * distance,
        y: drop.y + Math.sin(angle) * distance + 60,
        alpha: 0,
        scale: 0.2,
        duration: Phaser.Math.Between(340, 620),
        ease: 'Cubic.Out',
        onComplete: () => drop.destroy(),
      });
    }
    const popup = this.add.text(target.visual.x, target.visual.y - target.radius, 'SLICE!', {
      color: '#ffffff',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '34px',
      fontStyle: 'bold',
      stroke: '#0b1724',
      strokeThickness: 8,
    }).setOrigin(0.5).setDepth(40);
    this.tweens.add({
      targets: popup,
      y: popup.y - 90,
      alpha: 0,
      scale: 1.24,
      duration: 540,
      ease: 'Cubic.Out',
      onComplete: () => popup.destroy(),
    });
  }

  private showMultiSliceBadge(count: number): void {
    const badge = this.add
      .text(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT * 0.34, `MULTI SLICE ×${count}`, {
        color: '#fff3b8',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '58px',
        fontStyle: 'bold',
        stroke: '#07111f',
        strokeThickness: 12,
      })
      .setOrigin(0.5)
      .setDepth(80)
      .setScale(0.72);
    this.tweens.add({
      targets: badge,
      y: badge.y - 70,
      scale: 1.08,
      alpha: 0,
      duration: 720,
      ease: 'Back.Out',
      onComplete: () => badge.destroy(),
    });
  }

  private flashTarget(target: ActiveTarget, color: number): void {
    const flash = this.add.circle(target.visual.x, target.visual.y, target.radius * 1.6, color, 0.4).setDepth(30);
    this.tweens.add({
      targets: flash,
      scale: 2.3,
      alpha: 0,
      duration: 380,
      onComplete: () => flash.destroy(),
    });
  }

  private drawTrails(): void {
    this.trailGraphics.clear();
    const now = performance.now();
    this.trails.forEach((trail) => {
      const deliveryAgeMs = now - (trail.receivedAtMs ?? now);
      if (deliveryAgeMs < 0 || deliveryAgeMs > TRAIL_VISIBLE_MS) return;
      const newestCaptureAt = trail.points.at(-1)?.timestampMs;
      if (newestCaptureAt === undefined) return;
      // Capture timestamps define the shape and speed of the sweep. Delivery
      // age defines whether it is still visible; mixing these two clocks made
      // a delayed dual-player result disappear immediately on arrival.
      const points = trail.points.filter(
        (point) => newestCaptureAt - point.timestampMs <= TRAIL_VISIBLE_MS,
      );
      if (points.length === 0) return;
      const color = this.round?.players.length === 1
        ? 0xc0a9ff
        : trail.lane === 'left'
          ? 0x3ae4ff
          : 0xff805a;
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        if (!start || !end) continue;
        const sampleAgeMs = Math.max(0, newestCaptureAt - end.timestampMs);
        const ageRatio = Phaser.Math.Clamp(
          Math.max(deliveryAgeMs, sampleAgeMs) / TRAIL_VISIBLE_MS,
          0,
          1,
        );
        this.trailGraphics.lineStyle(22 * (1 - ageRatio * 0.55), color, (1 - ageRatio) * trail.confidence);
        this.trailGraphics.lineBetween(start.x, start.y, end.x, end.y);
        this.trailGraphics.lineStyle(6, 0xffffff, (1 - ageRatio) * 0.9);
        this.trailGraphics.lineBetween(start.x, start.y, end.x, end.y);
      }

      const blade = points.at(-1);
      if (!blade) return;
      const ageRatio = Phaser.Math.Clamp(deliveryAgeMs / TRAIL_VISIBLE_MS, 0, 1);
      const alpha = (1 - ageRatio * 0.55) * Math.max(0.72, trail.confidence);

      // A dark halo, white rim, player-colour ring and white center remain
      // visible on both bright clothing and a dark camera background. The
      // coloured ring approximates the actual collision radius.
      this.trailGraphics.fillStyle(0x06101b, alpha * 0.62);
      this.trailGraphics.fillCircle(blade.x, blade.y, BLADE_CURSOR_HALO_RADIUS);
      this.trailGraphics.lineStyle(10, 0xffffff, alpha);
      this.trailGraphics.strokeCircle(blade.x, blade.y, BLADE_CURSOR_RADIUS + 5);
      this.trailGraphics.lineStyle(7, color, alpha);
      this.trailGraphics.strokeCircle(blade.x, blade.y, BLADE_CURSOR_RADIUS);
      this.trailGraphics.fillStyle(color, alpha * 0.38);
      this.trailGraphics.fillCircle(blade.x, blade.y, BLADE_CURSOR_RADIUS - 5);
      this.trailGraphics.fillStyle(0xffffff, alpha);
      this.trailGraphics.fillCircle(blade.x, blade.y, 9);
      this.trailGraphics.lineStyle(3, 0x06101b, alpha);
      this.trailGraphics.strokeCircle(blade.x, blade.y, 9);
    });
  }

  private removeTarget(target: ActiveTarget): void {
    const index = this.activeTargets.indexOf(target);
    if (index >= 0) this.activeTargets.splice(index, 1);
    target.visual.destroy(true);
  }

  private clearTargets(): void {
    this.activeTargets.forEach((target) => target.visual.destroy(true));
    this.activeTargets = [];
  }

  private pauseRound(reason: string): void {
    if (!this.running || this.roundPaused) return;
    this.roundPaused = true;
    this.centerMessage.setText('PAUSED').setAlpha(0.9).setScale(1);
    this.callbacks.onNotice?.(reason, 'bomb');
  }

  private resumeRound(): void {
    if (!this.running || !this.roundPaused) return;
    this.roundPaused = false;
    this.scoringTrails = [];
    this.lastConsumedTrailAt.clear();
    this.centerMessage.setAlpha(0);
  }

  private abortRound(): void {
    this.cancelCountdown();
    this.running = false;
    this.roundPaused = false;
    this.clearTargets();
    this.centerMessage.setText('ROUND VOID').setAlpha(0.9);
  }

  private finishRound(): void {
    if (!this.round || !this.running) return;
    this.running = false;
    for (const target of [...this.activeTargets]) this.missTarget(target);
    const payload: RoundFinishedPayload = {
      scriptId: this.round.script.id,
      elapsedMs: this.elapsedMs,
      scores: Object.fromEntries(
        [...this.scores.entries()].map(([participantId, engine]) => [participantId, engine.snapshot()]),
      ),
    };
    this.audioManager.play('round-end');
    this.centerMessage.setText('TIME!').setAlpha(1).setScale(1.15);
    this.tweens.add({ targets: this.centerMessage, scale: 1, duration: 420, ease: 'Back.Out' });
    this.callbacks.onFinished?.(payload);
  }
}

export function normalizedToLogical(point: Point, mirrored = true): Point {
  return {
    x: (mirrored ? 1 - point.x : point.x) * LOGICAL_WIDTH,
    y: point.y * LOGICAL_HEIGHT,
  };
}

export const GAME_LOGICAL_SIZE = { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT } as const;
