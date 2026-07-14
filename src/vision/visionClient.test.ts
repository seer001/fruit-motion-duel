import { describe, expect, it, vi } from 'vitest';
import type {
  FrameRequest,
  VisionWorkerInbound,
  VisionWorkerOutbound,
} from '../types/game';
import {
  getPerformancePresetSettings,
  type PerformanceSettings,
} from '../config/performance';
import {
  calculateInferenceBitmapSize,
  VisionClient,
  type VisionWorkerPort,
} from './visionClient';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (resolvePromise === null) throw new Error('Deferred promise is not initialized');
      resolvePromise(value);
    },
  };
}

function fakeBitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeWorker implements VisionWorkerPort {
  readonly messages: VisionWorkerInbound[] = [];
  terminateCalls = 0;
  private readonly throwOnceTypes = new Set<VisionWorkerInbound['type']>();
  private readonly messageListeners = new Set<(event: MessageEvent<VisionWorkerOutbound>) => void>();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  postMessage(message: VisionWorkerInbound): void {
    if (this.throwOnceTypes.delete(message.type)) {
      throw new Error(`Synthetic ${message.type} postMessage failure`);
    }
    this.messages.push(message);
  }

  throwOnceOn(type: VisionWorkerInbound['type']): void {
    this.throwOnceTypes.add(type);
  }

  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<VisionWorkerOutbound>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<VisionWorkerOutbound>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent<VisionWorkerOutbound>) => void);
    } else {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  emit(message: VisionWorkerOutbound): void {
    const event = { data: message } as MessageEvent<VisionWorkerOutbound>;
    for (const listener of this.messageListeners) listener(event);
  }
}

async function readyClient(
  worker: FakeWorker,
  createBitmap: (source: ImageBitmapSource) => Promise<ImageBitmap>,
): Promise<VisionClient> {
  const client = new VisionClient({
    wasmRoot: 'http://localhost/vendor/mediapipe',
    modelPath: 'http://localhost/models/pose.task',
    workerFactory: () => worker,
    createBitmap,
  });
  const initializing = client.initialize();
  worker.emit({ type: 'ready' });
  await initializing;
  return client;
}

function customSettings(
  base: PerformanceSettings,
  overrides: Partial<Omit<PerformanceSettings, 'version' | 'preset'>>,
): PerformanceSettings {
  return { ...base, preset: 'custom', ...overrides };
}

