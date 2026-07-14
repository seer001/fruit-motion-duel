import { AudioManager } from './audio/AudioManager';
import {
  DeterministicScriptPool,
  OneEuroPointFilter,
  SCRIPT_POOL_SIZES,
  createHiddenScriptPool,
} from './core';
import { IndexedDbEventStore } from './data';
import { FruitDuelGame, normalizedToLogical } from './game/FruitDuelGame';
import {
  AppFlowStateMachine,
  TournamentManager,
  TournamentRuleError,
  TournamentTieError,
  type HalfAssignment,
  type LeaderboardEntry,
  type ParticipantDraft,
  type TiebreakPurpose,
  type TournamentScriptPools,
} from './tournament';
import type {
  CalibrationProfile,
  Difficulty,
  DominantHand,
  GameRoundConfig,
  GameRoundPlayer,
  HalfResult,
  Lane,
  Participant,
  PlayerPosture,
  Point,
  PoseFrame,
  PoseObservation,
  RoundFinishedPayload,
  ScoreBreakdown,
  ScriptDefinition,
  SliceTrail,
  TournamentEvent,
} from './types/game';
import { AppShell, type PoseOverlayAssignment } from './ui/AppShell';
import { requireElement, requestAppFullscreen, uniqueId } from './ui/dom';
import {
  calibrationScreen,
  casualSetupScreen,
  championScreen,
  homeScreen,
  leaderboardScreen,
  practiceReadyScreen,
  reviewScreen,
  soloPracticeResultScreen,
  soloPracticeSetupScreen,
  swapScreen,
  tournamentSetupScreen,
  type CalibrationPlayerView,
} from './ui/screens';
import {
  CalibrationCollector,
  AdaptiveCalibrationManager,
  CameraController,
  CameraControllerError,
  SinglePlayerTracker,
  TwoPlayerTracker,
  VisionClient,
  assessTrackingSafety,
  assessCalibrationHealth,
  hasFreshLockedIdentityFrame,
  hasVisionHeartbeatExpired,
  getTorsoGeometry,
  mapCalibratedPointToArena,
  mapCalibratedPointToLane,
  POSE_QUALITY_LANDMARK_COUNT,
  summarizeCalibrationPerformance,
  type PlayerTrackBinding,
  type PlayerTrackingResult,
  type TrackerFrameResult,
} from './vision';

type ScreenName =
  | 'home'
  | 'solo-practice-setup'
  | 'casual-setup'
  | 'tournament-setup'
  | 'calibration'
  | 'practice'
  | 'game'
  | 'review'
  | 'swap'
  | 'leaderboard'
  | 'champion';

type RoundKind = 'solo-practice' | 'casual' | 'practice' | 'tournament';

interface RuntimePlayer {
  participant: Participant;
  lane: Lane;
}

interface ScriptResources {
  pool: DeterministicScriptPool;
  registry: Map<string, ScriptDefinition>;
  ids: TournamentScriptPools;
  practicePool: DeterministicScriptPool;
}

interface TrailState {
  filter: OneEuroPointFilter;
  trail: SliceTrail;
}

interface TiebreakContext {
  purpose: TiebreakPurpose;
  safeFinalistId?: string;
}

interface AppTrackerFrameResult {
  observedAt: number;
  players: PlayerTrackingResult[];
  unassignedObservations: TrackerFrameResult['unassignedObservations'];
  candidateDiagnostics: TrackerFrameResult['candidateDiagnostics'];
}

const EMPTY_SCORE = (): ScoreBreakdown => ({
  score: 0,
  fruitHits: 0,
  fruitMisses: 0,
  bombsHit: 0,
  combo: 0,
  maxCombo: 0,
});

const TRACKING_WARNING_MS = 180;
// A short overlap or spectator crossing disables the knife but keeps the
// round clock running. Only a sustained loss of an enrolled player pauses.
const TRACKING_PAUSE_MS = 1_400;
const TRACKING_RECALIBRATION_AFTER_MS = 5_000;
const TRACKING_RECALIBRATION_TIMEOUT_MS = 10_000;
const CALIBRATION_HAND_READY_FRAMES = 3;

export class AppController {
  private readonly shell: AppShell;
  private readonly audio = new AudioManager();
  private readonly camera: CameraController;
  private readonly vision = new VisionClient();
  private readonly game: FruitDuelGame;
  private readonly eventStore = new IndexedDbEventStore();

  private screen: ScreenName = 'home';
  private cameraReady = false;
  private modelReady = false;
  private cameraConnectionVersion = 0;
  private demoMode = false;
  private devices: MediaDeviceInfo[] = [];
  private savedEvent: TournamentEvent | null = null;
  private inferenceAnimation = 0;
  private inferenceVideoFrameCallback = 0;
  private lastInferenceSubmitAt = 0;
  private inferenceSamples: number[] = [];
  private pipelineSamples: number[] = [];
  private inferenceTimestamps: number[] = [];
  private lastPoseFrameReceivedAt = performance.now();
  private lastVisionPerformance: PoseFrame['performance'];
  private lastPoseObservations: readonly PoseObservation[] = [];
  private lastDetectedPoseCount = 0;
  private diagnosticsElement: HTMLElement | null = null;

  private tracker: TwoPlayerTracker | SinglePlayerTracker | null = null;
  private calibrationCollector: CalibrationCollector | null = null;
  private readonly adaptiveCalibration = new AdaptiveCalibrationManager();
  private calibrationProfiles = new Map<string, CalibrationProfile>();
  private lastTrackerFrame: AppTrackerFrameResult | null = null;
  private currentPlayers: RuntimePlayer[] | null = null;
  private calibrationContinuation: (() => void) | null = null;
  private lastCalibrationUiAt = 0;
  private calibrationProgressWatch = new Map<string, { progress: number; lastAdvancedAt: number }>();
  private calibrationHandReadyFrames = new Map<string, number>();
  private calibrationIdentityLocked = false;
  private trailStates = new Map<string, TrailState>();
  private activePointerOwners = new Map<number, string>();

  private currentRoundKind: RoundKind | null = null;
  private currentRoundActive = false;
  private gamePaused = false;
  private trackingPaused = false;
  private activeScores: Record<string, ScoreBreakdown> = {};
  private remainingMs = 0;
  private trackingPauses: Record<string, number> = {};
  private trackingWarnedPlayers = new Set<string>();
  private trackingImpairedSince = new Map<string, number>();
  private trackingEscalationTimer: number | null = null;
  private trackingRecalibrationTimer: number | null = null;
  private trackingRecalibrationActive = false;
  private trackingRecoveryAnnounced = false;
  private lastSpectatorCount = 0;
  private lastSpectatorNoticeAt = Number.NEGATIVE_INFINITY;
  private latestRoundResult: RoundFinishedPayload | null = null;
  private casualPlayers: [Participant, Participant] | null = null;
  private casualDifficulty: Difficulty = 'normal';
  private soloPracticeParticipant: Participant | null = null;
  private soloPracticeDifficulty: Difficulty = 'easy';
  private soloPracticeDurationMs = 30_000;

  private manager: TournamentManager | null = null;
  private flow: AppFlowStateMachine | null = null;
  private scriptResources: ScriptResources | null = null;
  private currentHeatId: string | null = null;
  private currentAssignment: HalfAssignment | null = null;
  private practicedHeatIds = new Set<string>();
  private tiebreakContext: TiebreakContext | null = null;
  private swapTimer: number | null = null;

  constructor(private readonly root: HTMLElement) {
    this.shell = new AppShell(root);
    this.camera = new CameraController(this.shell.video);
    this.game = new FruitDuelGame(this.shell.gameHost, this.audio, {
      onCountdown: (value) => {
        if (value === null) this.shell.hideCountdown();
        else this.shell.showCountdown(value);
      },
      onStarted: () => this.onRoundStarted(),
      onScore: (participantId, score) => {
        this.activeScores[participantId] = score;
        this.renderHud();
      },
      onTick: (remainingMs) => {
        this.remainingMs = remainingMs;
        this.renderHud();
        this.checkVisionHeartbeat();
      },
      onFinished: (payload) => void this.onRoundFinished(payload),
      onNotice: (message, kind) => {
        if (kind !== 'slice') this.shell.toast(message, kind === 'bomb' ? 'error' : 'success', 1700);
      },
    });

    this.vision.onPoseFrame((frame) => this.handlePoseFrame(frame));
    this.vision.onError((error) => {
      this.shell.toast(error.message, 'error');
      if (!error.recoverable) this.shell.setCameraState('error', '姿態模型錯誤');
    });
    this.shell.onSoundToggle(() => {
      const muted = this.audio.toggleMuted();
      this.shell.setMuted(muted);
    });
    this.shell.onVolumeChange((volume) => this.audio.setVolume(volume));
    this.shell.onFullscreenToggle(() => {
      void requestAppFullscreen(this.root).catch((error: unknown) => {
        this.shell.toast(error instanceof Error ? error.message : '無法進入全螢幕', 'error');
      });
    });

    this.root.addEventListener(
      'pointerdown',
      () => {
        void this.audio.unlock().catch(() => undefined);
      },
      { once: true },
    );
    window.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    window.addEventListener('pointermove', this.onPointerMove, { capture: true });
    window.addEventListener('pointerup', this.onPointerUp, { capture: true });
    window.addEventListener('pointercancel', this.onPointerUp, { capture: true });
    window.addEventListener('keydown', this.onKeyDown);
  }

  async initialize(): Promise<void> {
    this.savedEvent = await this.eventStore.load().catch(() => null);
    await this.renderHome();
    void this.initializeVisionModel();
  }

