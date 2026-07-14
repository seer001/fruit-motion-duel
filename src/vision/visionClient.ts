import type {
  FrameRequest,
  InitializeVisionRequest,
  PoseFrame,
  VisionErrorMessage,
  VisionWorkerInbound,
  VisionWorkerOutbound,
} from '../types/game';
import {
  AdaptiveVisionLoadController,
  type VisionAdaptiveProfile,
  type VisionDiagnosis,
} from './vision-adaptation';
import type { PoseBackend } from './pose-backend';

export type VisionClientState = 'idle' | 'initializing' | 'ready' | 'error' | 'closed';
export type VisionFrameSource = ImageBitmapSource;

export interface VisionWorkerPort {
  postMessage(message: VisionWorkerInbound, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<VisionWorkerOutbound>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

interface PendingCapture {
  source: VisionFrameSource;
  timestampMs: number;
  generation: number;
}

export interface VisionClientOptions {
  wasmRoot?: string;
  modelPath?: string;
  gpuModelPath?: string;
  initializationTimeoutMs?: number;
  frameTimeoutMs?: number;
  workerFactory?: () => VisionWorkerPort;
  createBitmap?: (source: VisionFrameSource) => Promise<ImageBitmap>;
  /** Fixed longest bitmap edge. Omit to allow the adaptive 512–960 px policy. */
  inferenceMaxDimension?: number;
}

interface SourceDimensions {
  width: number;
  height: number;
}

function positiveDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function sourceDimensions(source: VisionFrameSource): SourceDimensions | null {
  const candidate = source as unknown as Record<string, unknown>;
  const pairs = [
    ['videoWidth', 'videoHeight'],
    ['displayWidth', 'displayHeight'],
    ['naturalWidth', 'naturalHeight'],
    ['width', 'height'],
  ] as const;
  for (const [widthKey, heightKey] of pairs) {
    const width = positiveDimension(candidate[widthKey]);
    const height = positiveDimension(candidate[heightKey]);
    if (width !== null && height !== null) return { width, height };
  }
  return null;
}

export function calculateInferenceBitmapSize(
  width: number,
  height: number,
  maxDimension = 640,
): SourceDimensions {
  if (![width, height, maxDimension].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Inference bitmap dimensions must be positive and finite');
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function createLowLatencyBitmap(
  source: VisionFrameSource,
  maxDimension: number,
  resizeQuality: ResizeQuality,
): Promise<ImageBitmap> {
  const dimensions = sourceDimensions(source);
  if (dimensions === null) return globalThis.createImageBitmap(source);
  const target = calculateInferenceBitmapSize(dimensions.width, dimensions.height, maxDimension);
  if (target.width === dimensions.width && target.height === dimensions.height) {
    return globalThis.createImageBitmap(source);
  }
  // MediaPipe resizes into the model tensor internally. Doing one
  // aspect-ratio-preserving, hardware-accelerated resize before transfer avoids
  // shipping a 720p/1080p bitmap into the worker without changing normalized
  // landmark coordinates.
  return globalThis.createImageBitmap(source, {
    resizeWidth: target.width,
    resizeHeight: target.height,
    resizeQuality,
  });
}

function publicAssetUrl(path: string): string {
  const pageUrl =
    typeof document === 'undefined'
      ? (globalThis.location?.href ?? 'http://localhost/')
      : document.baseURI;
  const baseUrl = new URL(import.meta.env.BASE_URL, pageUrl);
  return new URL(path.replace(/^\/+/, ''), baseUrl).href;
}

function defaultWorkerFactory(): VisionWorkerPort {
  return new Worker(new URL('./pose-worker.ts', import.meta.url), {
    type: 'module',
    name: 'pose-landmarker',
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class VisionClient {
  private worker: VisionWorkerPort;
  private readonly workerFactory: () => VisionWorkerPort;
  private readonly wasmRoot: string;
  private readonly modelPath: string;
  private readonly gpuModelPath: string;
  private readonly initializationTimeoutMs: number;
  private readonly frameTimeoutMs: number;
  private readonly createBitmapOverride:
    | ((source: VisionFrameSource) => Promise<ImageBitmap>)
    | undefined;
  private readonly inferenceMaxDimensionOverride: number | undefined;
  private readonly adaptation = new AdaptiveVisionLoadController('cpu');
  private readonly poseListeners = new Set<(frame: PoseFrame) => void>();
  private readonly errorListeners = new Set<(error: VisionErrorMessage) => void>();
  private currentState: VisionClientState = 'idle';
  private initializePromise: Promise<void> | null = null;
  private resolveInitialize: (() => void) | null = null;
  private rejectInitialize: ((error: Error) => void) | null = null;
  private initializationTimer: ReturnType<typeof setTimeout> | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private configurationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCapture: PendingCapture | null = null;
  private captureInProgress = false;
  private inferenceInFlight = false;
  private configurationInFlight = false;
  private activeBackend: PoseBackend = 'cpu';
  private activeProfile: VisionAdaptiveProfile = this.adaptation.profile;
  private activeWorkerMaxPoses: 2 | 3 = 2;
  private reportedTrackedPoseCount: number | null = null;
  private latestDiagnosis: VisionDiagnosis = 'warming-up';
  private lastDeliveredPoseAt: number | null = null;
  private forceCpu = false;
  private nextFrameId = 1;
  private minimumAcceptedFrameId = 1;
  private generation = 0;

  constructor(options: VisionClientOptions = {}) {
    this.wasmRoot = options.wasmRoot ?? publicAssetUrl('vendor/mediapipe');
    // CPU uses Lite to remain responsive. On a working GPU, Full materially
    // improves arm/hand stability when each player occupies only half a wide
    // camera frame without paying that cost on CPU fallback machines.
    this.modelPath = options.modelPath ?? publicAssetUrl('models/pose_landmarker_lite.task');
    this.gpuModelPath =
      options.gpuModelPath ??
      (options.modelPath ?? publicAssetUrl('models/pose_landmarker_full.task'));
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 20_000;
    this.frameTimeoutMs = options.frameTimeoutMs ?? 1_500;
    if (!Number.isFinite(this.frameTimeoutMs) || this.frameTimeoutMs <= 0) {
      throw new RangeError('frameTimeoutMs must be positive and finite');
    }
    const inferenceMaxDimension = options.inferenceMaxDimension;
    if (
      inferenceMaxDimension !== undefined &&
      (!Number.isFinite(inferenceMaxDimension) || inferenceMaxDimension <= 0)
    ) {
      throw new RangeError('inferenceMaxDimension must be positive and finite');
    }
    this.inferenceMaxDimensionOverride = inferenceMaxDimension;
    this.createBitmapOverride = options.createBitmap;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.worker = this.workerFactory();
    this.bindWorker(this.worker);
  }

  get state(): VisionClientState {
    return this.currentState;
  }

  initialize(): Promise<void> {
    if (this.currentState === 'closed') {
      return Promise.reject(new Error('VisionClient is closed'));
    }
    if (this.currentState === 'ready') return Promise.resolve();
    if (this.initializePromise !== null) return this.initializePromise;

    this.currentState = 'initializing';
    this.initializePromise = new Promise<void>((resolve, reject) => {
      this.resolveInitialize = resolve;
      this.rejectInitialize = reject;
    });
    this.armInitializationTimeout();
    this.worker.postMessage(this.initializeRequest());
    return this.initializePromise;
  }

  /**
   * Declares how many registered players should be visible in the active
   * screen. Recognition rescue is disabled when null, so menus and camera
   * checks do not mistake a lone host for a missing second player.
   */
  setExpectedPoseCount(expected: 1 | 2 | null): void {
    this.reportedTrackedPoseCount = null;
    this.lastDeliveredPoseAt = null;
    this.activeProfile = this.adaptation.setExpectedPoseCount(expected);
    this.latestDiagnosis = 'warming-up';
    if (
      this.currentState === 'ready' &&
      this.activeWorkerMaxPoses !== this.activeProfile.maxPoses
    ) {
      this.requestWorkerConfiguration(this.activeProfile.maxPoses);
    }
  }

  /**
   * Feeds identity-aware tracker output back into the next adaptation sample.
   * Raw MediaPipe count alone cannot distinguish player two from a spectator.
   */
  reportTrackedPoseCount(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > 2) {
      throw new RangeError('Tracked pose count must be an integer from 0 to 2');
    }
    this.reportedTrackedPoseCount = count;
  }

  submitFrame(source: VisionFrameSource, timestampMs: number): void {
    if (this.currentState === 'closed') return;
    if (!Number.isFinite(timestampMs)) throw new RangeError('timestampMs must be finite');
    // Keep only a source reference; an ImageBitmap is created only when the
    // worker is free, avoiding a queue of large transferable buffers.
    this.pendingCapture = { source, timestampMs, generation: this.generation };
    this.pump();
  }

  onPoseFrame(listener: (frame: PoseFrame) => void): () => void {
    this.poseListeners.add(listener);
    return () => this.poseListeners.delete(listener);
  }

  onError(listener: (error: VisionErrorMessage) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  reset(): void {
    if (this.currentState === 'closed') return;
    this.generation += 1;
    this.pendingCapture = null;
    this.minimumAcceptedFrameId = this.nextFrameId;
    this.worker.postMessage({ type: 'reset' });
  }

  close(): void {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed';
    this.generation += 1;
    this.pendingCapture = null;
    this.rejectInitialize?.(new Error('VisionClient closed during initialization'));
    this.clearInitializationPromise();
    this.clearFrameTimer();
    this.clearConfigurationTimer();
    this.poseListeners.clear();
    this.errorListeners.clear();
    this.worker.terminate();
  }

  private pump(): void {
    if (
      this.currentState !== 'ready' ||
      this.captureInProgress ||
      this.inferenceInFlight ||
      this.configurationInFlight ||
      this.pendingCapture === null
    ) {
      return;
    }

    const capture = this.pendingCapture;
    this.pendingCapture = null;
    this.captureInProgress = true;
    const captureStartedAtMs = performance.now();
    void this.createBitmap(capture.source)
      .then((bitmap) => {
        this.captureInProgress = false;
        const capturedAtMs = performance.now();
        if (this.currentState !== 'ready' || capture.generation !== this.generation) {
          bitmap.close();
          return;
        }

        const request: FrameRequest = {
          type: 'frame',
          frameId: this.nextFrameId++,
          timestampMs: capture.timestampMs,
          bitmap,
          captureStartedAtMs,
          capturedAtMs,
        };
        try {
          this.inferenceInFlight = true;
          this.worker.postMessage(request, [bitmap]);
          this.armFrameTimeout(request.frameId);
        } catch (error) {
          this.inferenceInFlight = false;
          bitmap.close();
          this.emitError({
            type: 'error',
            message: `無法傳送攝影機影格：${errorMessage(error)}`,
            recoverable: true,
          });
          this.pump();
        }
      })
      .catch((error: unknown) => {
        this.captureInProgress = false;
        this.emitError({
          type: 'error',
          message: `無法擷取攝影機影格：${errorMessage(error)}`,
          recoverable: true,
        });
        this.pump();
      });
  }

  private handleMessage(message: VisionWorkerOutbound): void {
    switch (message.type) {
      case 'ready':
        if (this.currentState !== 'initializing') break;
        this.clearFrameTimer();
        this.activeBackend = message.backend ?? 'cpu';
        this.activeProfile = this.adaptation.setBackend(this.activeBackend);
        this.latestDiagnosis = 'warming-up';
        this.lastDeliveredPoseAt = null;
        this.activeWorkerMaxPoses = message.maxPoses ?? this.activeProfile.maxPoses;
        this.currentState = 'ready';
        this.resolveInitialize?.();
        this.clearInitializationPromise();
        if (this.activeWorkerMaxPoses !== this.activeProfile.maxPoses) {
          this.requestWorkerConfiguration(this.activeProfile.maxPoses);
        }
        this.pump();
        break;
      case 'configured':
        this.clearConfigurationTimer();
        this.configurationInFlight = false;
        this.activeWorkerMaxPoses = message.maxPoses;
        this.lastDeliveredPoseAt = null;
        if (this.activeWorkerMaxPoses !== this.activeProfile.maxPoses) {
          this.requestWorkerConfiguration(this.activeProfile.maxPoses);
        }
        this.pump();
        break;
      case 'poses':
        this.clearFrameTimer();
        this.inferenceInFlight = false;
        if (message.frameId >= this.minimumAcceptedFrameId) {
          const receivedAtMs = performance.now();
          const resultIntervalMs =
            this.lastDeliveredPoseAt === null
              ? undefined
              : Math.max(0, receivedAtMs - this.lastDeliveredPoseAt);
          this.lastDeliveredPoseAt = receivedAtMs;
          let deliveredMessage: PoseFrame = message.performance === undefined
            ? message
            : {
                ...message,
                performance: {
                  ...message.performance,
                  resultTransferMs: Math.max(
                    0,
                    receivedAtMs - (message.timestampMs + message.performance.pipelineMs),
                  ),
                  pipelineMs: Math.max(0, receivedAtMs - message.timestampMs),
                },
              };
          if (deliveredMessage.performance !== undefined) {
            this.activeWorkerMaxPoses =
              deliveredMessage.performance.maxPoses ?? this.activeWorkerMaxPoses;
            const adaptation = this.adaptation.observe({
              inferenceMs: deliveredMessage.performance.inferenceMs,
              pipelineMs: deliveredMessage.performance.pipelineMs,
              poseCount:
                this.reportedTrackedPoseCount ?? deliveredMessage.poses.length,
              ...(resultIntervalMs === undefined ? {} : { resultIntervalMs }),
            });
            this.latestDiagnosis = adaptation.diagnosis;
            if (adaptation.profileChanged) {
              this.activeProfile = adaptation.profile;
              if (this.activeWorkerMaxPoses !== adaptation.profile.maxPoses) {
                this.requestWorkerConfiguration(adaptation.profile.maxPoses);
              }
            }
            deliveredMessage = {
              ...deliveredMessage,
              performance: {
                ...deliveredMessage.performance,
                adaptiveMode: this.activeProfile.mode,
                diagnosis: this.latestDiagnosis,
              },
            };
          }
          for (const listener of this.poseListeners) listener(deliveredMessage);
        }
        this.pump();
        break;
      case 'error':
        this.clearFrameTimer();
        this.clearConfigurationTimer();
        this.inferenceInFlight = false;
        this.configurationInFlight = false;
        if (message.recoveryAction === 'reinitialize-cpu') {
          this.forceCpu = true;
          this.currentState = 'initializing';
          this.generation += 1;
          this.pendingCapture = null;
          this.minimumAcceptedFrameId = this.nextFrameId;
          this.armInitializationTimeout();
          this.emitError(message);
          break;
        }
        if (this.currentState === 'initializing') {
          this.currentState = 'error';
          this.rejectInitialize?.(new Error(message.message));
          this.clearInitializationPromise();
        } else if (!message.recoverable) {
          this.currentState = 'error';
        }
        this.emitError(message);
        this.pump();
        break;
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    this.clearFrameTimer();
    this.clearConfigurationTimer();
    this.inferenceInFlight = false;
    this.configurationInFlight = false;
    if (!this.forceCpu) {
      const message = event.message || 'GPU 姿態辨識 Worker 中斷，正在改用 CPU。';
      this.emitError({ type: 'error', message, recoverable: true });
      this.restartWorkerOnCpu();
      return;
    }
    this.currentState = 'error';
    const message = event.message || '姿態辨識 Worker 發生未預期錯誤。';
    this.rejectInitialize?.(new Error(message));
    this.clearInitializationPromise();
    this.emitError({ type: 'error', message, recoverable: true });
  }

  private emitError(error: VisionErrorMessage): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private clearInitializationPromise(): void {
    if (this.initializationTimer !== null) clearTimeout(this.initializationTimer);
    this.initializationTimer = null;
    this.initializePromise = null;
    this.resolveInitialize = null;
    this.rejectInitialize = null;
  }

  private initializeRequest(): InitializeVisionRequest {
    return {
      type: 'initialize',
      wasmRoot: this.wasmRoot,
      modelPath: this.modelPath,
      gpuModelPath: this.gpuModelPath,
      maxPoses: 3,
      cpuMaxPoses: 2,
      ...(this.forceCpu ? { forceBackend: 'cpu' as const } : {}),
    };
  }

  private createBitmap(source: VisionFrameSource): Promise<ImageBitmap> {
    if (this.createBitmapOverride !== undefined) return this.createBitmapOverride(source);
    return createLowLatencyBitmap(
      source,
      this.inferenceMaxDimensionOverride ?? this.activeProfile.maxDimension,
      this.activeProfile.resizeQuality,
    );
  }

  private bindWorker(worker: VisionWorkerPort): void {
    worker.addEventListener('message', (event) => {
      if (this.worker === worker) this.handleMessage(event.data);
    });
    worker.addEventListener('error', (event) => {
      if (this.worker === worker) this.handleWorkerError(event);
    });
  }

  private requestWorkerConfiguration(maxPoses: 2 | 3): void {
    if (this.configurationInFlight || this.currentState !== 'ready') return;
    this.configurationInFlight = true;
    this.worker.postMessage({ type: 'configure', maxPoses });
    this.clearConfigurationTimer();
    this.configurationTimer = setTimeout(() => {
      if (!this.configurationInFlight || this.currentState !== 'ready') return;
      this.emitError({
        type: 'error',
        message: '姿態推論負載調整逾時，正在以 CPU Lite 模式恢復。',
        recoverable: true,
      });
      this.restartWorkerOnCpu();
    }, this.frameTimeoutMs);
  }

  private armInitializationTimeout(): void {
    if (this.initializationTimer !== null) clearTimeout(this.initializationTimer);
    this.initializationTimer = setTimeout(() => {
      if (this.currentState !== 'initializing') return;
      if (!this.forceCpu) {
        this.emitError({
          type: 'error',
          message: 'GPU 姿態模型初始化逾時，正在改用 CPU Lite。',
          recoverable: true,
        });
        this.restartWorkerOnCpu();
        return;
      }
      this.currentState = 'error';
      this.worker.terminate();
      this.generation += 1;
      const error = new Error('姿態模型初始化逾時，請確認本機模型資產可讀取。');
      this.rejectInitialize?.(error);
      this.clearInitializationPromise();
      this.emitError({ type: 'error', message: error.message, recoverable: true });
    }, this.initializationTimeoutMs);
  }

  private armFrameTimeout(frameId: number): void {
    this.clearFrameTimer();
    this.frameTimer = setTimeout(() => {
      if (!this.inferenceInFlight || this.currentState !== 'ready') return;
      this.emitError({
        type: 'error',
        message: `姿態推論影格 ${frameId} 逾時，正在以 CPU Lite 模式恢復。`,
        recoverable: true,
      });
      this.restartWorkerOnCpu();
    }, this.frameTimeoutMs);
  }

  private clearFrameTimer(): void {
    if (this.frameTimer !== null) clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  private clearConfigurationTimer(): void {
    if (this.configurationTimer !== null) clearTimeout(this.configurationTimer);
    this.configurationTimer = null;
  }

  private restartWorkerOnCpu(): void {
    this.clearFrameTimer();
    this.clearConfigurationTimer();
    this.worker.terminate();
    this.forceCpu = true;
    this.currentState = 'initializing';
    this.generation += 1;
    this.pendingCapture = null;
    this.captureInProgress = false;
    this.inferenceInFlight = false;
    this.configurationInFlight = false;
    this.lastDeliveredPoseAt = null;
    this.minimumAcceptedFrameId = this.nextFrameId;
    this.worker = this.workerFactory();
    this.bindWorker(this.worker);
    this.armInitializationTimeout();
    this.worker.postMessage(this.initializeRequest());
  }
}
