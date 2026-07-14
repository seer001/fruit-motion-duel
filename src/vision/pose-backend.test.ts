import { describe, expect, it, vi } from 'vitest';
import { createPoseBackendWithFallback } from './pose-backend';

function gpuResource(release = vi.fn()) {
  return {
    canvas: { id: 'gpu-canvas' } as unknown as OffscreenCanvas,
    release,
  };
}

describe('pose backend initialization', () => {
  it('uses the GPU delegate when OffscreenCanvas initialization succeeds', async () => {
    const resource = gpuResource();
    const create = vi.fn(async (delegate: 'GPU' | 'CPU') => ({ delegate }));

    const result = await createPoseBackendWithFallback(create, {
      createGpuCanvas: () => resource,
    });

    expect(result).toMatchObject({ backend: 'gpu', instance: { delegate: 'GPU' } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(resource.release).not.toHaveBeenCalled();
  });

  it('releases a failed GPU context before falling back to CPU', async () => {
    const resource = gpuResource();
    const gpuFailure = new Error('WebGL unavailable');
    const create = vi.fn(async (delegate: 'GPU' | 'CPU') => {
      if (delegate === 'GPU') throw gpuFailure;
      return { delegate };
    });

    const result = await createPoseBackendWithFallback(create, {
      createGpuCanvas: () => resource,
    });

    expect(result).toMatchObject({ backend: 'cpu', instance: { delegate: 'CPU' }, gpuError: gpuFailure });
    expect(resource.release).toHaveBeenCalledOnce();
    expect(create.mock.calls.map(([delegate]) => delegate)).toEqual(['GPU', 'CPU']);
  });

  it('reports both failures and still releases the abandoned GPU context', async () => {
    const resource = gpuResource();
    const create = vi.fn(async (delegate: 'GPU' | 'CPU') => {
      throw new Error(`${delegate} failed`);
    });

    await expect(
      createPoseBackendWithFallback(create, { createGpuCanvas: () => resource }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(resource.release).toHaveBeenCalledOnce();
  });
});
