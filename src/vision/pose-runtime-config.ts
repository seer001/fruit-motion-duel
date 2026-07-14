import type { InitializeVisionRequest } from '../types/game';

export interface PoseRuntimeConfig {
  modelAssetPath: string;
  modelTier: 'lite' | 'full';
  maxPoses: 2 | 3;
}

/** Selects the model before task creation; models are never hot-swapped. */
export function selectPoseRuntimeConfig(
  request: InitializeVisionRequest,
  delegate: 'GPU' | 'CPU',
): PoseRuntimeConfig {
  if (delegate === 'GPU' && request.forceBackend !== 'cpu') {
    return {
      modelAssetPath: request.gpuModelPath ?? request.modelPath,
      modelTier: request.gpuModelPath === undefined ? 'lite' : 'full',
      maxPoses: request.maxPoses,
    };
  }
  return {
    modelAssetPath: request.modelPath,
    modelTier: 'lite',
    maxPoses: request.cpuMaxPoses ?? 2,
  };
}

