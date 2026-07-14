export type Difficulty = 'easy' | 'normal' | 'hard';
export type GameMode = 'solo-practice' | 'casual' | 'tournament';
export type DominantHand = 'left' | 'right';
export type PlayerPosture = 'standing' | 'seated';
export type Lane = 'left' | 'right';
export type CompetitionPhase = 'qualifier' | 'final' | 'tiebreak' | 'practice';
export type HeatStatus = 'queued' | 'calibrating' | 'playing' | 'review' | 'completed' | 'void';
export type HalfStatus = 'pending' | 'playing' | 'provisional' | 'confirmed' | 'void';

export interface Participant {
  id: string;
  displayName: string;
  activeHand: DominantHand;
  posture: PlayerPosture;
  rankingEligible: boolean;
  createdAt: number;
}

export interface ScoreBreakdown {
  score: number;
  fruitHits: number;
  fruitMisses: number;
  bombsHit: number;
  combo: number;
  maxCombo: number;
}

export interface HalfResult extends ScoreBreakdown {
  id: string;
  heatId: string;
  participantId: string;
  halfIndex: number;
  lane: Lane;
  scriptId: string;
  status: HalfStatus;
  durationMs: number;
  trackingPauses: number;
  technicalReason?: string;
  completedAt: number;
}

export interface Heat {
  id: string;
  phase: CompetitionPhase;
  participantIds: [string, string?];
  status: HeatStatus;
  currentHalf: number;
  halfDurationMs: number;
  scriptIds: string[];
  results: HalfResult[];
}

export interface EventConfig {
  id: string;
  title: string;
  difficulty: Difficulty;
  qualifierHalfDurationMs: number;
  finalHalfDurationMs: number;
  intermissionMs: number;
  practiceDurationMs: number;
  scriptPoolVersion: string;
  createdAt: number;
  lockedAt?: number;
}

export interface TournamentEvent {
  schemaVersion: 1;
  config: EventConfig;
  participants: Participant[];
  heats: Heat[];
  consumedScriptIds: string[];
  phase: 'setup' | 'qualifiers' | 'final' | 'completed';
  championId?: string;
  updatedAt: number;
}

export interface BalanceDefinition {
  difficulty: Difficulty;
  fruitsPer25Seconds: number;
  bombsPer25Seconds: number;
  maxConcurrent: number;
  radiusRatio: number;
  minFlightMs: number;
  maxFlightMs: number;
  minimumSliceSpeed: number;
}

export interface ScriptObject {
  id: string;
  kind: 'fruit' | 'bomb';
  spawnAtMs: number;
  x: number;
  apexY: number;
  radiusRatio: number;
  flightMs: number;
  fruitType?: 'apple' | 'orange' | 'watermelon' | 'kiwi' | 'dragonfruit';
}

export interface ScriptFingerprint {
  fruits: number;
  bombs: number;
  totalTravel: number;
  quadrantCounts: [number, number, number, number];
  peakConcurrent: number;
  minimumReactionMs: number;
}

export interface ScriptDefinition {
  id: string;
  version: string;
  difficulty: Difficulty;
  phase: Exclude<CompetitionPhase, 'practice'>;
  durationMs: number;
  seed: number;
  objects: ScriptObject[];
  fingerprint: ScriptFingerprint;
}

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
  presence: number;
}

export interface PoseObservation {
  temporaryId: string;
  score: number;
  landmarks: NormalizedLandmark[];
  torsoCenter: { x: number; y: number };
  /**
   * Multi-region pose quality produced from MediaPipe's head, shoulders,
   * elbows, wrists, direct hand anchors and hips. Optional keeps recorded/mock
   * frames compatible.
   */
  quality?: PoseQualitySummary;
}

export interface PoseQualitySummary {
  score: number;
  headConfidence: number;
  shoulderConfidence: number;
  elbowConfidence: number;
  wristConfidence: number;
  handConfidence: number;
  hipConfidence: number;
  landmarkCoverage: number;
  reliableLandmarkCount: number;
}

export interface TrackedPlayerPose {
  participantId: string;
  lane: Lane;
  confidence: number;
  activeWrist: { x: number; y: number } | null;
  otherWrist: { x: number; y: number } | null;
  observedAt: number;
  lostForMs: number;
}

export interface CalibrationProfile {
  participantId: string;
  lane: Lane;
  activeHand: DominantHand;
  shoulderCenter: { x: number; y: number };
  torsoCenter: { x: number; y: number };
  shoulderWidth: number;
  torsoLength: number;
  capturedAt: number;
  /** Optional upper-body anchors retained for richer tracking diagnostics. */
  headCenter?: { x: number; y: number };
  /**
   * Immutable pose-only identity anchor captured during calibration. This is
   * not face recognition: it stores head/shoulder geometry and the calibrated
   * head position so the tracker can reject unrelated people safely.
   */
  identityAnchor?: {
    version: 1;
    headCenter: { x: number; y: number };
    headOffsetInShoulders: { x: number; y: number };
    headSpanToShoulderRatio?: number;
    torsoToShoulderRatio: number;
    confidence: number;
    sampleCount: number;
  };
  hipCenter?: { x: number; y: number };
  hipWidth?: number;
  upperArmLength?: number;
  poseQuality?: number;
}

