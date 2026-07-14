import { escapeHtml, requireElement } from './dom';
import type { NormalizedLandmark, PoseObservation } from '../types/game';
import type { PerformanceSettings } from '../config/performance';

export type CameraUiState = 'idle' | 'requesting' | 'ready' | 'warning' | 'error';

export interface PoseOverlayAssignment {
  lane: 'left' | 'right';
  label: string;
  identityLocked: boolean;
}

const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // Only the head anchors needed for subject identity are drawn. MediaPipe
  // still outputs 33 landmarks, but inner eyes/mouth and lower legs do not
  // help this upper-body slicing game and needlessly clutter the overlay.
  [0, 7], [0, 8],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
];

const DRAWN_JOINTS = new Set([
  0, 7, 8,
  11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22,
  23, 24,
]);
const IMPORTANT_JOINTS = new Set([0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);

function jointConfidence(landmark: NormalizedLandmark | undefined): number {
  return landmark ? Math.min(landmark.visibility, landmark.presence) : 0;
}

export class AppShell {
  readonly root: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly poseCanvas: HTMLCanvasElement;
  readonly gameHost: HTMLDivElement;
  readonly screenHost: HTMLDivElement;
  readonly topbar: HTMLElement;
  readonly hostDock: HTMLElement;

  private readonly cameraPill: HTMLElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly volumeControl: HTMLInputElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly toastStack: HTMLElement;
  private readonly overlayLayer: HTMLElement;
  private countdownElement: HTMLElement | null = null;
  private pauseElement: HTMLElement | null = null;
  private hudElement: HTMLElement | null = null;
  private poseOverlayRate: 0 | 10 | 15 | 30 = 30;
  private lastPoseOverlayDrawAt = Number.NEGATIVE_INFINITY;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <main class="app-shell" aria-live="polite">
        <div class="camera-placeholder" aria-hidden="true"></div>
        <video class="camera-feed is-hidden" autoplay muted playsinline aria-label="鏡像攝影機畫面"></video>
        <div class="video-scrim" aria-hidden="true"></div>
        <canvas class="pose-layer" aria-hidden="true"></canvas>
        <div class="game-layer" aria-hidden="true"></div>
        <div class="overlay-layer">
          <header class="topbar">
            <div class="brand" aria-label="果忍對決">
              <span class="brand-mark" aria-hidden="true">果</span>
              <span>FRUIT MOTION DUEL</span>
            </div>
            <div class="topbar-actions">
              <div class="status-pill" id="camera-status" data-state="idle">
                <span class="status-dot" aria-hidden="true"></span>
                <span>尚未連接鏡頭</span>
              </div>
              <label class="volume-control" title="音量">
                <span aria-hidden="true">VOL</span>
                <input id="volume-control" type="range" min="0" max="1" step="0.01" value="0.72" aria-label="音量" />
              </label>
              <button class="btn btn-ghost btn-icon" id="sound-toggle" type="button" aria-label="切換音效" aria-pressed="false">🔊</button>
              <button class="btn btn-ghost btn-icon" id="fullscreen-toggle" type="button" aria-label="切換全螢幕">⛶</button>
            </div>
          </header>
          <section class="screen-host" id="screen-host"></section>
          <nav class="host-dock is-hidden" id="host-dock" aria-label="主持人控制列"></nav>
        </div>
        <div class="toast-stack" id="toast-stack" aria-live="assertive"></div>
      </main>
    `;

    this.video = requireElement<HTMLVideoElement>(root, '.camera-feed');
    this.poseCanvas = requireElement<HTMLCanvasElement>(root, '.pose-layer');
    this.gameHost = requireElement<HTMLDivElement>(root, '.game-layer');
    this.screenHost = requireElement<HTMLDivElement>(root, '#screen-host');
    this.topbar = requireElement<HTMLElement>(root, '.topbar');
    this.hostDock = requireElement<HTMLElement>(root, '#host-dock');
    this.cameraPill = requireElement<HTMLElement>(root, '#camera-status');
    this.soundButton = requireElement<HTMLButtonElement>(root, '#sound-toggle');
    this.volumeControl = requireElement<HTMLInputElement>(root, '#volume-control');
    this.fullscreenButton = requireElement<HTMLButtonElement>(root, '#fullscreen-toggle');
    this.toastStack = requireElement<HTMLElement>(root, '#toast-stack');
    this.overlayLayer = requireElement<HTMLElement>(root, '.overlay-layer');
  }

  onSoundToggle(listener: () => void): void {
    this.soundButton.addEventListener('click', listener);
  }

  onVolumeChange(listener: (volume: number) => void): void {
    this.volumeControl.addEventListener('input', () => {
      listener(Number(this.volumeControl.value));
    });
  }

  onFullscreenToggle(listener: () => void): void {
    this.fullscreenButton.addEventListener('click', listener);
  }

  setMuted(muted: boolean): void {
    this.soundButton.textContent = muted ? '🔇' : '🔊';
    this.soundButton.setAttribute('aria-pressed', String(muted));
  }

  setCameraState(state: CameraUiState, message: string): void {
    this.cameraPill.dataset['state'] = state === 'error' ? 'warning' : state;
    const label = this.cameraPill.querySelector('span:last-child');
    if (label) label.textContent = message;
    this.video.classList.toggle('is-hidden', state !== 'ready');
    if (state !== 'ready') this.clearPoseOverlay();
  }

  setPoseOverlayRate(rate: 0 | 10 | 15 | 30): void {
    this.poseOverlayRate = rate;
    this.lastPoseOverlayDrawAt = Number.NEGATIVE_INFINITY;
    if (rate === 0) this.clearPoseOverlay();
  }

  applyPerformanceAppearance(settings: PerformanceSettings): void {
    this.root.dataset['cssBlur'] = String(settings.cssBlur);
    this.root.dataset['effectsQuality'] = settings.effectsQuality;
    this.root.dataset['cameraBehindGame'] = String(settings.showCameraBehindGame);
    this.setPoseOverlayRate(settings.poseOverlayRate);
  }

  drawPoseObservations(
    observations: readonly PoseObservation[],
    mirrored = true,
    assignments?: ReadonlyMap<string, PoseOverlayAssignment>,
  ): void {
    if (this.poseOverlayRate === 0) return;
    const nowMs = performance.now();
    if (nowMs - this.lastPoseOverlayDrawAt < 1_000 / this.poseOverlayRate) return;
    this.lastPoseOverlayDrawAt = nowMs;
    const rect = this.root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // This canvas is diagnostic feedback, not the scoring surface. Keeping it
    // at CSS-pixel resolution avoids clearing and redrawing a 4K backing store
    // on every pose result on Retina Macs.
    const pixelRatio = 1;
    const targetWidth = Math.max(1, Math.round(rect.width * pixelRatio));
    const targetHeight = Math.max(1, Math.round(rect.height * pixelRatio));
    if (this.poseCanvas.width !== targetWidth || this.poseCanvas.height !== targetHeight) {
      this.poseCanvas.width = targetWidth;
      this.poseCanvas.height = targetHeight;
    }
    const context = this.poseCanvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const sourceWidth = this.video.videoWidth || 16;
    const sourceHeight = this.video.videoHeight || 9;
    const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
    const renderedWidth = sourceWidth * scale;
    const renderedHeight = sourceHeight * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    const point = (landmark: NormalizedLandmark): { x: number; y: number } => ({
      x: offsetX + (mirrored ? 1 - landmark.x : landmark.x) * renderedWidth,
      y: offsetY + landmark.y * renderedHeight,
    });
    const laneColors = { left: '#35d8ff', right: '#ff805a' } as const;
    const fallbackColors = ['#35d8ff', '#ff805a', '#b9f564'];

    observations.forEach((observation, poseIndex) => {
      const assignment = assignments?.get(observation.temporaryId);
      const isTracked = assignments === undefined || assignment !== undefined;
      const color = assignment
        ? laneColors[assignment.lane]
        : assignments === undefined
          ? (fallbackColors[poseIndex % fallbackColors.length] ?? '#ffffff')
          : '#778391';
      const emphasis = isTracked ? 1 : 0.24;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      for (const [fromIndex, toIndex] of POSE_CONNECTIONS) {
        const from = observation.landmarks[fromIndex];
        const to = observation.landmarks[toIndex];
        if (!from || !to) continue;
        const confidence = Math.min(jointConfidence(from), jointConfidence(to));
        if (confidence < 0.22) continue;
        const start = point(from);
        const end = point(to);
        context.strokeStyle = color;
        context.globalAlpha = (0.24 + confidence * 0.58) * emphasis;
        context.lineWidth = isTracked ? 2 + confidence * 3 : 1.5;
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }

      observation.landmarks.forEach((landmark, index) => {
        if (!DRAWN_JOINTS.has(index)) return;
        const confidence = jointConfidence(landmark);
        if (confidence < 0.22) return;
        const center = point(landmark);
        context.globalAlpha = (0.35 + confidence * 0.65) * emphasis;
        context.fillStyle = IMPORTANT_JOINTS.has(index) ? '#ffffff' : color;
        context.strokeStyle = color;
        context.lineWidth = isTracked ? 2 : 1;
        context.beginPath();
        context.arc(
          center.x,
          center.y,
          isTracked ? (IMPORTANT_JOINTS.has(index) ? 5 : 3) : 2,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.stroke();
      });

      if (assignment) {
        const visibleHead = [0, 7, 8].flatMap((index) => {
          const landmark = observation.landmarks[index];
          return landmark && jointConfidence(landmark) >= 0.22 ? [landmark] : [];
        });
        if (visibleHead.length > 0) {
          const head = {
            x: visibleHead.reduce((sum, landmark) => sum + point(landmark).x, 0) /
              visibleHead.length,
            y: visibleHead.reduce((sum, landmark) => sum + point(landmark).y, 0) /
              visibleHead.length,
          };
          context.globalAlpha = 0.95;
          context.strokeStyle = color;
          context.lineWidth = assignment.identityLocked ? 5 : 3;
          context.beginPath();
          context.arc(head.x, head.y, assignment.identityLocked ? 24 : 19, 0, Math.PI * 2);
          context.stroke();
          context.font = '700 14px system-ui, sans-serif';
          context.textAlign = 'center';
          context.textBaseline = 'bottom';
          context.fillStyle = '#ffffff';
          context.fillText(
            `${assignment.identityLocked ? '🔒 ' : ''}${assignment.label}`,
            head.x,
            head.y - 29,
          );
        }
      }
    });
    context.globalAlpha = 1;
  }

  clearPoseOverlay(): void {
    this.lastPoseOverlayDrawAt = Number.NEGATIVE_INFINITY;
    const context = this.poseCanvas.getContext('2d');
    context?.clearRect(0, 0, this.poseCanvas.width, this.poseCanvas.height);
  }

  renderScreen(markup: string, wide = false): HTMLElement {
    this.screenHost.innerHTML = `<section class="screen${wide ? ' is-wide' : ''}">${markup}</section>`;
    const screen = requireElement<HTMLElement>(this.screenHost, '.screen');
    screen.scrollTop = 0;
    return screen;
  }

  clearScreen(): void {
    this.screenHost.innerHTML = '';
  }

  showGameChrome(show: boolean): void {
    this.root.classList.toggle('is-game-active', show);
    this.screenHost.style.display = show ? 'none' : '';
    this.topbar.style.opacity = show ? '0.82' : '';
  }

  setSoloArena(active: boolean): void {
    this.root.classList.toggle('is-solo-arena', active);
  }

  setHostControls(markup: string): HTMLElement {
    this.hostDock.innerHTML = markup;
    this.hostDock.classList.remove('is-hidden');
    return this.hostDock;
  }

  hideHostControls(): void {
    this.hostDock.classList.add('is-hidden');
    this.hostDock.innerHTML = '';
  }

  showHud(
    left: { name: string; score: number },
    right: { name: string; score: number } | null,
    remainingMs: number,
  ): void {
    if (!this.hudElement) {
      this.hudElement = document.createElement('section');
      this.hudElement.className = 'game-hud';
      this.hudElement.innerHTML = `
        <div class="hud-score" data-lane="left">
          <div><div class="muted hud-left-name"></div><div class="hud-points hud-left-score">0</div></div>
        </div>
        <div class="hud-timer">0.0</div>
        <div class="hud-score" data-lane="right">
          <div><div class="muted hud-right-name"></div><div class="hud-points hud-right-score">0</div></div>
        </div>
      `;
      this.root.append(this.hudElement);
    }

    requireElement<HTMLElement>(this.hudElement, '.hud-left-name').textContent = left.name;
    requireElement<HTMLElement>(this.hudElement, '.hud-left-score').textContent = left.score.toLocaleString();
    const rightCard = requireElement<HTMLElement>(this.hudElement, '[data-lane="right"]');
    rightCard.style.visibility = right ? 'visible' : 'hidden';
    requireElement<HTMLElement>(this.hudElement, '.hud-right-name').textContent = right?.name ?? '';
    requireElement<HTMLElement>(this.hudElement, '.hud-right-score').textContent = (right?.score ?? 0).toLocaleString();
    requireElement<HTMLElement>(this.hudElement, '.hud-timer').textContent = Math.max(0, remainingMs / 1000).toFixed(1);
  }

  hideHud(): void {
    this.hudElement?.remove();
    this.hudElement = null;
  }

  showCountdown(value: string): void {
    this.hideCountdown();
    this.countdownElement = document.createElement('div');
    this.countdownElement.className = 'countdown-overlay';
    this.countdownElement.innerHTML = `<div class="countdown-number">${escapeHtml(value)}</div>`;
    this.root.append(this.countdownElement);
  }

  hideCountdown(): void {
    this.countdownElement?.remove();
    this.countdownElement = null;
  }

  showPause(title: string, detail: string): void {
    if (!this.pauseElement) {
      this.pauseElement = document.createElement('div');
      this.pauseElement.className = 'pause-overlay';
      this.root.append(this.pauseElement);
    }
    this.pauseElement.innerHTML = `
      <div class="pause-card">
        <p class="eyebrow">遊戲已安全暫停</p>
        <h2>${escapeHtml(title)}</h2>
        <p class="lead">${escapeHtml(detail)}</p>
      </div>
    `;
  }

  hidePause(): void {
    this.pauseElement?.remove();
    this.pauseElement = null;
  }

  toast(message: string, kind: 'info' | 'success' | 'error' = 'info', timeoutMs = 3600): void {
    const element = document.createElement('div');
    element.className = 'toast';
    element.dataset['kind'] = kind;
    element.textContent = message;
    this.toastStack.append(element);
    window.setTimeout(() => element.remove(), timeoutMs);
  }

  destroy(): void {
    this.setSoloArena(false);
    this.clearPoseOverlay();
    this.hideCountdown();
    this.hidePause();
    this.hideHud();
    this.root.innerHTML = '';
  }
}
