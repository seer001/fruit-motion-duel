export type CameraDeviceCategory =
  | 'iphone-continuity'
  | 'other'
  | 'built-in'
  | 'unknown';

export interface CameraDeviceChoice {
  readonly info: MediaDeviceInfo;
  readonly deviceId: string;
  readonly groupId: string;
  readonly rawLabel: string;
  readonly displayLabel: string;
  readonly category: CameraDeviceCategory;
  readonly recommended: boolean;
  readonly labelsAvailable: boolean;
}

export interface CameraConstraintOptions {
  deviceId?: string;
  idealWidth?: number;
  idealHeight?: number;
  idealFrameRate?: number;
}

export const DEFAULT_CAMERA_CAPTURE_PROFILE = Object.freeze({
  width: 1280,
  height: 720,
  frameRate: 30,
});

const IPHONE_CAMERA_PATTERNS = [
  /\biphone\b/i,
  /continuity\s+camera/i,
  /接續互通相機/i,
  /连续互通相机/i,
  /連續互通相機/i,
];

const BUILT_IN_CAMERA_PATTERNS = [
  /facetime/i,
  /built[ -]?in/i,
  /integrated/i,
  /macbook/i,
  /內建.*(?:相機|鏡頭)/i,
  /内置.*(?:相机|镜头)/i,
];

function hasMatch(label: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(label));
}

/**
 * Device labels are intentionally treated as hints. The Media Capture standard
 * explicitly says applications cannot assume a label contains a model or type.
 */
export function classifyCameraDeviceLabel(label: string): CameraDeviceCategory {
  const normalized = label.trim();
  if (normalized.length === 0) return 'unknown';
  if (hasMatch(normalized, IPHONE_CAMERA_PATTERNS)) return 'iphone-continuity';
  if (hasMatch(normalized, BUILT_IN_CAMERA_PATTERNS)) return 'built-in';
  return 'other';
}

export function isLikelyIPhoneContinuityCamera(
  device: Pick<MediaDeviceInfo, 'kind' | 'label'>,
): boolean {
  return device.kind === 'videoinput' && classifyCameraDeviceLabel(device.label) === 'iphone-continuity';
}

function categoryRank(category: CameraDeviceCategory): number {
  switch (category) {
    case 'iphone-continuity':
      return 0;
    case 'other':
      return 1;
    case 'built-in':
      return 2;
    case 'unknown':
      return 3;
  }
}

function categorySuffix(category: CameraDeviceCategory): string {
  switch (category) {
    case 'iphone-continuity':
      return 'iPhone 接續互通';
    case 'other':
      return '其他鏡頭';
    case 'built-in':
      return 'Mac 內建';
    case 'unknown':
      return '尚未辨識';
  }
}

/**
 * Returns picker-friendly choices, preferring Continuity Camera, then other
 * labelled cameras, while preserving the browser's order within each category.
 */
export function describeCameraDevices(
  devices: readonly MediaDeviceInfo[],
): CameraDeviceChoice[] {
  const choices = devices
    .filter(({ kind }) => kind === 'videoinput')
    .map((info, originalIndex) => ({
      info,
      originalIndex,
      category: classifyCameraDeviceLabel(info.label),
    }))
    .sort(
      (left, right) =>
        categoryRank(left.category) - categoryRank(right.category) ||
        left.originalIndex - right.originalIndex,
    );

  return choices.map(({ info, category }, index) => {
    const rawLabel = info.label.trim();
    const baseLabel = rawLabel || `攝影機 ${index + 1}`;
    return {
      info,
      deviceId: info.deviceId,
      groupId: info.groupId,
      rawLabel,
      displayLabel: `${baseLabel}（${categorySuffix(category)}${index === 0 ? '・建議' : ''}）`,
      category,
      recommended: index === 0,
      labelsAvailable: rawLabel.length > 0,
    };
  });
}

export function chooseRecommendedCameraDevice(
  devices: readonly MediaDeviceInfo[],
): CameraDeviceChoice | null {
  return describeCameraDevices(devices)[0] ?? null;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Requests a landscape frame near 720p30 without making resolution or frame
 * rate mandatory. A user-selected device ID remains exact so the browser never
 * silently switches from the chosen iPhone or external camera.
 */
export function buildCameraVideoConstraints(
  options: CameraConstraintOptions = {},
): MediaTrackConstraints {
  const width = positiveOrDefault(options.idealWidth, DEFAULT_CAMERA_CAPTURE_PROFILE.width);
  const height = positiveOrDefault(options.idealHeight, DEFAULT_CAMERA_CAPTURE_PROFILE.height);
  const frameRate = positiveOrDefault(
    options.idealFrameRate,
    DEFAULT_CAMERA_CAPTURE_PROFILE.frameRate,
  );
  const deviceId = options.deviceId?.trim();

  return {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: frameRate },
    aspectRatio: { ideal: width / height },
    ...(deviceId === undefined || deviceId.length === 0
      ? {}
      : { deviceId: { exact: deviceId } }),
  };
}
