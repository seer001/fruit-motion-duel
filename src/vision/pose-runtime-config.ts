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
    const useLite = request.modelPreference === 'lite' || request.gpuModelPath === undefined;
    return {
      modelAssetPath: useLite ? request.modelPath : request.gpuModelPath!,
      modelTier: useLite ? 'lite' : 'full',
      maxPoses: request.maxPoses,
    };
  }
  return {
    modelAssetPath: request.modelPath,
    modelTier: 'lite',
    maxPoses: request.cpuMaxPoses ?? 2,
  };
}
