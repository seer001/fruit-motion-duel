export type PoseBackend = 'gpu' | 'cpu';

export interface PoseBackendResult<T> {
  instance: T;
  backend: PoseBackend;
  /** Retained for diagnostics without making a successful CPU fallback noisy. */
  gpuError?: unknown;
}

interface GpuCanvasResource {
  canvas: OffscreenCanvas;
  release(): void;
}

export interface PoseBackendFallbackOptions {
  createGpuCanvas?: () => GpuCanvasResource | null;
}

function defaultGpuCanvas(): GpuCanvasResource | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(1, 1);
  return {
    canvas,
    release(): void {
      // MediaPipe owns the context while the task is alive. If GPU task
      // creation fails, explicitly lose the abandoned context before the CPU
      // retry so repeated initialization does not accumulate GPU resources.
      const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/**
 * Prefer the GPU delegate in a vision worker, while keeping CPU as a reliable
 * fallback for browsers that cannot create an OffscreenCanvas WebGL context.
 */
export async function createPoseBackendWithFallback<T>(
  create: (delegate: 'GPU' | 'CPU', canvas?: OffscreenCanvas) => Promise<T>,
  options: PoseBackendFallbackOptions = {},
): Promise<PoseBackendResult<T>> {
  const gpuResource = (options.createGpuCanvas ?? defaultGpuCanvas)();
  let gpuError: unknown;

  if (gpuResource !== null) {
    try {
      return {
        instance: await create('GPU', gpuResource.canvas),
        backend: 'gpu',
      };
    } catch (error) {
      gpuError = error;
      gpuResource.release();
    }
  }

  try {
    return {
      instance: await create('CPU'),
      backend: 'cpu',
      ...(gpuError === undefined ? {} : { gpuError }),
    };
  } catch (cpuError) {
    if (gpuError === undefined) throw cpuError;
    throw new AggregateError(
      [gpuError, cpuError],
      'GPU and CPU pose backends both failed to initialize',
    );
  }
}
