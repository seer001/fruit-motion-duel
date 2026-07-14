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
});

