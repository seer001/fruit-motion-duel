import {
  buildCameraVideoConstraints,
  classifyCameraDeviceLabel,
  describeCameraDevices,
  type CameraDeviceCategory,
  type CameraDeviceChoice,
} from './camera-devices';

export type CameraErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'not-found'
  | 'not-readable'
  | 'constraints'
  | 'playback'
  | 'aborted'
  | 'unknown';

export class CameraControllerError extends Error {
  readonly code: CameraErrorCode;
  readonly recoverable: boolean;

  constructor(code: CameraErrorCode, message: string, recoverable: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CameraControllerError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface CameraControllerOptions {
  mediaDevices?: MediaDevices;
  idealWidth?: number;
  idealHeight?: number;
  idealFrameRate?: number;
  metadataTimeoutMs?: number;
}

export interface CameraSession {
  stream: MediaStream;
  track: MediaStreamTrack;
  deviceId: string | null;
  deviceLabel: string;
  deviceCategory: CameraDeviceCategory;
  width: number;
  height: number;
  frameRate: number;
}

function getDomExceptionName(error: unknown): string | null {
  if (error instanceof DOMException) return error.name;
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

export function toCameraControllerError(error: unknown): CameraControllerError {
  if (error instanceof CameraControllerError) return error;
  const name = getDomExceptionName(error);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new CameraControllerError(
        'permission-denied',
        '攝影機權限遭拒；請在瀏覽器與作業系統設定中允許後重試。',
        true,
        error,
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraControllerError(
        'not-found',
        '找不到可用攝影機；請接上攝影機後重試。',
        true,
        error,
      );
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraControllerError(
        'not-readable',
        '攝影機目前無法讀取，可能正被其他程式使用；關閉其他程式後重試。',
        true,
        error,
      );
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraControllerError(
        'constraints',
        '攝影機不支援要求的影像模式；請改選其他裝置。',
        true,
        error,
      );
    case 'AbortError':
      return new CameraControllerError('aborted', '攝影機啟動已中止，請重試。', true, error);
    case 'SecurityError':
    case 'TypeError':
      return new CameraControllerError(
        'unsupported',
        '此頁面無法使用攝影機；請改用 HTTPS 或 localhost 開啟。',
        false,
        error,
      );
    default:
      return new CameraControllerError('unknown', '攝影機啟動失敗，請重新選擇裝置。', true, error);
  }
}

export class CameraController {
  private readonly mediaDevices: MediaDevices | null;
  private readonly idealWidth: number;
  private readonly idealHeight: number;
  private readonly idealFrameRate: number;
  private readonly metadataTimeoutMs: number;
  private currentSession: CameraSession | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    options: CameraControllerOptions = {},
  ) {
    this.mediaDevices =
      options.mediaDevices ??
      (typeof navigator === 'undefined' ? null : (navigator.mediaDevices ?? null));
    this.idealWidth = options.idealWidth ?? 1280;
    this.idealHeight = options.idealHeight ?? 720;
    this.idealFrameRate = options.idealFrameRate ?? 30;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 8_000;

    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
  }

  get session(): CameraSession | null {
    return this.currentSession;
  }

  get stream(): MediaStream | null {
    return this.currentSession?.stream ?? null;
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    const mediaDevices = this.requireMediaDevices();
    try {
      const devices = await mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'videoinput');
    } catch (error) {
      throw toCameraControllerError(error);
    }
  }

  async listCameraChoices(): Promise<CameraDeviceChoice[]> {
    return describeCameraDevices(await this.listDevices());
  }

  async start(deviceId?: string): Promise<CameraSession> {
    const mediaDevices = this.requireMediaDevices();
    this.stop();

    const videoConstraints = buildCameraVideoConstraints({
      idealWidth: this.idealWidth,
      idealHeight: this.idealHeight,
      idealFrameRate: this.idealFrameRate,
      ...(deviceId === undefined ? {} : { deviceId }),
    });

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (error) {
      throw toCameraControllerError(error);
    }

    try {
      this.video.srcObject = stream;
      await this.waitForMetadata();
      await this.video.play();
      const track = stream.getVideoTracks()[0];
      if (track === undefined) {
        throw new CameraControllerError(
          'not-found',
          '攝影機沒有提供影像軌；請重新接上裝置後重試。',
          true,
        );
      }
      const settings = track.getSettings();
      const session: CameraSession = {
        stream,
        track,
        deviceId: settings.deviceId ?? null,
        deviceLabel: track.label,
        deviceCategory: classifyCameraDeviceLabel(track.label),
        width: settings.width ?? this.video.videoWidth,
        height: settings.height ?? this.video.videoHeight,
        frameRate: settings.frameRate ?? this.idealFrameRate,
      };
      this.currentSession = session;
      return session;
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      this.video.srcObject = null;
      if (error instanceof CameraControllerError) throw error;
      const cameraError = toCameraControllerError(error);
      if (cameraError.code !== 'unknown') throw cameraError;
      throw new CameraControllerError(
        'playback',
        '攝影機已連線但畫面無法播放；請點擊畫面後重試。',
        true,
        error,
      );
    }
  }

  selectDevice(deviceId: string): Promise<CameraSession> {
    return this.start(deviceId);
  }

  stop(): void {
    const stream = this.currentSession?.stream ?? this.video.srcObject;
    if (stream !== null && 'getTracks' in stream && typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) track.stop();
    }
    this.currentSession = null;
    this.video.pause();
    this.video.srcObject = null;
  }

  onDeviceChange(listener: () => void): () => void {
    const mediaDevices = this.requireMediaDevices();
    mediaDevices.addEventListener('devicechange', listener);
    return () => mediaDevices.removeEventListener('devicechange', listener);
  }

  private requireMediaDevices(): MediaDevices {
    if (this.mediaDevices === null || typeof this.mediaDevices.getUserMedia !== 'function') {
      throw new CameraControllerError(
        'unsupported',
        '目前瀏覽器或頁面來源不支援攝影機；請使用最新版 Chrome/Edge 並以 HTTPS 或 localhost 開啟。',
        false,
      );
    }
    return this.mediaDevices;
  }

  private waitForMetadata(): Promise<void> {
    if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA && this.video.videoWidth > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        cleanup();
        reject(
          new CameraControllerError(
            'not-readable',
            '等待攝影機畫面逾時；請拔插裝置後重試。',
            true,
          ),
        );
      }, this.metadataTimeoutMs);
      const onLoadedMetadata = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(
          new CameraControllerError('not-readable', '攝影機回報影像讀取錯誤。', true),
        );
      };
      const cleanup = (): void => {
        globalThis.clearTimeout(timeout);
        this.video.removeEventListener('loadedmetadata', onLoadedMetadata);
        this.video.removeEventListener('error', onError);
      };

      this.video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      this.video.addEventListener('error', onError, { once: true });
    });
  }
}