describe('VisionClient latest-frame-wins scheduling', () => {
  it('downscales large frames without distorting their aspect ratio', () => {
    expect(calculateInferenceBitmapSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(calculateInferenceBitmapSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(calculateInferenceBitmapSize(720, 1280)).toEqual({ width: 360, height: 640 });
    expect(calculateInferenceBitmapSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(calculateInferenceBitmapSize(1920, 1080, 512)).toEqual({ width: 512, height: 288 });
    expect(calculateInferenceBitmapSize(1920, 1080, 768)).toEqual({ width: 768, height: 432 });
    expect(calculateInferenceBitmapSize(1920, 1080, 960)).toEqual({ width: 960, height: 540 });
  });

  it('requests the Auto Balanced GPU/CPU runtime with two candidates', async () => {
    const worker = new FakeWorker();
    const client = new VisionClient({
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    const initializing = client.initialize();
    const request = worker.messages[0];
    expect(request?.type).toBe('initialize');
    if (request?.type === 'initialize') {
      expect(request.maxPoses).toBe(2);
      expect(request.cpuMaxPoses).toBe(2);
      expect(request.modelPreference).toBe('auto');
      expect(request.modelPath).toContain('pose_landmarker_lite.task');
      expect(request.gpuModelPath).toContain('pose_landmarker_full.task');
    }
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;
    client.close();
  });

  it('does not classify a caller-supplied CPU model path as the GPU Full asset', async () => {
    const worker = new FakeWorker();
    const client = new VisionClient({
      modelPath: 'http://localhost/models/custom-lite.task',
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    const initializing = client.initialize();
    const request = worker.messages[0];
    expect(request?.type).toBe('initialize');
    if (request?.type === 'initialize') {
      expect(request.modelPath).toBe('http://localhost/models/custom-lite.task');
      expect(request.gpuModelPath).toContain('pose_landmarker_full.task');
      expect(request.gpuModelPath).not.toBe(request.modelPath);
    }
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;
    client.close();
  });

  it('safely rebuilds the Worker when model preference changes', async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const client = new VisionClient({
      workerFactory: () => {
        const worker = workers.shift();
        if (worker === undefined) throw new Error('Unexpected extra worker');
        return worker;
      },
      createBitmap: async () => fakeBitmap(),
    });
    const initializing = client.initialize();
    firstWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;

    const applying = client.applyPerformanceSettings(
      getPerformancePresetSettings('performance'),
    );
    expect(firstWorker.terminateCalls).toBe(1);
    expect(secondWorker.messages[0]).toMatchObject({
      type: 'initialize',
      modelPreference: 'lite',
      maxPoses: 2,
      cpuMaxPoses: 2,
    });
    secondWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'lite' });
    await applying;
    expect(client.settings.preset).toBe('performance');
    client.close();
  });

  it('rejects a superseded model apply while committing only the latest Worker', async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const thirdWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker, thirdWorker];
    const client = new VisionClient({
      workerFactory: () => {
        const worker = workers.shift();
        if (worker === undefined) throw new Error('Unexpected extra worker');
        return worker;
      },
      createBitmap: async () => fakeBitmap(),
    });
    const initializing = client.initialize();
    firstWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;

    const firstApply = client.applyPerformanceSettings(
      getPerformancePresetSettings('performance'),
    );
    const secondApply = client.applyPerformanceSettings(
      getPerformancePresetSettings('quality'),
    );
    expect(secondWorker.terminateCalls).toBe(1);
    expect(thirdWorker.messages[0]).toMatchObject({
      type: 'initialize',
      modelPreference: 'full',
      maxPoses: 3,
    });

    thirdWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await expect(firstApply).rejects.toThrow('superseded');
    await secondApply;
    expect(client.settings).toEqual(getPerformancePresetSettings('quality'));
    client.close();
  });

  it('applies settings before first initialization without creating another Worker', async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const client = new VisionClient({
      workerFactory: factory,
      createBitmap: async () => fakeBitmap(),
    });
    await client.applyPerformanceSettings(getPerformancePresetSettings('quality'));
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.terminateCalls).toBe(0);

    const initializing = client.initialize();
    expect(worker.messages[0]).toMatchObject({
      type: 'initialize',
      modelPreference: 'full',
      maxPoses: 3,
      cpuMaxPoses: 3,
    });
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await initializing;
    client.close();
  });

  it('does not duplicate bitmap capture while rebuilding a Worker', async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const oldSource = { id: 'old' } as unknown as ImageBitmapSource;
    const newSource = { id: 'new' } as unknown as ImageBitmapSource;
    const oldCapture = deferred<ImageBitmap>();
    const newCapture = deferred<ImageBitmap>();
    const createBitmap = vi.fn((source: ImageBitmapSource) => {
      if (source === oldSource) return oldCapture.promise;
      if (source === newSource) return newCapture.promise;
      throw new Error('Unexpected source');
    });
    const client = new VisionClient({
      workerFactory: () => {
        const worker = workers.shift();
        if (worker === undefined) throw new Error('Unexpected extra worker');
        return worker;
      },
      createBitmap,
    });
    const initializing = client.initialize();
    firstWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;

    client.submitFrame(oldSource, 10);
    expect(createBitmap).toHaveBeenCalledTimes(1);
    const applying = client.applyPerformanceSettings(
      getPerformancePresetSettings('performance'),
    );
    secondWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'lite' });
    await applying;
    client.submitFrame(newSource, 20);
    expect(createBitmap).toHaveBeenCalledTimes(1);

    const staleBitmap = fakeBitmap();
    oldCapture.resolve(staleBitmap);
    await flushPromises();
    expect(staleBitmap.close).toHaveBeenCalledOnce();
    expect(createBitmap).toHaveBeenCalledTimes(2);
    const currentBitmap = fakeBitmap();
    newCapture.resolve(currentBitmap);
    await flushPromises();
    expect(firstWorker.messages.filter((message) => message.type === 'frame')).toHaveLength(0);
    expect(secondWorker.messages.filter((message) => message.type === 'frame')).toHaveLength(1);
    client.close();
  });

  it('uses the selected bitmap dimension and reports actual runtime settings', async () => {
    const worker = new FakeWorker();
    const bitmap = fakeBitmap();
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    try {
      const settings = customSettings(getPerformancePresetSettings('balanced'), {
        inferenceMaxDimension: 960,
        inferenceTargetFps: 24,
      });
      const client = new VisionClient({
        wasmRoot: 'http://localhost/vendor/mediapipe',
        modelPath: 'http://localhost/models/lite.task',
        gpuModelPath: 'http://localhost/models/full.task',
        workerFactory: () => worker,
        performanceSettings: settings,
      });
      const received: VisionWorkerOutbound[] = [];
      client.onPoseFrame((frame) => received.push(frame));
      const initializing = client.initialize();
      worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
      await initializing;

      const source = { width: 1_920, height: 1_080 } as unknown as ImageBitmapSource;
      const timestampMs = performance.now();
      client.submitFrame(source, timestampMs);
      await flushPromises();
      expect(createImageBitmap).toHaveBeenCalledOnce();
      expect(createImageBitmap).toHaveBeenCalledWith(source, {
        resizeWidth: 960,
        resizeHeight: 540,
        resizeQuality: 'high',
      });
      const request = worker.messages.find(
        (message): message is FrameRequest => message.type === 'frame',
      );
      if (request === undefined) throw new Error('Expected one frame request');
      expect(worker.messages.filter((message) => message.type === 'frame')).toHaveLength(1);

      worker.emit({
        type: 'poses',
        frameId: request.frameId,
        timestampMs: request.timestampMs,
        inferenceMs: 20,
        poses: [],
        performance: {
          captureMs: 1,
          workerQueueMs: 1,
          inferenceMs: 20,
          resultTransferMs: 0,
          pipelineMs: 30,
          inputWidth: 960,
          inputHeight: 540,
          backend: 'gpu',
          maxPoses: 2,
          modelTier: 'full',
        },
      });
      const delivered = received[0];
      expect(delivered?.type).toBe('poses');
      if (delivered?.type !== 'poses') throw new Error('Expected a pose result');
      expect(delivered.performance).toMatchObject({
        backend: 'gpu',
        modelTier: 'full',
        maxPoses: 2,
        targetFps: 24,
        maximumInputDimension: 960,
      });
      client.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('feeds sustained calibration stall into Auto without adding a third candidate', async () => {
    const worker = new FakeWorker();
    const client = new VisionClient({
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    const received: VisionWorkerOutbound[] = [];
    client.onPoseFrame((frame) => received.push(frame));
    client.setExpectedPoseCount(2);
    const initializing = client.initialize();
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;

    for (let index = 0; index < 24; index += 1) {
      client.reportTrackedPoseCount(2);
      client.reportCalibrationStall(true);
      client.submitFrame(
        { id: `stall-${index}` } as unknown as ImageBitmapSource,
        performance.now(),
      );
      await flushPromises();
      const request = [...worker.messages]
        .reverse()
        .find((message): message is FrameRequest => message.type === 'frame');
      if (request === undefined) throw new Error('Expected a frame request');
      worker.emit({
        type: 'poses',
        frameId: request.frameId,
        timestampMs: request.timestampMs,
        inferenceMs: 30,
        detectedPoseCount: 2,
        poses: [],
        performance: {
          captureMs: 1,
          workerQueueMs: 1,
          inferenceMs: 30,
          resultTransferMs: 0,
          pipelineMs: 45,
          inputWidth: 640,
          inputHeight: 360,
          backend: 'gpu',
          maxPoses: 2,
          modelTier: 'full',
        },
      });
    }

    const latest = received.at(-1);
    expect(latest?.type).toBe('poses');
    if (latest?.type !== 'poses') throw new Error('Expected a pose result');
    expect(latest.performance).toMatchObject({
      adaptiveMode: 'gpu-balanced',
      diagnosis: 'recognition-limited',
      // Every runtime field describes this frame. gpu-quality applies next.
      maximumInputDimension: 640,
      maxPoses: 2,
    });
    expect(worker.messages.filter((message) => message.type === 'configure')).toHaveLength(0);
    client.close();
  });

  it('reports the Auto runtime FPS target without rebuilding the Worker', async () => {
    const worker = new FakeWorker();
    const client = new VisionClient({
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    const received: VisionWorkerOutbound[] = [];
    client.onPoseFrame((frame) => received.push(frame));
    const initializing = client.initialize();
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;
    client.setAutoRuntimePolicy({
      targetFps: 15,
      visionLoadReductionAllowed: false,
    });
    expect(client.inferenceTargetFps).toBe(15);
    expect(worker.terminateCalls).toBe(0);

    client.submitFrame(
      { id: 'auto-stage-3' } as unknown as ImageBitmapSource,
      performance.now(),
    );
    await flushPromises();
    const request = worker.messages.find(
      (message): message is FrameRequest => message.type === 'frame',
    );
    if (request === undefined) throw new Error('Expected a frame request');
    worker.emit({
      type: 'poses',
      frameId: request.frameId,
      timestampMs: request.timestampMs,
      inferenceMs: 40,
      poses: [],
      performance: {
        captureMs: 1,
        workerQueueMs: 1,
        inferenceMs: 40,
        resultTransferMs: 0,
        pipelineMs: 70,
        inputWidth: 640,
        inputHeight: 360,
        backend: 'gpu',
        maxPoses: 2,
        modelTier: 'full',
      },
    });
    const latest = received.at(-1);
    expect(latest?.type).toBe('poses');
    if (latest?.type !== 'poses') throw new Error('Expected a pose result');
    expect(latest.performance?.targetFps).toBe(15);
    client.close();
  });

  it('replaces a GPU worker that times out during initialization and ignores its late ready', async () => {
    vi.useFakeTimers();
    try {
      const gpuWorker = new FakeWorker();
      const cpuWorker = new FakeWorker();
      const workers = [gpuWorker, cpuWorker];
      const client = new VisionClient({
        workerFactory: () => {
          const worker = workers.shift();
          if (worker === undefined) throw new Error('Unexpected extra worker');
          return worker;
        },
        createBitmap: async () => fakeBitmap(),
        initializationTimeoutMs: 100,
      });
      const initializing = client.initialize();
      await vi.advanceTimersByTimeAsync(100);

      expect(gpuWorker.terminateCalls).toBe(1);
      expect(cpuWorker.messages[0]).toMatchObject({
        type: 'initialize',
        forceBackend: 'cpu',
      });
      gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
      expect(client.state).toBe('initializing');

      cpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
      await initializing;
      expect(client.state).toBe('ready');
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to CPU Lite while retaining the fixed preset candidate limit', async () => {
    vi.useFakeTimers();
    try {
      const gpuWorker = new FakeWorker();
      const cpuWorker = new FakeWorker();
      const workers = [gpuWorker, cpuWorker];
      const client = new VisionClient({
        workerFactory: () => {
          const worker = workers.shift();
          if (worker === undefined) throw new Error('Unexpected extra worker');
          return worker;
        },
        createBitmap: async () => fakeBitmap(),
        initializationTimeoutMs: 100,
        performanceSettings: getPerformancePresetSettings('quality'),
      });
      const initializing = client.initialize();
      expect(gpuWorker.messages[0]).toMatchObject({
        type: 'initialize',
        modelPreference: 'full',
        maxPoses: 3,
        cpuMaxPoses: 3,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(cpuWorker.messages[0]).toMatchObject({
        type: 'initialize',
        forceBackend: 'cpu',
        modelPreference: 'full',
        maxPoses: 3,
        cpuMaxPoses: 3,
      });
      cpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 3, modelTier: 'lite' });
      await initializing;
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not starve inference when bitmap capture finishes after a newer frame arrives', async () => {
    const worker = new FakeWorker();
    const sourceA = { id: 'a' } as unknown as ImageBitmapSource;
    const sourceB = { id: 'b' } as unknown as ImageBitmapSource;
    const sourceC = { id: 'c' } as unknown as ImageBitmapSource;
    const sourceD = { id: 'd' } as unknown as ImageBitmapSource;
    const captures = new Map<ImageBitmapSource, Deferred<ImageBitmap>>([
      [sourceA, deferred<ImageBitmap>()],
      [sourceD, deferred<ImageBitmap>()],
    ]);
    const createBitmap = vi.fn((source: ImageBitmapSource) => {
      const capture = captures.get(source);
      if (capture === undefined) throw new Error('Unexpected source capture');
      return capture.promise;
    });
    const client = await readyClient(worker, createBitmap);

    client.submitFrame(sourceA, 10);
    client.submitFrame(sourceB, 20);
    const bitmapA = fakeBitmap();
    captures.get(sourceA)?.resolve(bitmapA);
    await flushPromises();

    // Completing frame A must make forward progress. The previous policy
    // discarded it and restarted B; repeated slow captures could therefore
    // prevent any frame from ever reaching MediaPipe.
    expect(bitmapA.close).not.toHaveBeenCalled();
    expect(createBitmap).not.toHaveBeenCalledWith(sourceB);
    const firstFrame = worker.messages.find((message) => message.type === 'frame') as
      | FrameRequest
      | undefined;
    expect(firstFrame?.timestampMs).toBe(10);

    client.submitFrame(sourceC, 30);
    client.submitFrame(sourceD, 40);
    expect(createBitmap).not.toHaveBeenCalledWith(sourceC);
    expect(createBitmap).not.toHaveBeenCalledWith(sourceD);

    if (firstFrame === undefined) throw new Error('Expected a transferred frame');
    worker.emit({
      type: 'poses',
      frameId: firstFrame.frameId,
      timestampMs: firstFrame.timestampMs,
      inferenceMs: 5,
      poses: [],
    });
    expect(createBitmap).toHaveBeenCalledWith(sourceD);
    expect(createBitmap).not.toHaveBeenCalledWith(sourceC);
    client.close();
  });

  it('adds main-thread delivery timing without changing the capture timestamp', async () => {
    const worker = new FakeWorker();
    const client = await readyClient(worker, async () => fakeBitmap());
    const received: VisionWorkerOutbound[] = [];
    client.onPoseFrame((frame) => received.push(frame));
    const submittedAt = performance.now();
    client.submitFrame({ id: 'timed' } as unknown as ImageBitmapSource, submittedAt);
    await flushPromises();
    const request = worker.messages.find((message) => message.type === 'frame');
    if (request?.type !== 'frame') throw new Error('Expected a frame request');

    worker.emit({
      type: 'poses',
      frameId: request.frameId,
      timestampMs: request.timestampMs,
      inferenceMs: 7,
      poses: [],
      performance: {
        captureMs: 2,
        workerQueueMs: 1,
        inferenceMs: 7,
        resultTransferMs: 0,
        pipelineMs: 10,
        inputWidth: 640,
        inputHeight: 360,
        backend: 'gpu',
      },
    });

    const frame = received[0];
    expect(frame?.type).toBe('poses');
    if (frame?.type !== 'poses') throw new Error('Expected a pose frame');
    expect(frame.timestampMs).toBe(submittedAt);
    expect(frame.performance?.pipelineMs).toBeGreaterThanOrEqual(0);
    expect(frame.performance?.resultTransferMs).toBeGreaterThanOrEqual(0);
    client.close();
  });

  it('closes a capture completed after reset instead of sending a stale frame', async () => {
    const worker = new FakeWorker();
    const source = { id: 'stale' } as unknown as ImageBitmapSource;
    const capture = deferred<ImageBitmap>();
    const client = await readyClient(worker, () => capture.promise);

    client.submitFrame(source, 10);
    client.reset();
    const bitmap = fakeBitmap();
    capture.resolve(bitmap);
    await flushPromises();

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.messages.filter((message) => message.type === 'frame')).toHaveLength(0);
    client.close();
  });

  it('waits for a candidate configuration acknowledgement without leaving inference stuck', async () => {
    const worker = new FakeWorker();
    const quality = getPerformancePresetSettings('quality');
    const client = new VisionClient({
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
      performanceSettings: quality,
    });
    const initializing = client.initialize();
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await initializing;

    const applying = client.applyPerformanceSettings(customSettings(quality, {
      maximumPoseCandidates: 2,
      spectatorReserve: false,
    }));
    const configure = worker.messages.findLast((message) => message.type === 'configure');
    expect(configure).toEqual({ type: 'configure', maxPoses: 2 });
    const frameCountBeforeAck = worker.messages.filter((message) => message.type === 'frame').length;
    client.submitFrame({ id: 'held' } as unknown as ImageBitmapSource, performance.now());
    await flushPromises();
    expect(worker.messages.filter((message) => message.type === 'frame')).toHaveLength(
      frameCountBeforeAck,
    );

    worker.emit({ type: 'configured', maxPoses: 2 });
    await applying;
    await flushPromises();
    expect(worker.messages.filter((message) => message.type === 'frame')).toHaveLength(
      frameCountBeforeAck + 1,
    );
    client.close();
  });

  it('waits for the final candidate acknowledgement when an apply is superseded', async () => {
    const worker = new FakeWorker();
    const quality = getPerformancePresetSettings('quality');
    const client = new VisionClient({
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
      performanceSettings: quality,
    });
    const initializing = client.initialize();
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await initializing;

    const firstApply = client.applyPerformanceSettings(customSettings(quality, {
      maximumPoseCandidates: 2,
      spectatorReserve: false,
    }));
    const firstOutcome = firstApply.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    let secondResolved = false;
    const secondApply = client.applyPerformanceSettings(quality).then(() => {
      secondResolved = true;
    });
    expect(await firstOutcome).toBe('rejected');
    expect(worker.messages.filter((message) => message.type === 'configure')).toEqual([
      { type: 'configure', maxPoses: 2 },
    ]);
    expect(secondResolved).toBe(false);

    worker.emit({ type: 'configured', maxPoses: 2 });
    await flushPromises();
    expect(worker.messages.filter((message) => message.type === 'configure')).toEqual([
      { type: 'configure', maxPoses: 2 },
      { type: 'configure', maxPoses: 3 },
    ]);
    expect(secondResolved).toBe(false);

    worker.emit({ type: 'configured', maxPoses: 3 });
    await secondApply;
    expect(secondResolved).toBe(true);
    expect(client.settings).toEqual(quality);
    client.close();
  });

  it('rolls back settings and restores the fixed candidate target after configure fails', async () => {
    const gpuWorker = new FakeWorker();
    const cpuWorker = new FakeWorker();
    const workers = [gpuWorker, cpuWorker];
    const quality = getPerformancePresetSettings('quality');
    const client = new VisionClient({
      workerFactory: () => {
        const worker = workers.shift();
        if (worker === undefined) throw new Error('Unexpected extra worker');
        return worker;
      },
      createBitmap: async () => fakeBitmap(),
      performanceSettings: quality,
    });
    const initializing = client.initialize();
    gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await initializing;

    const applying = client.applyPerformanceSettings(customSettings(quality, {
      maximumPoseCandidates: 2,
      spectatorReserve: false,
    }));
    gpuWorker.emit({
      type: 'error',
      message: 'Synthetic configure failure',
      recoverable: true,
    });
    await expect(applying).rejects.toThrow('Synthetic configure failure');
    expect(client.settings).toEqual(quality);
    expect(cpuWorker.messages[0]).toMatchObject({
      type: 'initialize',
      forceBackend: 'cpu',
      cpuMaxPoses: 2,
    });

    cpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
    expect(cpuWorker.messages.findLast((message) => message.type === 'configure')).toEqual({
      type: 'configure',
      maxPoses: 3,
    });
    cpuWorker.emit({ type: 'configured', maxPoses: 3 });
    expect(client.state).toBe('ready');
    client.close();
  });

  it('recovers rather than sticking when configure postMessage throws', async () => {
    const gpuWorker = new FakeWorker();
    const cpuWorker = new FakeWorker();
    const workers = [gpuWorker, cpuWorker];
    const quality = getPerformancePresetSettings('quality');
    const client = new VisionClient({
      workerFactory: () => {
        const worker = workers.shift();
        if (worker === undefined) throw new Error('Unexpected extra worker');
        return worker;
      },
      createBitmap: async () => fakeBitmap(),
      performanceSettings: quality,
    });
    const initializing = client.initialize();
    gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await initializing;
    gpuWorker.throwOnceOn('configure');

    const applying = client.applyPerformanceSettings(customSettings(quality, {
      maximumPoseCandidates: 2,
      spectatorReserve: false,
    }));
    await expect(applying).rejects.toThrow('Synthetic configure postMessage failure');
    expect(client.settings).toEqual(quality);
    expect(gpuWorker.terminateCalls).toBe(1);
    expect(cpuWorker.messages[0]).toMatchObject({ type: 'initialize', forceBackend: 'cpu' });
    cpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
    cpuWorker.emit({ type: 'configured', maxPoses: 3 });
    client.close();
  });

  it('recovers on CPU when a load-configuration acknowledgement never arrives', async () => {
    vi.useFakeTimers();
    try {
      const gpuWorker = new FakeWorker();
      const cpuWorker = new FakeWorker();
      const workers = [gpuWorker, cpuWorker];
      const client = new VisionClient({
        workerFactory: () => {
          const worker = workers.shift();
          if (worker === undefined) throw new Error('Unexpected extra worker');
          return worker;
        },
        createBitmap: async () => fakeBitmap(),
        frameTimeoutMs: 500,
        performanceSettings: getPerformancePresetSettings('quality'),
      });
      const initializing = client.initialize();
      gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
      await initializing;

      const applying = client.applyPerformanceSettings(customSettings(
        getPerformancePresetSettings('quality'),
        { maximumPoseCandidates: 2, spectatorReserve: false },
      ));
      const applyResult = applying.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      expect(gpuWorker.messages.findLast((message) => message.type === 'configure')).toEqual({
        type: 'configure',
        maxPoses: 2,
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(gpuWorker.terminateCalls).toBe(1);
      expect(cpuWorker.messages[0]).toMatchObject({
        type: 'initialize',
        forceBackend: 'cpu',
        cpuMaxPoses: 2,
      });
      cpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
      expect(await applyResult).toBe('rejected');
      expect(client.settings).toEqual(getPerformancePresetSettings('quality'));
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('can initialize again after a terminal CPU initialization failure', async () => {
    vi.useFakeTimers();
    try {
      const gpuWorker = new FakeWorker();
      const firstCpuWorker = new FakeWorker();
      const retryCpuWorker = new FakeWorker();
      const workers = [gpuWorker, firstCpuWorker, retryCpuWorker];
      const client = new VisionClient({
        workerFactory: () => {
          const worker = workers.shift();
          if (worker === undefined) throw new Error('Unexpected extra worker');
          return worker;
        },
        createBitmap: async () => fakeBitmap(),
        initializationTimeoutMs: 100,
      });
      const firstInitialization = client.initialize();
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(firstInitialization).rejects.toThrow('初始化逾時');
      expect(client.state).toBe('error');

      const retry = client.initialize();
      expect(retryCpuWorker.messages[0]).toMatchObject({
        type: 'initialize',
        forceBackend: 'cpu',
      });
      retryCpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
      await retry;
      expect(client.state).toBe('ready');
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('can retry after workerFactory and initialize postMessage failures', async () => {
    const initialWorker = new FakeWorker();
    const retryWorker = new FakeWorker();
    const finalWorker = new FakeWorker();
    retryWorker.throwOnceOn('initialize');
    let factoryCalls = 0;
    const client = new VisionClient({
      workerFactory: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) return initialWorker;
        if (factoryCalls === 2) throw new Error('Synthetic workerFactory failure');
        if (factoryCalls === 3) return retryWorker;
        return finalWorker;
      },
      createBitmap: async () => fakeBitmap(),
    });
    const initializing = client.initialize();
    initialWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
    await initializing;
    await expect(client.applyPerformanceSettings(
      getPerformancePresetSettings('performance'),
    )).rejects.toThrow('Synthetic workerFactory failure');
    expect(client.settings).toEqual(getPerformancePresetSettings('auto'));

    await expect(client.initialize()).rejects.toThrow('Synthetic initialize postMessage failure');
    expect(client.state).toBe('error');

    const retry = client.initialize();
    finalWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
    await retry;
    expect(client.state).toBe('ready');
    client.close();
  });

  it('terminates an unresponsive GPU worker and initializes a fresh CPU worker', async () => {
    vi.useFakeTimers();
    try {
      const gpuWorker = new FakeWorker();
      const cpuWorker = new FakeWorker();
      const workers = [gpuWorker, cpuWorker];
      const client = new VisionClient({
        workerFactory: () => {
          const worker = workers.shift();
          if (worker === undefined) throw new Error('Unexpected extra worker');
          return worker;
        },
        createBitmap: async () => fakeBitmap(),
        frameTimeoutMs: 500,
      });
      const initializing = client.initialize();
      gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 2, modelTier: 'full' });
      await initializing;
      client.submitFrame({ id: 'hung' } as unknown as ImageBitmapSource, performance.now());
      await flushPromises();
      expect(gpuWorker.messages.some((message) => message.type === 'frame')).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(gpuWorker.terminateCalls).toBe(1);
      const recovery = cpuWorker.messages[0];
      expect(recovery).toMatchObject({ type: 'initialize', forceBackend: 'cpu', cpuMaxPoses: 2 });

      cpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
      client.submitFrame({ id: 'recovered' } as unknown as ImageBitmapSource, performance.now());
      await flushPromises();
      expect(cpuWorker.messages.some((message) => message.type === 'frame')).toBe(true);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
