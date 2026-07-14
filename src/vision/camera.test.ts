import { describe, expect, it } from 'vitest';

import { CameraControllerError, toCameraControllerError } from './camera';
import {
  buildCameraVideoConstraints,
  chooseRecommendedCameraDevice,
  classifyCameraDeviceLabel,
  describeCameraDevices,
  isLikelyIPhoneContinuityCamera,
} from './camera-devices';

function videoDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: `group-${deviceId}`,
    kind: 'videoinput',
    label,
    toJSON: () => ({}),
  } as MediaDeviceInfo;
}

describe('camera error handling', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'not-readable'],
    ['OverconstrainedError', 'constraints'],
    ['SecurityError', 'unsupported'],
  ] as const)('maps %s to the host-facing %s code', (name, code) => {
    const result = toCameraControllerError({ name });
    expect(result).toBeInstanceOf(CameraControllerError);
    expect(result.code).toBe(code);
  });

  it('preserves a typed camera error instead of hiding its recovery policy', () => {
    const source = new CameraControllerError('playback', 'retry playback', true);
    expect(toCameraControllerError(source)).toBe(source);
  });
});

describe('camera device choices', () => {
  it.each([
    ["Amy's iPhone Camera", 'iphone-continuity'],
    ['iPhone 16 Pro', 'iphone-continuity'],
    ['接續互通相機', 'iphone-continuity'],
    ['FaceTime HD Camera', 'built-in'],
    ['MacBook Pro Camera', 'built-in'],
    ['Logitech BRIO', 'other'],
    ['', 'unknown'],
  ] as const)('classifies %j as %s', (label, category) => {
    expect(classifyCameraDeviceLabel(label)).toBe(category);
  });

  it('prioritizes a likely iPhone Continuity Camera without dropping other cameras', () => {
    const devices = [
      videoDevice('mac', 'FaceTime HD Camera'),
      videoDevice('usb', 'Logitech BRIO'),
      videoDevice('iphone', "Amy's iPhone Camera"),
    ];

    const choices = describeCameraDevices(devices);

    expect(choices.map(({ deviceId }) => deviceId)).toEqual(['iphone', 'usb', 'mac']);
    expect(choices[0]).toMatchObject({
      category: 'iphone-continuity',
      recommended: true,
      labelsAvailable: true,
    });
    expect(choices.filter(({ recommended }) => recommended)).toHaveLength(1);
    expect(chooseRecommendedCameraDevice(devices)?.deviceId).toBe('iphone');
    expect(isLikelyIPhoneContinuityCamera(devices[2]!)).toBe(true);
  });

  it('keeps unlabelled devices selectable and does not pretend their hardware type is known', () => {
    const choice = describeCameraDevices([videoDevice('private', '')])[0];

    expect(choice).toMatchObject({
      deviceId: 'private',
      category: 'unknown',
      labelsAvailable: false,
      recommended: true,
    });
    expect(choice?.displayLabel).toContain('尚未辨識');
  });
});

describe('camera capture constraints', () => {
  it('requests a selected camera near 720p30 without hard resolution or frame-rate limits', () => {
    expect(buildCameraVideoConstraints({ deviceId: 'iphone-camera' })).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      aspectRatio: { ideal: 16 / 9 },
      deviceId: { exact: 'iphone-camera' },
    });
  });

  it('does not add an exact device constraint when no picker choice exists', () => {
    const constraints = buildCameraVideoConstraints();
    expect(constraints.deviceId).toBeUndefined();
    expect(constraints.frameRate).toEqual({ ideal: 30 });
  });

  it('falls back from invalid custom capture values to the safe profile', () => {
    expect(
      buildCameraVideoConstraints({
        idealWidth: 0,
        idealHeight: Number.NaN,
        idealFrameRate: -1,
      }),
    ).toMatchObject({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  });
});