export interface InitializeVisionRequest {
  type: 'initialize';
  wasmRoot: string;
  /** Lite model used by the CPU fallback. */
  modelPath: string;
  /** Optional higher-accuracy model used only when the GPU backend succeeds. */
  gpuModelPath?: string;
  /** Two registered players plus one spectator candidate on the GPU. */
  maxPoses: 2 | 3;
  /** CPU startup is capped at two; healthy recognition rescue may configure three later. */
  cpuMaxPoses?: 2;
  /** Used after a GPU runtime timeout so recovery cannot retry the same backend. */
  forceBackend?: 'cpu';
}

export interface ConfigureVisionRequest {
  type: 'configure';
  maxPoses: 2 | 3;
}

export interface FrameRequest {
  type: 'frame';
  frameId: number;
  timestampMs: number;
  bitmap: ImageBitmap;
  /** Main-thread timestamps used only for pipeline diagnostics. */
  captureStartedAtMs?: number;
  capturedAtMs?: number;
}

export interface ResetVisionRequest {
  type: 'reset';
}

export type VisionWorkerInbound =
  | InitializeVisionRequest
  | ConfigureVisionRequest
  | FrameRequest
  | ResetVisionRequest;

export interface VisionReadyMessage {
  type: 'ready';
  backend?: 'gpu' | 'cpu';
  maxPoses?: 2 | 3;
  modelTier?: 'lite' | 'full';
}

export interface VisionConfiguredMessage {
  type: 'configured';
  maxPoses: 2 | 3;
}

export interface VisionPerformanceMetrics {
  /** Time spent turning the live video frame into the transferable bitmap. */
  captureMs: number;
  /** Input transfer plus any wait before synchronous MediaPipe inference starts. */
  workerQueueMs: number;
  /** Synchronous MediaPipe inference plus conversion of the retained landmarks. */
  inferenceMs: number;
  /** Worker-to-main structured-clone and message delivery time. */
  resultTransferMs: number;
  /** Submission-to-listener latency. This does not include camera exposure latency. */
  pipelineMs: number;
  inputWidth: number;
  inputHeight: number;
  backend: 'gpu' | 'cpu';
  /** Present in the current worker; optional for old persisted test fixtures. */
  maxPoses?: 2 | 3;
  modelTier?: 'lite' | 'full';
  adaptiveMode?:
    | 'gpu-quality'
    | 'gpu-recognition-rescue'
    | 'gpu-balanced'
    | 'gpu-emergency'
    | 'cpu-balanced'
    | 'cpu-recognition-rescue'
    | 'cpu-emergency';
  diagnosis?:
    | 'warming-up'
    | 'healthy'
    | 'performance-limited'
    | 'recognition-limited';
}

export interface PoseFrame {
  type: 'poses';
  frameId: number;
  timestampMs: number;
  inferenceMs: number;
  /** Pose arrays returned by MediaPipe before the worker's geometry conversion. */
  detectedPoseCount?: number;
  poses: PoseObservation[];
  /** Optional so persisted fixtures and older workers remain wire-compatible. */
  performance?: VisionPerformanceMetrics;
}

export interface VisionErrorMessage {
  type: 'error';
  message: string;
  recoverable: boolean;
  recoveryAction?: 'reinitialize-cpu';
}

export type VisionWorkerOutbound =
  | VisionReadyMessage
  | VisionConfiguredMessage
  | PoseFrame
  | VisionErrorMessage;

export interface Point {
  x: number;
  y: number;
}

export interface SliceTrail {
  participantId: string;
  lane: Lane;
  /** Camera trails identify the physical hand; omitted only for pointer demo input. */
  hand?: DominantHand;
  /**
   * Main-thread time when this inference result became available. Landmark
   * point timestamps remain camera capture times so sweep speed is calculated
   * from the real motion cadence instead of Worker latency.
   */
  receivedAtMs?: number;
  points: Array<Point & { timestampMs: number }>;
  confidence: number;
}

export interface GameRoundPlayer {
  participant: Participant;
  lane: Lane;
}

export interface GameRoundConfig {
  mode: GameMode;
  phase: CompetitionPhase;
  difficulty: Difficulty;
  durationMs: number;
  players: GameRoundPlayer[];
  script: ScriptDefinition;
  allowBothWrists: boolean;
}

export interface RoundFinishedPayload {
  scriptId: string;
  elapsedMs: number;
  scores: Record<string, ScoreBreakdown>;
}
