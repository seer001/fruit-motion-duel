import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type {
  FrameRequest,
  InitializeVisionRequest,
  NormalizedLandmark,
  PoseFrame,
  PoseObservation,
  VisionErrorMessage,
  VisionWorkerInbound,
  VisionWorkerOutbound,
} from '../types/game';
import { getMultiJointPoseGeometry } from './landmarks';
import { createPoseBackendWithFallback, type PoseBackend } from './pose-backend';
import { selectPoseRuntimeConfig } from './pose-runtime-config';

interface WorkerEndpoint {
  postMessage(message: VisionWorkerOutbound): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<VisionWorkerInbound>) => void,
  ): void;
}

const endpoint = globalThis as unknown as WorkerEndpoint;
let poseLandmarker: PoseLandmarker | null = null;
let lastTimestampMs = Number.NEGATIVE_INFINITY;
let initializationVersion = 0;
let activeBackend: PoseBackend = 'cpu';
let activeMaxPoses: 2 | 3 = 2;
let activeModelTier: 'lite' | 'full' = 'lite';
let lastInitializeRequest: InitializeVisionRequest | null = null;
let configurationBarrier: Promise<void> = Promise.resolve();

// Pose Landmarker always computes and returns 33 landmarks. The game only
// consumes these 17 head/body/arm/hand anchors. Keeping the original indices in
// a sparse array preserves the tracker contract while cutting worker-to-main
// structured-clone payloads by roughly 48%. This is a transfer optimization;
// it does not make MediaPipe's neural-network inference itself smaller.
const GAME_LANDMARK_INDICES = [
  0, 7, 8,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
] as const;

function postError(
  message: string,
  recoverable: boolean,
  recoveryAction?: VisionErrorMessage['recoveryAction'],
): void {
  const payload: VisionErrorMessage = {
    type: 'error',
    message,
    recoverable,
    ...(recoveryAction === undefined ? {} : { recoveryAction }),
  };
  endpoint.postMessage(payload);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLandmark(landmark: {
  x: number;
  y: number;
  z: number;
  visibility: number;
  presence?: number;
}): NormalizedLandmark {
  const visibility = Number.isFinite(landmark.visibility) ? landmark.visibility : 0;
  const presence =
    landmark.presence === undefined || !Number.isFinite(landmark.presence)
      ? visibility
      : landmark.presence;
  return {
    x: landmark.x,
    y: landmark.y,
    z: landmark.z,
    visibility,
    presence,
  };
}

function toObservations(
  poses: readonly (readonly {
    x: number;
    y: number;
    z: number;
    visibility: number;
    presence?: number;
  }[])[],
): PoseObservation[] {
  const observations: PoseObservation[] = [];
  poses.forEach((pose, index) => {
    const landmarks = new Array<NormalizedLandmark>(25);
    for (const landmarkIndex of GAME_LANDMARK_INDICES) {
      const landmark = pose[landmarkIndex];
      if (landmark !== undefined) landmarks[landmarkIndex] = normalizeLandmark(landmark);
    }
    const geometry = getMultiJointPoseGeometry({ landmarks });
    if (geometry === null) return;
    observations.push({
      temporaryId: `pose-${index}`,
      score: geometry.quality.score,
      landmarks,
      torsoCenter: geometry.torsoCenter,
      quality: geometry.quality,
    });
  });
  return observations;
}

async function initialize(request: InitializeVisionRequest): Promise<void> {
  const version = ++initializationVersion;
  lastTimestampMs = Number.NEGATIVE_INFINITY;
  lastInitializeRequest = request;

  try {
    poseLandmarker?.close();
    poseLandmarker = null;
    // This worker itself is an ES module. The classic Emscripten loader does
    // not expose `ModuleFactory` when it is dynamically imported from a module
    // worker, so explicitly select MediaPipe's module-compatible WASM loader.
    const fileset = await FilesetResolver.forVisionTasks(request.wasmRoot, true);
    const createLandmarker = (delegate: 'GPU' | 'CPU', canvas?: OffscreenCanvas) => {
      const runtime = selectPoseRuntimeConfig(request, delegate);
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: runtime.modelAssetPath,
          delegate,
        },
        ...(canvas === undefined ? {} : { canvas }),
        runningMode: 'VIDEO',
        numPoses: runtime.maxPoses,
        // Candidate quality is validated again from 17 head/body/hand anchors in the
        // tracker. Lower model gates keep a good head/shoulder/arm pose alive when
        // hips are outside the frame, while wrist scoring remains separately gated.
        minPoseDetectionConfidence: 0.35,
        minPosePresenceConfidence: 0.35,
        minTrackingConfidence: 0.4,
        outputSegmentationMasks: false,
      });
    };
    const created = request.forceBackend === 'cpu'
      ? {
          instance: await createLandmarker('CPU'),
          backend: 'cpu' as const,
        }
      : await createPoseBackendWithFallback(createLandmarker);
    const landmarker = created.instance;
    if (version !== initializationVersion) {
      landmarker.close();
      return;
    }
    poseLandmarker = landmarker;
    activeBackend = created.backend;
    const activeRuntime = selectPoseRuntimeConfig(
      request,
      activeBackend === 'gpu' ? 'GPU' : 'CPU',
    );
    activeMaxPoses = activeRuntime.maxPoses;
    activeModelTier = activeRuntime.modelTier;
    configurationBarrier = Promise.resolve();
    endpoint.postMessage({
      type: 'ready',
      backend: activeBackend,
      maxPoses: activeMaxPoses,
      modelTier: activeModelTier,
    });
  } catch (error) {
    if (version !== initializationVersion) return;
    postError(`姿態模型初始化失敗：${describeError(error)}`, false);
  }
}

