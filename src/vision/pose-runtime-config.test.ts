import { describe, expect, it } from 'vitest';
import type { InitializeVisionRequest } from '../types/game';
import { selectPoseRuntimeConfig } from './pose-runtime-config';

const request: InitializeVisionRequest = {
  type: 'initialize',
  wasmRoot: '/wasm',
  modelPath: '/pose-lite.task',
  gpuModelPath: '/pose-full.task',
  maxPoses: 3,
  cpuMaxPoses: 2,
};

describe('selectPoseRuntimeConfig', () => {
  it('uses Full and one spectator slot on a working GPU', () => {
    expect(selectPoseRuntimeConfig(request, 'GPU')).toEqual({
      modelAssetPath: '/pose-full.task',
      modelTier: 'full',
      maxPoses: 3,
    });
  });

  it('uses Lite and only two player candidates on CPU fallback', () => {
    expect(selectPoseRuntimeConfig(request, 'CPU')).toEqual({
      modelAssetPath: '/pose-lite.task',
      modelTier: 'lite',
      maxPoses: 2,
    });
  });

  it('cannot accidentally select the GPU model after a forced CPU recovery', () => {
    expect(selectPoseRuntimeConfig({ ...request, forceBackend: 'cpu' }, 'GPU')).toEqual({
      modelAssetPath: '/pose-lite.task',
      modelTier: 'lite',
      maxPoses: 2,
    });
  });

  it('honours an explicit Lite preference even when a GPU is available', () => {
    expect(selectPoseRuntimeConfig({ ...request, modelPreference: 'lite' }, 'GPU')).toEqual({
      modelAssetPath: '/pose-lite.task',
      modelTier: 'lite',
      maxPoses: 3,
    });
  });

  it('uses explicit Full on GPU and still falls back to Lite on CPU', () => {
    const qualityRequest: InitializeVisionRequest = {
      ...request,
      modelPreference: 'full',
      maxPoses: 3,
      cpuMaxPoses: 3,
    };
    expect(selectPoseRuntimeConfig(qualityRequest, 'GPU')).toMatchObject({
      modelAssetPath: '/pose-full.task',
      modelTier: 'full',
      maxPoses: 3,
    });
    expect(selectPoseRuntimeConfig(qualityRequest, 'CPU')).toMatchObject({
      modelAssetPath: '/pose-lite.task',
      modelTier: 'lite',
      maxPoses: 3,
    });
  });

  it('falls back to Lite when a requested GPU model asset is unavailable', () => {
    const { gpuModelPath: _omitted, ...withoutGpuModel } = request;
    expect(selectPoseRuntimeConfig({
      ...withoutGpuModel,
      modelPreference: 'full',
    }, 'GPU')).toEqual({
      modelAssetPath: '/pose-lite.task',
      modelTier: 'lite',
      maxPoses: 3,
    });
  });
});
