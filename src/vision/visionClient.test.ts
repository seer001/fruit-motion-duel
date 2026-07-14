import { describe, expect, it, vi } from 'vitest';
import type {
  FrameRequest,
  VisionWorkerInbound,
  VisionWorkerOutbound,
} from '../types/game';
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
  private readonly messageListeners = new Set<(event: MessageEvent<VisionWorkerOutbound>) => void>();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  postMessage(message: VisionWorkerInbound): void {
    this.messages.push(message);
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

describe('VisionClient latest-frame-wins scheduling', () => {
  it('downscales large frames without distorting their aspect ratio', () => {
    expect(calculateInferenceBitmapSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(calculateInferenceBitmapSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(calculateInferenceBitmapSize(720, 1280)).toEqual({ width: 360, height: 640 });
    expect(calculateInferenceBitmapSize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it('requests GPU Full with three candidates and caps the CPU Lite fallback at two', async () => {
    const worker = new FakeWorker();
    const client = new VisionClient({
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    const initializing = client.initialize();
    const request = worker.messages[0];
    expect(request?.type).toBe('initialize');
    if (request?.type === 'initialize') {
      expect(request.maxPoses).toBe(3);
      expect(request.cpuMaxPoses).toBe(2);
      expect(request.modelPath).toContain('pose_landmarker_lite.task');
      expect(request.gpuModelPath).toContain('pose_landmarker_full.task');
    }
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await initializing;
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
      gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
      expect(client.state).toBe('initializing');

      cpuWorker.emit({ type: 'ready', backend: 'cpu', maxPoses: 2, modelTier: 'lite' });
      await initializing;
      expect(client.state).toBe('ready');
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

  it('waits for a configured acknowledgement without leaving inference stuck', async () => {
    const worker = new FakeWorker();
    const client = new VisionClient({
      workerFactory: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    client.setExpectedPoseCount(2);
    const initializing = client.initialize();
    worker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
    await initializing;

    for (let index = 0; index < 12; index += 1) {
      client.submitFrame(
        { id: `slow-${index}` } as unknown as ImageBitmapSource,
        performance.now(),
      );
      await flushPromises();
      const frame = [...worker.messages]
        .reverse()
        .find((message): message is FrameRequest => message.type === 'frame');
      if (frame === undefined) throw new Error('Expected a frame request');
      worker.emit({
        type: 'poses',
        frameId: frame.frameId,
        timestampMs: frame.timestampMs,
        inferenceMs: 100,
        poses: [],
        performance: {
          captureMs: 1,
          workerQueueMs: 1,
          inferenceMs: 100,
          resultTransferMs: 0,
          pipelineMs: 150,
          inputWidth: 768,
          inputHeight: 432,
          backend: 'gpu',
          maxPoses: 3,
          modelTier: 'full',
        },
      });
    }

    const configure = worker.messages.findLast((message) => message.type === 'configure');
    expect(configure).toEqual({ type: 'configure', maxPoses: 2 });
    const frameCountBeforeAck = worker.messages.filter((message) => message.type === 'frame').length;
    client.submitFrame({ id: 'held' } as unknown as ImageBitmapSource, performance.now());
    await flushPromises();
    expect(worker.messages.filter((message) => message.type === 'frame')).toHaveLength(
      frameCountBeforeAck,
    );

    worker.emit({ type: 'configured', maxPoses: 2 });
    await flushPromises();
    expect(worker.messages.filter((message) => message.type === 'frame')).toHaveLength(
      frameCountBeforeAck + 1,
    );
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
      });
      client.setExpectedPoseCount(2);
      const initializing = client.initialize();
      gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
      await initializing;

      for (let index = 0; index < 12; index += 1) {
        client.submitFrame(
          { id: `slow-config-${index}` } as unknown as ImageBitmapSource,
          performance.now(),
        );
        await flushPromises();
        const frame = [...gpuWorker.messages]
          .reverse()
          .find((message): message is FrameRequest => message.type === 'frame');
        if (frame === undefined) throw new Error('Expected a frame request');
        gpuWorker.emit({
          type: 'poses',
          frameId: frame.frameId,
          timestampMs: frame.timestampMs,
          inferenceMs: 100,
          poses: [],
          performance: {
            captureMs: 1,
            workerQueueMs: 1,
            inferenceMs: 100,
            resultTransferMs: 0,
            pipelineMs: 150,
            inputWidth: 768,
            inputHeight: 432,
            backend: 'gpu',
            maxPoses: 3,
            modelTier: 'full',
          },
        });
      }

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
      client.close();
    } finally {
      vi.useRealTimers();
    }
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
      gpuWorker.emit({ type: 'ready', backend: 'gpu', maxPoses: 3, modelTier: 'full' });
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