async function configure(maxPoses: 2 | 3): Promise<void> {
  const landmarker = poseLandmarker;
  if (landmarker === null) {
    postError('姿態模型尚未就緒，無法調整推論負載。', true);
    return;
  }
  if (maxPoses === activeMaxPoses) {
    endpoint.postMessage({ type: 'configured', maxPoses });
    return;
  }
  try {
    await landmarker.setOptions({ numPoses: maxPoses });
    activeMaxPoses = maxPoses;
    endpoint.postMessage({ type: 'configured', maxPoses });
  } catch (error) {
    postError(`無法調整姿態推論負載：${describeError(error)}`, true);
  }
}

function processFrame(frame: FrameRequest): void {
  const landmarker = poseLandmarker;
  if (landmarker === null) {
    frame.bitmap.close();
    postError('姿態模型尚未就緒，請重新初始化。', true);
    return;
  }

  const startedAt = performance.now();
  const monotonicTimestamp = Math.max(frame.timestampMs, lastTimestampMs + 0.001);
  lastTimestampMs = monotonicTimestamp;
  try {
    let poses: PoseObservation[] = [];
    let detectedPoseCount = 0;
    landmarker.detectForVideo(frame.bitmap, monotonicTimestamp, (result) => {
      detectedPoseCount = result.landmarks.length;
      poses = toObservations(result.landmarks);
    });
    const inferenceMs = performance.now() - startedAt;
    const captureStartedAtMs = frame.captureStartedAtMs ?? frame.capturedAtMs ?? startedAt;
    const capturedAtMs = frame.capturedAtMs ?? captureStartedAtMs;
    const payload: PoseFrame = {
      type: 'poses',
      frameId: frame.frameId,
      timestampMs: frame.timestampMs,
      inferenceMs,
      detectedPoseCount,
      poses,
      performance: {
        captureMs: Math.max(0, capturedAtMs - captureStartedAtMs),
        workerQueueMs: Math.max(0, startedAt - capturedAtMs),
        inferenceMs,
        resultTransferMs: 0,
        pipelineMs: Math.max(0, performance.now() - frame.timestampMs),
        inputWidth: frame.bitmap.width,
        inputHeight: frame.bitmap.height,
        backend: activeBackend,
        maxPoses: activeMaxPoses,
        modelTier: activeModelTier,
      },
    };
    endpoint.postMessage(payload);
  } catch (error) {
    if (
      activeBackend === 'gpu' &&
      lastInitializeRequest !== null &&
      lastInitializeRequest.forceBackend !== 'cpu'
    ) {
      postError(
        `GPU 姿態推論失敗，正在改用 CPU：${describeError(error)}`,
        true,
        'reinitialize-cpu',
      );
      void initialize({ ...lastInitializeRequest, forceBackend: 'cpu' });
    } else {
      postError(`姿態推論失敗：${describeError(error)}`, true);
    }
  } finally {
    frame.bitmap.close();
  }
}

function reset(): void {
  // Keep the task timestamp monotonic across game rounds. MediaPipe's VIDEO
  // mode rejects timestamps older than the last frame even when game-level
  // player state has been reset.
}

endpoint.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'initialize':
      void initialize(message);
      break;
    case 'frame':
      // VisionClient guarantees one in-flight request. Processing directly
      // avoids the extra timer turn that previously added latency before every
      // synchronous MediaPipe call.
      void configurationBarrier.then(() => processFrame(message));
      break;
    case 'configure':
      configurationBarrier = configurationBarrier.then(() => configure(message.maxPoses));
      break;
    case 'reset':
      reset();
      break;
  }
});