  destroy(): void {
    this.stopInferenceLoop();
    this.clearTrackingSafetyTimers();
    if (this.swapTimer !== null) window.clearInterval(this.swapTimer);
    window.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    window.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerUp, { capture: true });
    window.removeEventListener('keydown', this.onKeyDown);
    this.camera.stop();
    this.vision.close();
    this.eventStore.close();
    this.game.destroy();
    this.shell.destroy();
  }

  private async renderHome(): Promise<void> {
    this.resetVisibleGame();
    this.screen = 'home';
    this.devices = await this.camera.listDevices().catch(() => this.devices);
    const cameraLabel = this.camera.session?.track.label || undefined;
    const activeDeviceId = this.camera.session?.deviceId || undefined;
    const screen = this.shell.renderScreen(
      homeScreen({
        cameraReady: this.cameraReady,
        modelReady: this.modelReady,
        demoMode: this.demoMode,
        ...(cameraLabel === undefined ? {} : { cameraLabel }),
        ...(activeDeviceId === undefined ? {} : { activeDeviceId }),
        savedEvent: this.savedEvent,
        devices: this.devices,
      }),
      true,
    );

    requireElement<HTMLButtonElement>(screen, '#connect-camera').addEventListener('click', () => {
      const select = screen.querySelector<HTMLSelectElement>('#camera-select');
      void this.connectCamera(select?.value || undefined);
    });
    requireElement<HTMLButtonElement>(screen, '#enable-demo').addEventListener('click', () => {
      this.enableDemoMode();
      void this.renderHome();
    });
    screen.querySelector<HTMLSelectElement>('#camera-select')?.addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      void this.connectCamera(value);
    });
    requireElement<HTMLButtonElement>(screen, '#refresh-cameras').addEventListener('click', () => {
      void this.refreshCameraDevices();
    });
    requireElement<HTMLButtonElement>(screen, '#choose-solo-practice').addEventListener('click', () => {
      void this.ensureInputReady().then((ready) => {
        if (ready) this.renderSoloPracticeSetup();
      });
    });
    requireElement<HTMLButtonElement>(screen, '#choose-casual').addEventListener('click', () => {
      void this.ensureInputReady().then((ready) => {
        if (ready) this.renderCasualSetup();
      });
    });
    requireElement<HTMLButtonElement>(screen, '#choose-tournament').addEventListener('click', () => {
      void this.ensureInputReady().then((ready) => {
        if (ready) this.renderTournamentSetup();
      });
    });
    screen.querySelector<HTMLButtonElement>('#resume-event')?.addEventListener('click', () => {
      void this.ensureInputReady().then((ready) => {
        if (ready) void this.resumeSavedEvent();
      });
    });
    screen.querySelector<HTMLButtonElement>('#discard-event')?.addEventListener('click', () => {
      void this.eventStore.clear().then(() => {
        this.savedEvent = null;
        this.manager = null;
        this.shell.toast('已刪除未完成賽事。', 'success');
        void this.renderHome();
      });
    });
  }

  private async connectCamera(deviceId?: string): Promise<boolean> {
    const connectionVersion = ++this.cameraConnectionVersion;
    this.demoMode = false;
    this.shell.setCameraState('requesting', '正在啟動鏡頭與模型…');
    try {
      const session = await this.camera.start(deviceId);
      await this.vision.initialize();
      if (connectionVersion !== this.cameraConnectionVersion) {
        this.camera.stop();
        return false;
      }
      this.modelReady = true;
      this.cameraReady = true;
      this.devices = await this.camera.listDevices();
      session.track.addEventListener(
        'ended',
        () => {
          if (connectionVersion === this.cameraConnectionVersion) this.handleCameraEnded();
        },
        { once: true },
      );
      this.shell.setCameraState(
        'ready',
        `${session.deviceCategory === 'iphone-continuity' ? 'iPhone RGB · ' : ''}${session.width}×${session.height} · ${Math.round(session.frameRate || 30)} FPS`,
      );
      this.startInferenceLoop();
      this.shell.toast(
        session.deviceCategory === 'iphone-continuity'
          ? 'iPhone 接續互通相機與自適應多關節模型已就緒；網頁影像不含 LiDAR 深度。'
          : '攝影機與自適應多關節姿態模型已就緒。',
        'success',
        5200,
      );
      if (this.screen === 'home') await this.renderHome();
      return true;
    } catch (error) {
      if (connectionVersion !== this.cameraConnectionVersion) return false;
      this.cameraReady = false;
      const cameraError =
        error instanceof CameraControllerError
          ? error
          : new CameraControllerError(
              'unknown',
              error instanceof Error ? error.message : '攝影機或模型啟動失敗。',
              true,
            );
      this.shell.setCameraState('error', '鏡頭尚未就緒');
      this.shell.toast(cameraError.message, 'error', 6000);
      return false;
    }
  }

  private async refreshCameraDevices(): Promise<void> {
    try {
      this.devices = await this.camera.listDevices();
      const labelled = this.devices.filter(({ label }) => label.trim().length > 0).length;
      this.shell.toast(
        labelled > 0
          ? `已重新搜尋：找到 ${this.devices.length} 個視訊鏡頭。`
          : '已搜尋鏡頭；瀏覽器授權後才會顯示名稱與 iPhone 選項。',
        'info',
      );
      if (this.screen === 'home') await this.renderHome();
    } catch (error) {
      this.shell.toast(
        error instanceof Error ? error.message : '無法重新搜尋鏡頭。',
        'error',
        5000,
      );
    }
  }

  private enableDemoMode(): void {
    this.cameraConnectionVersion += 1;
    this.stopInferenceLoop();
    this.camera.stop();
    this.cameraReady = false;
    this.demoMode = true;
    this.shell.setCameraState('warning', '滑鼠示範模式');
    this.shell.toast('按住滑鼠或以多點觸控揮動；雙人模式會依左右半場分流。', 'info');
  }

  private async initializeVisionModel(): Promise<void> {
    try {
      await this.vision.initialize();
      this.modelReady = true;
      if (this.screen === 'home') await this.renderHome();
    } catch (error) {
      this.modelReady = false;
      this.shell.toast(
        error instanceof Error ? error.message : '本機姿態模型載入失敗。',
        'error',
        6000,
      );
      if (this.screen === 'home') await this.renderHome();
    }
  }

  private async ensureInputReady(): Promise<boolean> {
    if (this.cameraReady || this.demoMode) return true;
    return this.connectCamera();
  }

  private startInferenceLoop(): void {
    this.stopInferenceLoop();
    const submitCurrentFrame = (timestamp: number): void => {
      if (this.cameraReady && this.vision.state === 'ready' && timestamp - this.lastInferenceSubmitAt >= 32) {
        if (this.shell.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          this.vision.submitFrame(this.shell.video, timestamp);
          this.lastInferenceSubmitAt = timestamp;
        }
      }
    };

    // Follow decoded camera frames when the browser exposes the video-frame
    // callback. The former 60 Hz animation loop repeatedly inspected the same
    // 30 fps image and added avoidable main-thread work beside Phaser.
    if (typeof this.shell.video.requestVideoFrameCallback === 'function') {
      const submitVideoFrame: VideoFrameRequestCallback = (timestamp) => {
        submitCurrentFrame(timestamp);
        if (this.cameraReady) {
          this.inferenceVideoFrameCallback =
            this.shell.video.requestVideoFrameCallback(submitVideoFrame);
        }
      };
      this.inferenceVideoFrameCallback =
        this.shell.video.requestVideoFrameCallback(submitVideoFrame);
      return;
    }

    const submitAnimationFrame = (timestamp: number): void => {
      submitCurrentFrame(timestamp);
      this.inferenceAnimation = requestAnimationFrame(submitAnimationFrame);
    };
    this.inferenceAnimation = requestAnimationFrame(submitAnimationFrame);
  }

  private stopInferenceLoop(): void {
    cancelAnimationFrame(this.inferenceAnimation);
    this.inferenceAnimation = 0;
    if (
      this.inferenceVideoFrameCallback !== 0 &&
      typeof this.shell.video.cancelVideoFrameCallback === 'function'
    ) {
      this.shell.video.cancelVideoFrameCallback(this.inferenceVideoFrameCallback);
    }
    this.inferenceVideoFrameCallback = 0;
  }

  private handlePoseFrame(frame: PoseFrame): void {
    this.lastPoseFrameReceivedAt = performance.now();
    this.lastPoseObservations = frame.poses;
    this.lastDetectedPoseCount = frame.detectedPoseCount ?? frame.poses.length;
    this.inferenceSamples.push(frame.inferenceMs);
    if (frame.performance) {
      this.pipelineSamples.push(frame.performance.pipelineMs);
      this.lastVisionPerformance = frame.performance;
    }
    this.inferenceTimestamps.push(performance.now());
    if (this.inferenceSamples.length > 240) this.inferenceSamples.shift();
    if (this.pipelineSamples.length > 240) this.pipelineSamples.shift();
    if (this.inferenceTimestamps.length > 240) this.inferenceTimestamps.shift();
    this.refreshDiagnostics();
    if (
      !this.tracker ||
      (this.screen !== 'calibration' && this.screen !== 'practice' && this.screen !== 'game')
    ) {
      this.shell.drawPoseObservations(frame.poses, true);
      return;
    }

    const tracked: AppTrackerFrameResult = this.tracker.update(frame.poses, frame.timestampMs);
    this.vision.reportTrackedPoseCount(
      Math.min(2, tracked.candidateDiagnostics.assignedCandidateCount),
    );
    this.lastTrackerFrame = tracked;
    const overlayAssignments = new Map<string, PoseOverlayAssignment>();
    tracked.players.forEach((player, index) => {
      if (player.sourceTemporaryId === null) return;
      const participant = this.currentPlayers?.find(
        ({ participant: current }) => current.id === player.participantId,
      )?.participant;
      overlayAssignments.set(player.sourceTemporaryId, {
        lane: player.lane,
        label: participant?.displayName || `P${index + 1}`,
        identityLocked: player.identity.locked,
      });
    });
    this.shell.drawPoseObservations(frame.poses, true, overlayAssignments);
    if (this.screen === 'calibration' && this.calibrationCollector) {
      // Extra candidates are spectators. The tracker has already selected the
      // bound participant(s), so spectators must not block their calibration.
      this.updateCalibrationHandReadiness(tracked);
      this.calibrationCollector.add(tracked);
      this.captureCompletedProfiles();
      if (performance.now() - this.lastCalibrationUiAt >= 120) {
        this.lastCalibrationUiAt = performance.now();
        this.updateCalibrationUi();
      }
    }
    if (this.currentRoundActive || this.screen === 'game') {
      this.updateCameraTrails(tracked);
      this.handleTrackingSafety(tracked);
    }
  }

  private renderSoloPracticeSetup(): void {
    this.resetVisibleGame();
    this.screen = 'solo-practice-setup';
    this.currentPlayers = null;
    const screen = this.shell.renderScreen(
      soloPracticeSetupScreen({
        playerName: this.soloPracticeParticipant?.displayName ?? '練習玩家',
        activeHand: this.soloPracticeParticipant?.activeHand ?? 'right',
        posture: this.soloPracticeParticipant?.posture ?? 'standing',
        difficulty: this.soloPracticeDifficulty,
        durationMs: this.soloPracticeDurationMs as 30_000 | 45_000 | 60_000,
      }),
    );
    requireElement<HTMLButtonElement>(screen, '#back-home').addEventListener('click', () => void this.renderHome());
    requireElement<HTMLFormElement>(screen, '#solo-practice-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const participant: Participant = {
        id: uniqueId('solo-practice'),
        displayName: String(form.get('playerName') || '練習玩家').trim() || '練習玩家',
        activeHand: String(form.get('activeHand')) as DominantHand,
        posture: String(form.get('posture')) as PlayerPosture,
        rankingEligible: false,
        createdAt: Date.now(),
      };
      const difficulty = String(form.get('difficulty')) as Difficulty;
      const requestedDuration = Number(form.get('duration'));
      const durationMs = [30_000, 45_000, 60_000].includes(requestedDuration)
        ? requestedDuration
        : 30_000;
      this.soloPracticeParticipant = participant;
      this.soloPracticeDifficulty = difficulty;
      this.soloPracticeDurationMs = durationMs;
      const runtime: RuntimePlayer[] = [{ participant, lane: 'left' }];
      this.beginCalibration(
        runtime,
        '單人練習',
        false,
        () => this.startSoloPracticeRound(),
        () => this.renderSoloPracticeSetup(),
      );
    });
  }

  private startSoloPracticeRound(): void {
    if (!this.soloPracticeParticipant) return;
    if (!this.currentPlayers?.some(({ participant }) => participant.id === this.soloPracticeParticipant?.id)) {
      this.currentPlayers = [{ participant: this.soloPracticeParticipant, lane: 'left' }];
    }
    if (!this.currentPlayers || !this.ensureFreshLockedIdentities(
      this.currentPlayers,
      '單人練習開始前身份確認',
      () => this.startSoloPracticeRound(),
    )) return;
    const pool = createHiddenScriptPool({
      masterSeed: `${Date.now()}:${this.soloPracticeParticipant.id}:solo`,
      version: 'solo-practice-v1',
      durationsMs: { reserve: this.soloPracticeDurationMs },
    });
    const script = pool.getScript(this.soloPracticeDifficulty, 'reserve', 0);
    this.startGameRound(
      {
        mode: 'solo-practice',
        phase: 'practice',
        difficulty: this.soloPracticeDifficulty,
        durationMs: this.soloPracticeDurationMs,
        players: this.currentPlayers,
        script,
        allowBothWrists: false,
      },
      'solo-practice',
    );
  }

  private renderCasualSetup(): void {
    this.screen = 'casual-setup';
    const screen = this.shell.renderScreen(casualSetupScreen());
    requireElement<HTMLButtonElement>(screen, '#back-home').addEventListener('click', () => void this.renderHome());
    requireElement<HTMLFormElement>(screen, '#casual-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const now = Date.now();
      const participants: [Participant, Participant] = [
        {
          id: uniqueId('casual-left'),
          displayName: String(form.get('leftName') || '藍隊玩家').trim(),
          activeHand: String(form.get('leftHand')) === 'left' ? 'left' : 'right',
          posture: 'standing',
          rankingEligible: true,
          createdAt: now,
        },
        {
          id: uniqueId('casual-right'),
          displayName: String(form.get('rightName') || '橘隊玩家').trim(),
          activeHand: String(form.get('rightHand')) === 'left' ? 'left' : 'right',
          posture: 'standing',
          rankingEligible: true,
          createdAt: now + 1,
        },
      ];
      const difficulty = String(form.get('difficulty')) as Difficulty;
      this.casualPlayers = participants;
      this.casualDifficulty = difficulty;
      const runtime: [RuntimePlayer, RuntimePlayer] = [
        { participant: participants[0], lane: 'left' },
        { participant: participants[1], lane: 'right' },
      ];
      this.beginCalibration(runtime, '休閒對戰', false, () => this.startCasualRound());
    });
  }

  private renderTournamentSetup(): void {
    this.screen = 'tournament-setup';
    const screen = this.shell.renderScreen(tournamentSetupScreen(), true);
    const textarea = requireElement<HTMLTextAreaElement>(screen, '#roster-input');
    const count = requireElement<HTMLElement>(screen, '#roster-count');
    const updateCount = (): void => {
      count.textContent = `${this.parseRoster(textarea.value).length} / 30`;
    };
    textarea.addEventListener('input', updateCount);
    requireElement<HTMLButtonElement>(screen, '#fill-sample-roster').addEventListener('click', () => {
      textarea.value = Array.from({ length: 13 }, (_, index) =>
        `參賽者 ${String(index + 1).padStart(2, '0')} | ${index % 2 === 0 ? 'R' : 'L'} | ${index % 4 === 3 ? 'seated' : 'standing'}`,
      ).join('\n');
      updateCount();
    });
    requireElement<HTMLButtonElement>(screen, '#back-home').addEventListener('click', () => void this.renderHome());
    requireElement<HTMLFormElement>(screen, '#tournament-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.createTournament(new FormData(event.currentTarget as HTMLFormElement), textarea.value);
    });
  }

  private parseRoster(value: string): ParticipantDraft[] {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [namePart = '', handPart = 'R', posturePart = 'standing'] = line.split('|').map((part) => part.trim());
        return {
          displayName: namePart,
          activeHand: /^l/i.test(handPart) ? 'left' : 'right',
          posture: /^(seated|坐)/i.test(posturePart) ? 'seated' : 'standing',
        } satisfies ParticipantDraft;
      });
  }

  private async createTournament(form: FormData, rosterText: string): Promise<void> {
    try {
      const participants = this.parseRoster(rosterText);
      const difficulty = String(form.get('difficulty')) as Difficulty;
      const title = String(form.get('title') || '').trim();
      const eventId = uniqueId('event');
      this.scriptResources = this.buildScriptResources(eventId, difficulty, 'balanced-v1');
      this.manager = TournamentManager.create(
        {
          eventId,
          title,
          difficulty,
          scriptPoolVersion: this.scriptResources.pool.version,
          participants,
          seed: Date.now() & 0x7fffffff,
          intermissionMs: 30_000,
          practiceDurationMs: 10_000,
          pacerName: '不計分陪玩員',
        },
        this.scriptResources.ids,
      );
      const qualifierHeatCount = this.manager.getQualifierHeats().length;
      this.flow = new AppFlowStateMachine(qualifierHeatCount);
      this.flow.send('approve-device');
      this.flow.send('lock-roster');
      this.currentHeatId = this.manager.getQualifierHeats()[0]?.id ?? null;
      this.practicedHeatIds.clear();
      this.tiebreakContext = null;
      await this.saveEvent();
      this.prepareCurrentTournamentHalf();
    } catch (error) {
      this.shell.toast(error instanceof Error ? error.message : '無法建立賽事。', 'error', 6000);
    }
  }

  private buildScriptResources(eventId: string, difficulty: Difficulty, version: string): ScriptResources {
    const pool = createHiddenScriptPool({
      masterSeed: eventId,
      version,
      durationsMs: { qualifier: 25_000, final: 30_000, reserve: 10_000 },
    });
    const registry = new Map<string, ScriptDefinition>();
    const createTier = (tier: 'qualifier' | 'final' | 'reserve'): string[] =>
      Array.from({ length: SCRIPT_POOL_SIZES[tier] }, (_, index) => {
        const script = pool.getScript(difficulty, tier, index);
        registry.set(script.id, script);
        return script.id;
      });
    const qualifier = createTier('qualifier');
    const final = createTier('final');
    const tiebreak = createTier('reserve');
    const practicePool = createHiddenScriptPool({
      masterSeed: `${eventId}:practice`,
      version: `${version}-practice`,
      durationsMs: { reserve: 10_000 },
    });
    return { pool, registry, ids: { qualifier, final, tiebreak }, practicePool };
  }

  private beginCalibration(
    players: RuntimePlayer[],
    halfLabel: string,
    allowBothWrists: boolean,
    continuation: () => void,
    cancel: () => void = () => void this.renderHome(),
  ): void {
    if (players.length < 1 || players.length > 2) {
      throw new Error('校正只支援一位或兩位玩家。');
    }
    this.vision.setExpectedPoseCount(players.length as 1 | 2);
    this.currentPlayers = players;
    this.calibrationContinuation = continuation;
    const bindings = players.map(({ participant, lane }) => ({
      participantId: participant.id,
      lane,
      activeHand: participant.activeHand,
    })) as PlayerTrackBinding[];
    this.tracker = bindings.length === 1
      ? new SinglePlayerTracker(bindings[0]!, { mirrored: true, allowBothWrists })
      : new TwoPlayerTracker(bindings as [PlayerTrackBinding, PlayerTrackBinding], {
          mirrored: true,
          allowBothWrists,
        });
    this.calibrationCollector = new CalibrationCollector(bindings, { minimumSamples: 24, maximumSamples: 90 });
    this.calibrationProfiles.clear();
    this.adaptiveCalibration.clear();
    this.trailStates.clear();
    this.lastTrackerFrame = null;
    this.lastPoseObservations = [];
    this.lastDetectedPoseCount = 0;
    this.calibrationProgressWatch.clear();
    this.calibrationHandReadyFrames.clear();
    this.calibrationIdentityLocked = false;
    for (const { participant } of players) {
      this.calibrationHandReadyFrames.set(participant.id, 0);
    }
    this.screen = 'calibration';
    const views = this.calibrationViews(players);
    const screen = this.shell.renderScreen(
      calibrationScreen(views, { halfLabel, demoMode: this.demoMode }),
      true,
    );
    requireElement<HTMLButtonElement>(screen, '#cancel-calibration').addEventListener('click', cancel);
    requireElement<HTMLButtonElement>(screen, '#approve-calibration').addEventListener('click', () => {
      if (!this.demoMode && this.calibrationProfiles.size < players.length) {
        this.shell.toast(
          players.length === 1
            ? '請等待頭、肩、身體、手肘與主手完成穩定校正。'
            : '請等待兩位玩家都完成穩定校正。',
          'error',
        );
        return;
      }
      if (!this.demoMode && !this.calibrationIdentityLocked) {
        this.shell.toast(
          '頭部身份錨點尚未封存，請讓兩位玩家的頭部與雙肩保持清楚入鏡。',
          'error',
        );
        return;
      }
      if (!this.demoMode && !this.calibrationHandsReady()) {
        this.shell.toast(
          players.length === 1
            ? '身體校正已完成，請讓指定主手穩定出現並達到可切擊狀態。'
            : '身體校正已完成，請讓兩位玩家的指定主手都穩定達到可切擊狀態。',
          'error',
        );
        return;
      }
      const next = this.calibrationContinuation;
      this.calibrationContinuation = null;
      next?.();
    });
  }

  private calibrationViews(players: RuntimePlayer[]): CalibrationPlayerView[] {
    return players.map(({ participant, lane }) => ({
      participant,
      lane,
      progress: this.demoMode ? 1 : (this.calibrationCollector?.progress(participant.id) ?? 0),
    }));
  }

  private captureCompletedProfiles(): void {
    if (!this.calibrationCollector || !this.currentPlayers) return;
    for (const { participant } of this.currentPlayers) {
      if (this.calibrationProfiles.has(participant.id)) continue;
      const profile = this.calibrationCollector.finalize(participant.id);
      if (profile) {
        this.calibrationProfiles.set(participant.id, profile);
        this.adaptiveCalibration.seed(profile);
      }
    }
    if (
      !this.calibrationIdentityLocked &&
      this.tracker &&
      this.calibrationProfiles.size === this.currentPlayers.length
    ) {
      const profiles = this.currentPlayers.map(({ participant }) =>
        this.calibrationProfiles.get(participant.id),
      );
      if (profiles.every((profile): profile is CalibrationProfile => profile !== undefined)) {
        this.tracker.lockIdentities(profiles);
        this.calibrationIdentityLocked = true;
        for (const { participant } of this.currentPlayers) {
          this.calibrationHandReadyFrames.set(participant.id, 0);
        }
      }
    }
  }

  private updateCalibrationHandReadiness(frame: AppTrackerFrameResult): void {
    if (!this.currentPlayers) return;
    for (const { participant } of this.currentPlayers) {
      const player = frame.players.find(
        ({ participantId }) => participantId === participant.id,
      );
      const ready =
        player?.state === 'tracking' &&
        player.identity.locked &&
        player.identity.headMatched &&
        player.activeWrist !== null &&
        player.confidence >= 0.55;
      const previous = this.calibrationHandReadyFrames.get(participant.id) ?? 0;
      this.calibrationHandReadyFrames.set(
        participant.id,
        ready ? Math.min(CALIBRATION_HAND_READY_FRAMES, previous + 1) : 0,
      );
    }
  }

  private calibrationHandsReady(): boolean {
    if (!this.currentPlayers) return false;
    return this.currentPlayers.every(
      ({ participant }) =>
        (this.calibrationHandReadyFrames.get(participant.id) ?? 0) >=
        CALIBRATION_HAND_READY_FRAMES,
    );
  }

  private updateCalibrationUi(): void {
    if (!this.currentPlayers || this.screen !== 'calibration') return;
    for (const { participant } of this.currentPlayers) {
      const card = this.root.querySelector<HTMLElement>(`[data-player-id="${CSS.escape(participant.id)}"]`);
      const state = card?.querySelector<HTMLElement>('.calibration-state');
      const progress = this.calibrationCollector?.progress(participant.id) ?? 0;
      if (state) {
        state.textContent = progress >= 1 ? '✓ 校正完成' : `${Math.round(progress * 100)}% 偵測中`;
        state.classList.toggle('is-ready', progress >= 1);
      }
    }
    const approve = this.root.querySelector<HTMLButtonElement>('#approve-calibration');
    if (approve) {
      approve.disabled =
        !this.demoMode &&
        (this.calibrationProfiles.size < this.currentPlayers.length ||
          !this.calibrationIdentityLocked ||
          !this.calibrationHandsReady());
    }

    this.updateCalibrationDiagnostics();
  }

  private updateCalibrationDiagnostics(): void {
    if (!this.currentPlayers || this.screen !== 'calibration') return;
    const frame = this.lastTrackerFrame;
    const expectedPlayers = this.currentPlayers.length;
    const nowMs = performance.now();
    const performanceSnapshot = summarizeCalibrationPerformance({
      inferenceSamples: this.inferenceSamples,
      pipelineSamples: this.pipelineSamples,
      inferenceTimestamps: this.inferenceTimestamps,
      nowMs,
      ...(this.lastVisionPerformance?.backend === undefined
        ? {}
        : { backend: this.lastVisionPerformance.backend }),
    });
    const rawPoseCount = this.lastDetectedPoseCount;
    const acceptedCandidateCount = frame?.candidateDiagnostics.acceptedCandidateCount ?? 0;
    const assignedPlayerCount = frame?.candidateDiagnostics.assignedCandidateCount ?? 0;
    const lockedPlayerCount = frame?.players.filter(
      ({ identity }) => identity.locked,
    ).length ?? 0;

    let recognizedHandCount = 0;
    let calibrationStalled = false;
    for (const { participant } of this.currentPlayers) {
      const player = frame?.players.find(
        ({ participantId }) => participantId === participant.id,
      );
      const sourceObservation = player?.sourceTemporaryId === null || player?.sourceTemporaryId === undefined
        ? undefined
        : this.lastPoseObservations.find(
            ({ temporaryId }) => temporaryId === player.sourceTemporaryId,
          );
      const quality = player?.poseQuality ?? sourceObservation?.quality;
      // Match the value that the scoring trail receives. This already includes
      // player lock, structural support, active-arm confidence and the guarded
      // current-frame blade.
      const handConfidence = player?.confidence ?? 0;
      const handRecognized =
        player?.state === 'tracking' &&
        player.activeWrist !== null &&
        handConfidence >= 0.55;
      if (handRecognized) recognizedHandCount += 1;

      const progress = this.calibrationCollector?.progress(participant.id) ?? 0;
      const watchedProgress = this.calibrationProgressWatch.get(participant.id);
      if (
        watchedProgress === undefined ||
        progress > watchedProgress.progress + 0.001 ||
        player?.state !== 'tracking' ||
        progress >= 1
      ) {
        this.calibrationProgressWatch.set(participant.id, {
          progress,
          lastAdvancedAt: nowMs,
        });
      } else if (nowMs - watchedProgress.lastAdvancedAt >= 1_500) {
        calibrationStalled = true;
      }

      const card = this.root.querySelector<HTMLElement>(
        `[data-player-id="${CSS.escape(participant.id)}"]`,
      );
      const qualityElement = card?.querySelector<HTMLElement>('[data-player-quality]');
      const reliableElement = card?.querySelector<HTMLElement>('[data-player-reliable]');
      const handElement = card?.querySelector<HTMLElement>('[data-player-hand]');
      const trackingElement = card?.querySelector<HTMLElement>('[data-player-tracking]');
      if (qualityElement) {
        qualityElement.textContent = quality === undefined
          ? '—'
          : `${Math.round(quality.score * 100)}%`;
      }
      if (reliableElement) {
        reliableElement.textContent = `${quality?.reliableLandmarkCount ?? 0}/${POSE_QUALITY_LANDMARK_COUNT}`;
      }
      if (handElement) {
        handElement.textContent = `${Math.round(handConfidence * 100)}% ${handRecognized ? '✓ 可切擊' : '未就緒'}`;
        handElement.classList.toggle('is-ready', handRecognized);
      }
      if (trackingElement) {
        trackingElement.textContent = player === undefined
          ? '等待分配'
          : player.identity.state === 'locked'
            ? '🔒 頭部身份已封存'
            : player.identity.state === 'recalibration-required'
              ? '身份需重新校正'
              : player.identity.state === 'occluded'
                ? '頭部暫時遮擋'
                : player.state === 'tracking'
                  ? '本幀已追蹤，等待封存'
                  : player.state === 'acquiring'
                    ? '取得頭部錨點中'
                    : player.state === 'holding'
                      ? '短暫遮擋'
                      : '已失追';
      }
    }

    const health = assessCalibrationHealth({
      expectedPlayers,
      rawPoseCount,
      acceptedCandidateCount,
      assignedPlayerCount,
      lockedPlayerCount,
      recognizedHandCount,
      calibrationStalled,
      performance: performanceSnapshot,
    });
    const diagnostics = this.root.querySelector<HTMLElement>('[data-calibration-diagnostics]');
    if (!diagnostics) return;
    diagnostics.dataset['health'] = health.code;
    const setText = (selector: string, value: string): void => {
      const element = diagnostics.querySelector<HTMLElement>(selector);
      if (element) element.textContent = value;
    };
    setText('[data-diag-health-label]', health.label);
    setText('[data-diag-health-instruction]', health.instruction);
    setText('[data-diag-raw]', String(rawPoseCount));
    setText('[data-diag-accepted]', `${acceptedCandidateCount}/${expectedPlayers}`);
    setText('[data-diag-assigned]', `${assignedPlayerCount}/${expectedPlayers}`);
    setText('[data-diag-locked]', `${lockedPlayerCount}/${expectedPlayers}`);
    setText(
      '[data-diag-throughput]',
      `${performanceSnapshot.backend.toUpperCase()} · ${performanceSnapshot.fps.toFixed(1)} FPS`,
    );
    setText(
      '[data-diag-latency]',
      `推論 ${performanceSnapshot.inferenceP95Ms.toFixed(0)} / 全流程 ${performanceSnapshot.pipelineP95Ms.toFixed(0)} ms`,
    );
  }

  private hasFreshLockedIdentities(players: readonly RuntimePlayer[]): boolean {
    return this.tracker !== null && hasFreshLockedIdentityFrame(
      this.lastTrackerFrame,
      players.map(({ participant }) => participant.id),
      performance.now(),
      TRACKING_PAUSE_MS,
    );
  }

  private ensureFreshLockedIdentities(
    players: RuntimePlayer[],
    label: string,
    continuation: () => void,
  ): boolean {
    if (this.demoMode || this.hasFreshLockedIdentities(players)) return true;
    this.shell.toast('開始前的頭部身份確認已逾時，請重新站定位。', 'info', 4000);
    this.beginCalibration(players, label, false, continuation);
    return false;
  }

  private startCasualRound(): void {
    if (!this.casualPlayers || !this.currentPlayers) return;
    if (!this.ensureFreshLockedIdentities(
      this.currentPlayers,
      '休閒對戰開始前身份確認',
      () => this.startCasualRound(),
    )) return;
    const pool = createHiddenScriptPool({
      masterSeed: `${Date.now()}:casual`,
      version: 'casual-v1',
      durationsMs: { reserve: 45_000 },
    });
    const script = pool.getScript(this.casualDifficulty, 'reserve', 0);
    this.startGameRound(
      {
        mode: 'casual',
        phase: 'practice',
        difficulty: this.casualDifficulty,
        durationMs: 45_000,
        players: this.currentPlayers,
        script,
        allowBothWrists: false,
      },
      'casual',
    );
  }

  private prepareCurrentTournamentHalf(): void {
    if (!this.manager || !this.currentHeatId) return;
    const assignment = this.manager.getHalfAssignment(this.currentHeatId);
    this.currentAssignment = assignment;
    const snapshot = this.manager.snapshot();
    const players = assignment.players.map(({ participantId, lane }) => {
      const participant = snapshot.participants.find(({ id }) => id === participantId);
      if (!participant) throw new TournamentRuleError(`找不到玩家 ${participantId}`);
      return { participant, lane };
    });
    if (players.length !== 2) throw new TournamentRuleError('雙人場次必須有兩位追蹤對象');
    const runtime = players as [RuntimePlayer, RuntimePlayer];
    const label = `${assignment.phase === 'final' ? '冠軍賽' : assignment.phase === 'tiebreak' ? '加賽' : '預賽'} · 第 ${assignment.halfIndex + 1} 小局`;
    this.beginCalibration(runtime, label, false, () => this.afterTournamentCalibration());
  }

  private afterTournamentCalibration(): void {
    if (!this.manager || !this.currentAssignment || !this.currentPlayers) return;
    if (this.currentAssignment.phase !== 'tiebreak' && this.flow?.can('approve-calibration')) {
      this.flow.send('approve-calibration');
    }
    if (
      this.currentAssignment.halfIndex === 0 &&
      !this.practicedHeatIds.has(this.currentAssignment.heatId)
    ) {
      this.renderPracticeReady();
    } else {
      this.startTournamentRound();
    }
  }

  private renderPracticeReady(): void {
    if (!this.manager || !this.currentPlayers) return;
    this.screen = 'practice';
    const durationMs = this.manager.snapshot().config.practiceDurationMs;
    const screen = this.shell.renderScreen(
      practiceReadyScreen(this.currentPlayers.map(({ participant }) => participant), durationMs),
    );
    requireElement<HTMLButtonElement>(screen, '#start-practice').addEventListener('click', () => this.startPracticeRound());
  }

  private startPracticeRound(): void {
    if (!this.manager || !this.scriptResources || !this.currentPlayers || !this.currentHeatId) return;
    if (!this.ensureFreshLockedIdentities(
      this.currentPlayers,
      '練習開始前身份確認',
      () => this.startPracticeRound(),
    )) return;
    const event = this.manager.snapshot();
    const heatIndex = Math.max(0, event.heats.findIndex(({ id }) => id === this.currentHeatId));
    const script = this.scriptResources.practicePool.getScript(
      event.config.difficulty,
      'reserve',
      heatIndex % SCRIPT_POOL_SIZES.reserve,
    );
    this.startGameRound(
      {
        mode: 'tournament',
        phase: 'practice',
        difficulty: event.config.difficulty,
        durationMs: event.config.practiceDurationMs,
        players: this.currentPlayers,
        script,
        allowBothWrists: false,
      },
      'practice',
    );
  }

  private renderFormalReady(): void {
    if (!this.currentPlayers || !this.currentAssignment) return;
    this.screen = 'practice';
    const screen = this.shell.renderScreen(`
      <p class="eyebrow">PRACTICE COMPLETE</p>
      <h2>練習完成，正式小局即將開始</h2>
      <p class="lead">分數已歸零。接下來的腳本未曾曝光，倒數後才開始計分。</p>
      <div class="button-row"><button class="btn btn-primary" id="start-official" type="button">開始正式倒數</button></div>
    `);
    requireElement<HTMLButtonElement>(screen, '#start-official').addEventListener('click', () => {
      this.startTournamentRound();
    });
  }

  private startTournamentRound(): void {
    if (!this.manager || !this.currentAssignment || !this.currentPlayers || !this.scriptResources) return;
    if (!this.ensureFreshLockedIdentities(
      this.currentPlayers,
      '正式小局開始前身份確認',
      () => this.startTournamentRound(),
    )) return;
    if (this.currentAssignment.phase !== 'tiebreak' && this.flow?.can('start-countdown')) {
      this.flow.send('start-countdown');
    }
    const assignment = this.manager.beginHalf(this.currentAssignment.heatId);
    this.currentAssignment = assignment;
    const script = this.scriptResources.registry.get(assignment.scriptId);
    if (!script) throw new TournamentRuleError(`找不到鎖定腳本 ${assignment.scriptId}`);
    const event = this.manager.snapshot();
    this.startGameRound(
      {
        mode: 'tournament',
        phase: assignment.phase,
        difficulty: event.config.difficulty,
        durationMs: assignment.durationMs,
        players: this.currentPlayers,
        script,
        allowBothWrists: false,
      },
      'tournament',
    );
  }

  private startGameRound(config: GameRoundConfig, kind: RoundKind): void {
    if (!this.demoMode && !this.hasFreshLockedIdentities(config.players)) {
      this.shell.toast('玩家頭部身份尚未封存，請先重新校正。', 'error', 5000);
      return;
    }
    this.vision.setExpectedPoseCount(config.players.length as 1 | 2);
    this.lastPoseFrameReceivedAt = performance.now();
    this.clearTrackingSafetyTimers();
    this.trackingWarnedPlayers.clear();
    this.trackingRecalibrationActive = false;
    this.trackingRecoveryAnnounced = false;
    this.currentRoundKind = kind;
    this.currentRoundActive = false;
    this.gamePaused = false;
    this.trackingPaused = false;
    this.latestRoundResult = null;
    this.activeScores = Object.fromEntries(config.players.map(({ participant }) => [participant.id, EMPTY_SCORE()]));
    this.trackingPauses = Object.fromEntries(config.players.map(({ participant }) => [participant.id, 0]));
    this.remainingMs = config.durationMs;
    this.trailStates.clear();
    this.screen = 'game';
    this.shell.setSoloArena(config.players.length === 1);
    this.shell.clearScreen();
    this.shell.showGameChrome(true);
    this.renderHud();
    this.bindHostControls(kind);
    void this.game.prepareRound(config, 3);
  }

  private bindHostControls(kind: RoundKind): void {
    const dock = this.shell.setHostControls(`
      <button class="btn btn-ghost" id="host-pause" type="button">暫停</button>
      <button class="btn btn-danger" id="host-abort" type="button">${kind === 'tournament' ? '技術中止本局' : '結束遊戲'}</button>
      <button class="btn btn-ghost" id="host-diagnostics" type="button">效能</button>
    `);
    requireElement<HTMLButtonElement>(dock, '#host-pause').addEventListener('click', () => {
      if (this.gamePaused) this.resumeGame();
      else this.pauseGame('主持人暫停', false);
    });
    requireElement<HTMLButtonElement>(dock, '#host-abort').addEventListener('click', () => void this.abortCurrentRound());
    requireElement<HTMLButtonElement>(dock, '#host-diagnostics').addEventListener('click', () => this.toggleDiagnostics());
  }

  private onRoundStarted(): void {
    this.currentRoundActive = true;
    if (
      this.currentRoundKind === 'tournament' &&
      this.currentAssignment?.phase !== 'tiebreak' &&
      this.flow?.can('start-half')
    ) {
      this.flow.send('start-half');
    }
  }

  private async onRoundFinished(payload: RoundFinishedPayload): Promise<void> {
    this.currentRoundActive = false;
    this.latestRoundResult = payload;
    this.resetVisibleGame();

    if (this.currentRoundKind === 'practice') {
      if (this.currentHeatId) this.practicedHeatIds.add(this.currentHeatId);
      this.renderFormalReady();
      return;
    }
    if (this.currentRoundKind === 'solo-practice') {
      this.renderSoloPracticeResults(payload);
      return;
    }
    if (this.currentRoundKind === 'casual') {
      this.renderCasualResults(payload);
      return;
    }
    if (!this.manager || !this.currentAssignment) return;

    try {
      this.manager.recordHalfResult(this.currentAssignment.heatId, payload, {
        trackingPauses: this.trackingPauses,
      });
      if (this.currentAssignment.phase !== 'tiebreak' && this.flow?.can('finish-half')) {
        this.flow.send('finish-half');
      }
      await this.saveEvent();
      this.renderTournamentReview();
    } catch (error) {
      this.shell.toast(error instanceof Error ? error.message : '成績寫入失敗。', 'error', 6000);
    }
  }

  private renderSoloPracticeResults(payload: RoundFinishedPayload): void {
    if (!this.soloPracticeParticipant) return;
    this.screen = 'review';
    const score = payload.scores[this.soloPracticeParticipant.id] ?? EMPTY_SCORE();
    const screen = this.shell.renderScreen(
      soloPracticeResultScreen(
        this.soloPracticeParticipant,
        score,
        this.soloPracticeDurationMs,
        this.soloPracticeDifficulty,
      ),
    );
    requireElement<HTMLButtonElement>(screen, '#solo-replay').addEventListener('click', () => {
      if (!this.currentPlayers) return;
      this.beginCalibration(
        this.currentPlayers,
        '單人重玩身份確認',
        false,
        () => this.startSoloPracticeRound(),
        () => this.renderSoloPracticeSetup(),
      );
    });
    requireElement<HTMLButtonElement>(screen, '#solo-settings').addEventListener('click', () => {
      this.renderSoloPracticeSetup();
    });
    requireElement<HTMLButtonElement>(screen, '#solo-home').addEventListener('click', () => {
      void this.renderHome();
    });
  }

  private renderCasualResults(payload: RoundFinishedPayload): void {
    if (!this.casualPlayers) return;
    this.screen = 'review';
    const screen = this.shell.renderScreen(`
      <p class="eyebrow">CASUAL RESULT</p><h2>休閒對戰結果</h2>
      <div class="result-grid">
        ${this.casualPlayers.map((player) => {
          const score = payload.scores[player.id] ?? EMPTY_SCORE();
          return `<article class="result-card"><p class="eyebrow">${player.displayName}</p><div class="hud-points">${score.score.toLocaleString()}</div><p>水果 ${score.fruitHits} · 漏果 ${score.fruitMisses} · 炸彈 ${score.bombsHit} · 連擊 ${score.maxCombo}</p></article>`;
        }).join('')}
      </div>
      <div class="button-row" style="margin-top: 24px"><button class="btn btn-primary" id="casual-replay">再玩一次</button><button class="btn btn-ghost" id="casual-home">回主畫面</button></div>
    `);
    requireElement<HTMLButtonElement>(screen, '#casual-replay').addEventListener('click', () => {
      if (!this.currentPlayers) return;
      this.beginCalibration(
        this.currentPlayers,
        '休閒重玩身份確認',
        false,
        () => this.startCasualRound(),
      );
    });
    requireElement<HTMLButtonElement>(screen, '#casual-home').addEventListener('click', () => void this.renderHome());
  }

  private renderTournamentReview(): void {
    if (!this.currentPlayers || !this.currentAssignment || !this.latestRoundResult) return;
    this.screen = 'review';
    const label = `${this.currentAssignment.phase.toUpperCase()} · 第 ${this.currentAssignment.halfIndex + 1} 小局`;
    const screen = this.shell.renderScreen(
      reviewScreen(
        this.currentPlayers.map(({ participant }) => participant),
        this.latestRoundResult.scores,
        label,
      ),
    );
    requireElement<HTMLButtonElement>(screen, '#confirm-result').addEventListener('click', () => void this.confirmTournamentResult());
    requireElement<HTMLButtonElement>(screen, '#void-result').addEventListener('click', () => {
      const reason = requireElement<HTMLInputElement>(screen, '#void-reason').value.trim();
      if (!reason) {
        this.shell.toast('技術作廢必須填寫原因。', 'error');
        return;
      }
      void this.voidTournamentResult(reason);
    });
  }

  private async confirmTournamentResult(): Promise<void> {
    if (!this.manager || !this.currentAssignment || !this.currentPlayers) return;
    try {
      const halfIndex = this.currentAssignment.halfIndex;
      const phase = this.currentAssignment.phase;
      this.manager.confirmHalf(this.currentAssignment.heatId);
      if (phase !== 'tiebreak' && this.flow?.can('confirm-half')) this.flow.send('confirm-half');
      await this.saveEvent();

      if (halfIndex === 0) {
        this.renderSwap();
        return;
      }
      if (phase === 'tiebreak') {
        await this.resolveCompletedTiebreak();
        return;
      }
      if (phase === 'final') {
        await this.finishFinalOrStartTiebreak();
        return;
      }
      this.renderLeaderboard();
    } catch (error) {
      this.shell.toast(error instanceof Error ? error.message : '無法確認成績。', 'error', 6000);
    }
  }

  private async voidTournamentResult(reason: string): Promise<void> {
    if (!this.manager || !this.currentAssignment) return;
    try {
      this.manager.voidHalfAndRedraw(this.currentAssignment.heatId, reason);
      if (this.currentAssignment.phase !== 'tiebreak' && this.flow?.can('void-half')) {
        this.flow.send('void-half');
      }
      await this.saveEvent();
      this.shell.toast('本局已作廢並抽取新的未曝光腳本。', 'info');
      this.prepareCurrentTournamentHalf();
    } catch (error) {
      this.shell.toast(error instanceof Error ? error.message : '無法重設本局。', 'error');
    }
  }

  private renderSwap(): void {
    if (!this.manager || !this.currentPlayers) return;
    this.screen = 'swap';
    const seconds = Math.max(0, Math.round(this.manager.snapshot().config.intermissionMs / 1000));
    const screen = this.shell.renderScreen(
      swapScreen(this.currentPlayers.map(({ participant }) => participant), seconds),
    );
    const timer = requireElement<HTMLElement>(screen, '#swap-timer');
    const button = requireElement<HTMLButtonElement>(screen, '#confirm-swap');
    const endAt = Date.now() + seconds * 1000;
    if (this.swapTimer !== null) window.clearInterval(this.swapTimer);
    const update = (): void => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      timer.textContent = String(remaining);
      if (remaining <= 0) {
        button.disabled = false;
        if (this.swapTimer !== null) window.clearInterval(this.swapTimer);
        this.swapTimer = null;
      }
    };
    update();
    this.swapTimer = window.setInterval(update, 250);
    button.addEventListener('click', () => {
      if (this.currentAssignment?.phase !== 'tiebreak' && this.flow?.can('confirm-swap')) {
        this.flow.send('confirm-swap');
      }
      this.prepareCurrentTournamentHalf();
    });
  }

  private renderLeaderboard(): void {
    if (!this.manager) return;
    this.screen = 'leaderboard';
    const event = this.manager.snapshot();
    const allQualifiersDone = this.manager.getQualifierHeats().every(({ status }) => status === 'completed');
    const entries = this.manager.getLeaderboard(event.phase === 'final' ? 'final' : 'qualifier');
    const screen = this.shell.renderScreen(
      leaderboardScreen(event.config.title, entries, {
        allQualifiersDone,
        finalActive: event.phase === 'final',
      }),
      true,
    );
    screen.querySelector<HTMLButtonElement>('#next-heat')?.addEventListener('click', () => {
      if (this.flow?.can('next-qualifier')) this.flow.send('next-qualifier');
      this.currentHeatId = this.manager?.getQualifierHeats().find(({ status }) => status !== 'completed')?.id ?? null;
      this.prepareCurrentTournamentHalf();
    });
    screen.querySelector<HTMLButtonElement>('#start-final')?.addEventListener('click', () => void this.startFinalOrTiebreak());
    screen.querySelector<HTMLButtonElement>('#continue-final')?.addEventListener('click', () => {
      this.currentHeatId = this.manager?.getFinalHeat()?.id ?? null;
      this.prepareCurrentTournamentHalf();
    });
    requireElement<HTMLButtonElement>(screen, '#return-home').addEventListener('click', () => void this.renderHome());
  }

  private async startFinalOrTiebreak(): Promise<void> {
    if (!this.manager) return;
    try {
      const finalHeat = this.manager.startFinal();
      if (this.flow?.can('start-final')) this.flow.send('start-final');
      if (this.flow?.can('prepare-final')) this.flow.send('prepare-final');
      this.currentHeatId = finalHeat.id;
      await this.saveEvent();
      this.prepareCurrentTournamentHalf();
    } catch (error) {
      if (error instanceof TournamentTieError) {
        await this.startQualifierTiebreak();
        return;
      }
      this.shell.toast(error instanceof Error ? error.message : '無法啟動冠軍賽。', 'error');
    }
  }

  private async startQualifierTiebreak(): Promise<void> {
    if (!this.manager) return;
    const leaderboard = this.manager.getLeaderboard('qualifier');
    const safe = leaderboard[0];
    const second = leaderboard[1];
    const third = leaderboard[2];
    if (!safe || !second || !third) throw new TournamentRuleError('找不到需要加賽的入圍線玩家');
    const heat = this.manager.startTiebreak([second.participantId, third.participantId], 'qualifier');
    this.tiebreakContext = { purpose: 'qualifier', safeFinalistId: safe.participantId };
    this.currentHeatId = heat.id;
    await this.saveEvent();
    this.shell.toast('入圍線同分：進行兩個 10 秒換邊加賽。', 'info', 5000);
    this.prepareCurrentTournamentHalf();
  }

  private async finishFinalOrStartTiebreak(): Promise<void> {
    if (!this.manager) return;
    try {
      const champion = this.manager.finalizeChampion();
      await this.saveEvent();
      this.renderChampion(champion);
    } catch (error) {
      if (!(error instanceof TournamentTieError)) throw error;
      const final = this.manager.getFinalHeat();
      if (!final?.participantIds[0] || !final.participantIds[1]) {
        throw new TournamentRuleError('找不到決賽兩位玩家');
      }
      const heat = this.manager.startTiebreak(
        [final.participantIds[0], final.participantIds[1]],
        'final',
      );
      this.tiebreakContext = { purpose: 'final' };
      this.currentHeatId = heat.id;
      await this.saveEvent();
      this.shell.toast('冠軍賽同分：進行兩個 10 秒換邊加賽。', 'info', 5000);
      this.prepareCurrentTournamentHalf();
    }
  }

  private async resolveCompletedTiebreak(): Promise<void> {
    if (!this.manager || !this.currentHeatId) return;
    try {
      const winner = this.manager.resolveTiebreak(this.currentHeatId);
      const context = this.tiebreakContext ?? this.inferTiebreakContext(this.currentHeatId);
      if (context.purpose === 'qualifier') {
        const safeId = context.safeFinalistId ?? this.manager.getLeaderboard('qualifier')[0]?.participantId;
        if (!safeId) throw new TournamentRuleError('找不到安全入圍者');
        const final = this.manager.startFinal([safeId, winner.id]);
        this.currentHeatId = final.id;
        this.tiebreakContext = null;
        await this.saveEvent();
        this.prepareCurrentTournamentHalf();
      } else {
        const champion = this.manager.finalizeChampion(winner.id);
        this.tiebreakContext = null;
        await this.saveEvent();
        this.renderChampion(champion);
      }
    } catch (error) {
      if (error instanceof TournamentTieError) {
        const current = this.manager.snapshot().heats.find(({ id }) => id === this.currentHeatId);
        if (!current?.participantIds[0] || !current.participantIds[1]) throw error;
        const context = this.tiebreakContext ?? this.inferTiebreakContext(current.id);
        const next = this.manager.startTiebreak(
          [current.participantIds[0], current.participantIds[1]],
          context.purpose,
        );
        this.currentHeatId = next.id;
        await this.saveEvent();
        this.shell.toast('加賽仍同分，已抽取新腳本再次加賽。', 'info');
        this.prepareCurrentTournamentHalf();
        return;
      }
      throw error;
    }
  }

  private inferTiebreakContext(heatId: string): TiebreakContext {
    const purpose: TiebreakPurpose = heatId.includes('-tiebreak-final-') ? 'final' : 'qualifier';
    const safeFinalistId = purpose === 'qualifier' ? this.manager?.getLeaderboard('qualifier')[0]?.participantId : undefined;
    return safeFinalistId === undefined ? { purpose } : { purpose, safeFinalistId };
  }

  private renderChampion(champion: Participant): void {
    if (!this.manager) return;
    this.screen = 'champion';
    this.audio.play('victory');
    const entries = this.manager.getLeaderboard('final');
    const screen = this.shell.renderScreen(championScreen(champion, entries), true);
    requireElement<HTMLButtonElement>(screen, '#finish-event').addEventListener('click', () => {
      void this.eventStore.clear().then(() => {
        this.savedEvent = null;
        this.manager = null;
        this.flow = null;
        this.scriptResources = null;
        void this.renderHome();
      });
    });
  }

  private async abortCurrentRound(reason = '主持人技術中止'): Promise<void> {
    this.game.abort();
    this.currentRoundActive = false;
    this.resetVisibleGame();
    if (this.currentRoundKind === 'solo-practice') {
      this.renderSoloPracticeSetup();
      return;
    }
    if (this.currentRoundKind !== 'tournament' || !this.manager || !this.currentAssignment) {
      await this.renderHome();
      return;
    }
    try {
      this.manager.abortHalfAndRedraw(this.currentAssignment.heatId, reason);
      if (this.currentAssignment.phase !== 'tiebreak' && this.flow?.can('abort-half')) {
        this.flow.send('abort-half');
      }
      await this.saveEvent();
      this.prepareCurrentTournamentHalf();
    } catch (error) {
      this.shell.toast(error instanceof Error ? error.message : '無法中止本局。', 'error');
    }
  }

  private handleCameraEnded(): void {
    this.cameraReady = false;
    this.stopInferenceLoop();
    this.shell.setCameraState('error', '攝影機連線中斷');
    this.shell.toast('攝影機連線中斷；遊戲已安全暫停。', 'error', 6000);
    if (!this.currentRoundActive || this.demoMode) return;
    for (const player of this.currentPlayers ?? []) {
      this.trackingPauses[player.participant.id] =
        (this.trackingPauses[player.participant.id] ?? 0) + 1;
    }
    this.pauseGame('攝影機連線中斷', true);
  }

  private checkVisionHeartbeat(): void {
    if (
      !this.currentRoundActive ||
      this.demoMode ||
      this.gamePaused ||
      this.trackingRecalibrationActive ||
      !hasVisionHeartbeatExpired(
        this.lastPoseFrameReceivedAt,
        performance.now(),
        TRACKING_PAUSE_MS,
      )
    ) {
      return;
    }
    for (const player of this.currentPlayers ?? []) {
      this.trackingPauses[player.participant.id] =
        (this.trackingPauses[player.participant.id] ?? 0) + 1;
    }
    this.pauseGame('姿態推論暫時無回應', true);
  }

  private pauseGame(
    reason: string,
    tracking: boolean,
    allowIdentityRecalibration = true,
  ): void {
    const trackingDetail = allowIdentityRecalibration
      ? '登記玩家的頭部身份或攝影機追蹤持續中斷。其他入鏡者不會接管；5 秒內未恢復會重新校正。'
      : '玩家身份仍由頭部錨點鎖定，但主手暫時離框。刀光與計分已停用，主手恢復後即可繼續。';
    if (this.gamePaused) {
      if (tracking) {
        if (!this.trackingPaused) {
          this.trackingPaused = true;
          this.trackingRecoveryAnnounced = false;
          this.shell.showPause(
            reason,
            trackingDetail,
          );
        }
        if (allowIdentityRecalibration) this.scheduleTrackingEscalation();
      }
      return;
    }
    this.gamePaused = true;
    this.trackingPaused = tracking;
    this.trackingRecoveryAnnounced = false;
    this.game.pause(reason);
    this.shell.showPause(
      reason,
      tracking ? trackingDetail : '計時、水果與計分均已凍結。',
    );
    if (this.currentRoundKind === 'tournament' && this.currentAssignment?.phase !== 'tiebreak' && this.flow?.can('pause-half')) {
      this.flow.send('pause-half');
    }
    const pauseButton = this.root.querySelector<HTMLButtonElement>('#host-pause');
    if (pauseButton) pauseButton.textContent = '繼續';
    if (tracking && allowIdentityRecalibration) this.scheduleTrackingEscalation();
  }

  private resumeGame(): void {
    if (!this.gamePaused) return;
    if (this.trackingPaused && !this.isTrackingStable()) {
      this.shell.toast('玩家尚未重新穩定辨識。', 'error');
      return;
    }
    this.clearTrackingSafetyTimers();
    this.gamePaused = false;
    this.trackingPaused = false;
    this.trackingRecoveryAnnounced = false;
    this.game.resume();
    this.shell.hidePause();
    if (this.currentRoundKind === 'tournament' && this.currentAssignment?.phase !== 'tiebreak' && this.flow?.can('resume-half')) {
      this.flow.send('resume-half');
    }
    const pauseButton = this.root.querySelector<HTMLButtonElement>('#host-pause');
    if (pauseButton) pauseButton.textContent = '暫停';
  }

  private handleTrackingSafety(frame: AppTrackerFrameResult): void {
    if (!this.currentRoundActive || this.demoMode || this.trackingRecalibrationActive) return;

    const spectatorCount = frame.unassignedObservations.length;
    if (
      spectatorCount > 0 &&
      (this.lastSpectatorCount === 0 || frame.observedAt - this.lastSpectatorNoticeAt >= 8_000)
    ) {
      this.lastSpectatorNoticeAt = frame.observedAt;
      this.shell.toast(
        `已鎖定登記玩家，忽略 ${spectatorCount} 位其他入鏡者。`,
        'info',
        2200,
      );
    }
    this.lastSpectatorCount = spectatorCount;

    const impaired = frame.players.flatMap((player) => {
      const unavailable =
        player.state !== 'tracking' || player.activeWrist === null || player.confidence < 0.45;
      if (!unavailable) {
        this.trackingImpairedSince.delete(player.participantId);
        this.trackingWarnedPlayers.delete(player.participantId);
        return [];
      }
      const inferredStart = frame.observedAt - Math.max(0, player.lostForMs);
      const since = this.trackingImpairedSince.get(player.participantId) ?? inferredStart;
      this.trackingImpairedSince.set(player.participantId, Math.min(since, inferredStart));
      return [{ player, unavailableForMs: frame.observedAt - Math.min(since, inferredStart) }];
    });

    const newlyWarned = impaired.filter(
      ({ player, unavailableForMs }) =>
        unavailableForMs >= TRACKING_WARNING_MS &&
        !this.trackingWarnedPlayers.has(player.participantId),
    );
    if (newlyWarned.length > 0) {
      newlyWarned.forEach(({ player }) => this.trackingWarnedPlayers.add(player.participantId));
      this.shell.toast('主手暫時失追，刀光與得分已停用。', 'info', 1800);
    }

    const safety = assessTrackingSafety(
      impaired.map(({ player, unavailableForMs }) => ({
        participantId: player.participantId,
        unavailableForMs,
      })),
      spectatorCount,
      TRACKING_PAUSE_MS,
    );

    if (safety.mustPause) {
      const wasTrackingPaused = this.gamePaused && this.trackingPaused;
      if (!wasTrackingPaused) {
        safety.pauseParticipantIds.forEach((participantId) => {
          this.trackingPauses[participantId] = (this.trackingPauses[participantId] ?? 0) + 1;
        });
      }
      const identityLost = impaired.some(
        ({ player }) => !player.identity.locked || !player.identity.headMatched,
      );
      this.pauseGame(
        identityLost ? '登記玩家頭部身份長時間失追' : '登記玩家主手長時間離框',
        true,
        identityLost,
      );
      return;
    }

    if (this.gamePaused && this.trackingPaused && this.isTrackingStable(frame)) {
      if (!this.trackingRecoveryAnnounced) {
        this.trackingRecoveryAnnounced = true;
        this.shell.toast(
          `${this.currentPlayers?.length === 1 ? '玩家' : '兩位玩家'}追蹤已恢復；請主持人確認後繼續。`,
          'success',
          3000,
        );
      }
    } else if (!this.gamePaused) {
      this.trackingRecoveryAnnounced = false;
    }
  }

  private isTrackingStable(frame = this.lastTrackerFrame): boolean {
    if (!frame) return false;
    if (performance.now() - frame.observedAt > TRACKING_PAUSE_MS) return false;
    return frame.players.every(
      ({ state, activeWrist, confidence, identity }) =>
        state === 'tracking' &&
        identity.locked &&
        identity.headMatched &&
        activeWrist !== null &&
        confidence >= 0.45,
    );
  }

  private scheduleTrackingEscalation(): void {
    if (this.trackingEscalationTimer !== null || this.trackingRecalibrationActive) return;
    this.trackingEscalationTimer = window.setTimeout(() => {
      this.trackingEscalationTimer = null;
      if (
        !this.currentRoundActive ||
        !this.gamePaused ||
        !this.trackingPaused ||
        this.demoMode ||
        this.isTrackingStable()
      ) {
        return;
      }
      this.beginSafetyRecalibration();
    }, TRACKING_RECALIBRATION_AFTER_MS);
  }

  private beginSafetyRecalibration(): void {
    if (this.trackingRecalibrationActive || !this.currentPlayers) return;
    this.trackingRecalibrationActive = true;
    this.shell.hidePause();
    this.shell.hideHud();
    this.shell.hideHostControls();
    this.shell.showGameChrome(false);
    const players = this.currentPlayers;
    this.beginCalibration(
      players,
      '追蹤安全重新校正',
      false,
      () => this.completeSafetyRecalibration(),
      () => void this.failSafetyRecalibration(),
    );
    const cancel = this.root.querySelector<HTMLButtonElement>('#cancel-calibration');
    if (cancel) cancel.textContent = '校正失敗，技術作廢';
    this.trackingRecalibrationTimer = window.setTimeout(() => {
      void this.failSafetyRecalibration();
    }, TRACKING_RECALIBRATION_TIMEOUT_MS);
  }

  private completeSafetyRecalibration(): void {
    if (!this.trackingRecalibrationActive) return;
    if (this.trackingRecalibrationTimer !== null) {
      window.clearTimeout(this.trackingRecalibrationTimer);
      this.trackingRecalibrationTimer = null;
    }
    this.trackingRecalibrationActive = false;
    this.screen = 'game';
    this.shell.clearScreen();
    this.shell.showGameChrome(true);
    this.renderHud();
    if (this.currentRoundKind) this.bindHostControls(this.currentRoundKind);
    this.resumeGame();
  }

  private async failSafetyRecalibration(): Promise<void> {
    if (!this.trackingRecalibrationActive) return;
    this.trackingRecalibrationActive = false;
    this.clearTrackingSafetyTimers();
    this.shell.toast('重新校正未通過；只作廢目前小局並抽取新腳本。', 'error', 5000);
    if (this.currentRoundKind === 'practice' && this.manager && this.currentHeatId) {
      this.game.abort();
      this.currentRoundActive = false;
      this.resetVisibleGame();
      this.prepareCurrentTournamentHalf();
      return;
    }
    await this.abortCurrentRound('追蹤重新校正失敗');
  }

  private clearTrackingSafetyTimers(): void {
    if (this.trackingEscalationTimer !== null) {
      window.clearTimeout(this.trackingEscalationTimer);
      this.trackingEscalationTimer = null;
    }
    if (this.trackingRecalibrationTimer !== null) {
      window.clearTimeout(this.trackingRecalibrationTimer);
      this.trackingRecalibrationTimer = null;
    }
  }

  private updateCameraTrails(frame: AppTrackerFrameResult): void {
    if (!this.currentPlayers) return;
    const trails: SliceTrail[] = [];
    for (const player of frame.players) {
      if (
        player.state !== 'tracking' ||
        !player.identity.locked ||
        !player.identity.headMatched ||
        player.observation === null
      ) {
        continue;
      }
      let profile = this.calibrationProfiles.get(player.participantId);
      const geometry = getTorsoGeometry(player.observation);
      if (profile && geometry && player.poseQuality) {
        const adapted = this.adaptiveCalibration.update(player.participantId, {
          shoulderWidth: geometry.shoulderWidth,
          torsoLength: geometry.torsoLength,
          poseQuality: player.poseQuality.score,
          observedAt: frame.observedAt,
        });
        if (adapted) {
          profile = adapted;
          this.calibrationProfiles.set(player.participantId, adapted);
        }
      }
      // Every mode exposes exactly one scoring blade per player. Keeping this
      // policy here (and again at the game boundary) prevents the non-dominant
      // hand from reappearing when a tracker is configured permissively.
      const points: Array<{ key: string; point: Point | null; confidence: number }> = [
        { key: 'active', point: player.activeWrist, confidence: player.confidence },
      ];
      points.forEach(({ key, point, confidence }) => {
        if (!point || confidence < 0.45) return;
        const anchors = geometry
          ? { shoulderCenter: geometry.shoulderCenter, torsoCenter: geometry.torsoCenter }
          : undefined;
        const mapped = profile && anchors
          ? this.currentRoundKind === 'solo-practice'
            ? mapCalibratedPointToArena(point, profile, anchors)
            : mapCalibratedPointToLane(point, profile, anchors)
          : point;
        const logical = normalizedToLogical(mapped, false);
        trails.push(this.appendTrail(
          `${player.participantId}:${key}`,
          player.participantId,
          player.lane,
          player.activeHand,
          logical,
          frame.observedAt,
          confidence,
        ));
      });
    }
    this.game.updateTrails(trails);
  }

  private appendTrail(
    key: string,
    participantId: string,
    lane: Lane,
    hand: DominantHand,
    point: Point,
    timestampMs: number,
    confidence: number,
  ): SliceTrail {
    let state = this.trailStates.get(key);
    if (!state) {
      state = {
        filter: new OneEuroPointFilter({ frequency: 30, minCutoff: 1.2, beta: 0.015 }),
        trail: { participantId, lane, hand, points: [], confidence },
      };
      this.trailStates.set(key, state);
    }
    const filtered = state.filter.filter(point, timestampMs);
    state.trail.points.push({ ...filtered, timestampMs });
    state.trail.points = state.trail.points.filter((sample) => timestampMs - sample.timestampMs <= 220);
    state.trail.confidence = confidence;
    // Capture timestamps stay on points for speed/geometry. Delivery time is
    // separate so the game can accept Worker latency but consume this result
    // exactly once shortly after it reaches the main thread.
    state.trail.receivedAtMs = performance.now();
    return state.trail;
  }

  private renderHud(): void {
    if (!this.currentPlayers || this.screen !== 'game') return;
    const [left, right] = this.currentPlayers;
    if (!left) return;
    this.shell.showHud(
      { name: left.participant.displayName, score: this.activeScores[left.participant.id]?.score ?? 0 },
      right
        ? { name: right.participant.displayName, score: this.activeScores[right.participant.id]?.score ?? 0 }
        : null,
      this.remainingMs,
    );
  }

  private resetVisibleGame(): void {
    // Result/setup screens must not make the adaptive vision controller treat
    // a host walking through frame as a missing registered player. Calibration
    // and startGameRound set the expected count again before camera input is
    // used for scoring.
    this.vision.setExpectedPoseCount(null);
    this.clearTrackingSafetyTimers();
    this.trackingWarnedPlayers.clear();
    this.trackingImpairedSince.clear();
    this.trackingRecalibrationActive = false;
    this.trackingRecoveryAnnounced = false;
    this.calibrationHandReadyFrames.clear();
    this.calibrationIdentityLocked = false;
    this.lastSpectatorCount = 0;
    this.lastSpectatorNoticeAt = Number.NEGATIVE_INFINITY;
    this.shell.setSoloArena(false);
    this.shell.showGameChrome(false);
    this.shell.hideHostControls();
    this.shell.hideHud();
    this.shell.hideCountdown();
    this.shell.hidePause();
    this.gamePaused = false;
    this.trackingPaused = false;
    this.currentRoundActive = false;
  }

  private async saveEvent(): Promise<void> {
    if (!this.manager) return;
    const snapshot = this.manager.snapshot();
    await this.eventStore.save(snapshot);
    this.savedEvent = snapshot;
  }

  private async resumeSavedEvent(): Promise<void> {
    const event = this.savedEvent ?? (await this.eventStore.load());
    if (!event) return;
    try {
      this.scriptResources = this.buildScriptResources(
        event.config.id,
        event.config.difficulty,
        event.config.scriptPoolVersion,
      );
      this.manager = TournamentManager.fromSnapshot(event, this.scriptResources.ids);
      const qualifierHeats = this.manager.getQualifierHeats();
      const completedQualifierHeats = qualifierHeats.filter(({ status }) => status === 'completed').length;
      const activeHeat = event.heats.find(({ status }) => !['completed'].includes(status) && status !== 'void');
      const competitionPhase = event.phase === 'final' ? 'final' : 'qualifier';
      this.flow = new AppFlowStateMachine(qualifierHeats.length, {
        state: activeHeat?.status === 'review' ? (activeHeat.currentHalf === 0 ? 'swap' : 'review') : 'calibration',
        competitionPhase,
        halfIndex: activeHeat?.currentHalf === 1 ? 1 : 0,
        paused: false,
        halfConfirmed: false,
        practiceRequired: activeHeat?.currentHalf !== 1,
        qualifierHeatCount: qualifierHeats.length,
        completedQualifierHeats,
      });

      if (event.phase === 'completed') {
        const champion = this.manager.getChampion();
        if (champion) this.renderChampion(champion);
        return;
      }
      if (!activeHeat) {
        this.renderLeaderboard();
        return;
      }
      this.currentHeatId = activeHeat.id;
      if (activeHeat.phase === 'tiebreak') this.tiebreakContext = this.inferTiebreakContext(activeHeat.id);
      if (activeHeat.status === 'review') {
        const provisional = activeHeat.results.filter(
          ({ halfIndex, status }) => halfIndex === activeHeat.currentHalf && status === 'provisional',
        );
        this.restoreReview(activeHeat.id, provisional);
      } else {
        this.prepareCurrentTournamentHalf();
      }
    } catch (error) {
      this.shell.toast(error instanceof Error ? error.message : '無法恢復賽事。', 'error', 6000);
    }
  }

  private restoreReview(heatId: string, results: HalfResult[]): void {
    if (!this.manager) return;
    const heat = this.manager.snapshot().heats.find(({ id }) => id === heatId);
    if (!heat) return;
    const assignment = this.manager.getHalfAssignment(heatId);
    this.currentAssignment = assignment;
    const participants = assignment.players.map(({ participantId, lane }) => {
      const participant = this.manager!.snapshot().participants.find(({ id }) => id === participantId)!;
      return { participant, lane };
    }) as [RuntimePlayer, RuntimePlayer];
    this.currentPlayers = participants;
    const scores = Object.fromEntries(results.map((result) => [result.participantId, result]));
    this.latestRoundResult = { scriptId: assignment.scriptId, elapsedMs: assignment.durationMs, scores };
    this.renderTournamentReview();
  }

  private toggleDiagnostics(): void {
    if (this.diagnosticsElement) {
      this.diagnosticsElement.remove();
      this.diagnosticsElement = null;
      return;
    }
    this.diagnosticsElement = document.createElement('pre');
    this.diagnosticsElement.className = 'debug-panel';
    this.root.append(this.diagnosticsElement);
    this.refreshDiagnostics();
  }

  private refreshDiagnostics(): void {
    if (!this.diagnosticsElement) return;
    const percentile95 = (samples: readonly number[]): number => {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    };
    const inferenceP95 = percentile95(this.inferenceSamples);
    const pipelineP95 = percentile95(this.pipelineSamples);
    const recentCutoff = performance.now() - 1000;
    const fps = this.inferenceTimestamps.filter((time) => time >= recentCutoff).length;
    const performanceMetrics = this.lastVisionPerformance;
    this.diagnosticsElement.textContent = [
      'FRUIT MOTION DIAGNOSTICS',
      `Camera: ${this.camera.session?.deviceCategory === 'iphone-continuity' ? 'iPhone Continuity RGB · ' : ''}${this.camera.session?.width ?? 0}×${this.camera.session?.height ?? 0} @ ${Math.round(this.camera.session?.frameRate ?? 0)}fps`,
      `Vision: ${(performanceMetrics?.modelTier ?? 'starting').toUpperCase()} · 33 model landmarks / ${POSE_QUALITY_LANDMARK_COUNT} game anchors · ${performanceMetrics?.backend ?? 'starting'} · ${this.vision.state}`,
      `Adaptive: ${performanceMetrics?.adaptiveMode ?? 'warming-up'} · ${performanceMetrics?.diagnosis ?? 'warming-up'} · max poses ${performanceMetrics?.maxPoses ?? 0}`,
      `Inference: ${fps}fps · p95 ${inferenceP95.toFixed(1)}ms`,
      `Pipeline: p95 ${pipelineP95.toFixed(1)}ms · input ${performanceMetrics?.inputWidth ?? 0}×${performanceMetrics?.inputHeight ?? 0}`,
      `Last stages: capture ${performanceMetrics?.captureMs.toFixed(1) ?? '0.0'} · queue ${performanceMetrics?.workerQueueMs.toFixed(1) ?? '0.0'} · inference ${performanceMetrics?.inferenceMs.toFixed(1) ?? '0.0'} · return ${performanceMetrics?.resultTransferMs.toFixed(1) ?? '0.0'} ms`,
      `Target: ≥20fps · inference p95 ≤45ms · pipeline p95 ≤100ms`,
      `Tracking: ${this.lastTrackerFrame?.players.map((player) => `${player.lane}:${player.state}`).join(' | ') ?? 'idle'}`,
      `Reliable joints: ${this.lastTrackerFrame?.players.map((player) => `${player.lane}:${player.poseQuality?.reliableLandmarkCount ?? 0}/${POSE_QUALITY_LANDMARK_COUNT}`).join(' | ') ?? 'idle'}`,
      `Ignored spectators: ${this.lastTrackerFrame?.unassignedObservations.length ?? 0}`,
      `Adaptive scale: ${this.lastTrackerFrame?.players.map((player) => {
        const status = this.adaptiveCalibration.status(player.participantId);
        return status
          ? `${player.lane}:S${status.shoulderScale.toFixed(2)}/T${status.torsoScale.toFixed(2)}`
          : `${player.lane}:pending`;
      }).join(' | ') ?? 'idle'}`,
      `Input: ${this.demoMode ? 'pointer demo' : 'camera / local only'}`,
    ].join('\n');
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.demoMode || this.screen !== 'game' || !this.currentPlayers) return;
    const target = event.target as Element | null;
    if (target?.closest('button,input,select,textarea')) return;
    const rect = this.root.getBoundingClientRect();
    const owner = this.currentPlayers.length === 1
      ? this.currentPlayers[0]
      : this.currentPlayers.find((player) =>
          player.lane === (event.clientX - rect.left < rect.width / 2 ? 'left' : 'right'),
        );
    if (!owner) return;
    this.activePointerOwners.set(event.pointerId, owner.participant.id);
    this.appendPointerTrail(event, owner);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.demoMode || !this.currentPlayers) return;
    const participantId = this.activePointerOwners.get(event.pointerId);
    if (!participantId) return;
    const owner = this.currentPlayers.find(({ participant }) => participant.id === participantId);
    if (owner) this.appendPointerTrail(event, owner);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.activePointerOwners.delete(event.pointerId);
  };

  private appendPointerTrail(event: PointerEvent, owner: RuntimePlayer): void {
    const rect = this.root.getBoundingClientRect();
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * 1920,
      y: ((event.clientY - rect.top) / rect.height) * 1080,
    };
    this.appendTrail(
      `pointer:${event.pointerId}`,
      owner.participant.id,
      owner.lane,
      owner.participant.activeHand,
      point,
      performance.now(),
      1,
    );
    this.game.updateTrails([...this.trailStates.values()].map(({ trail }) => trail));
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() === 'd' && event.altKey) this.toggleDiagnostics();
    if (event.code === 'Space' && this.screen === 'game') {
      event.preventDefault();
      if (this.gamePaused) this.resumeGame();
      else this.pauseGame('主持人暫停', false);
    }
  };
}
