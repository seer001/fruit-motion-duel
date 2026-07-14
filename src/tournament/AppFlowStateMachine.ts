export type AppFlowState =
  | 'device'
  | 'roster'
  | 'calibration'
  | 'practice'
  | 'countdown'
  | 'half'
  | 'swap'
  | 'review'
  | 'leaderboard'
  | 'final'
  | 'champion';

export type HostAction =
  | 'approve-device'
  | 'lock-roster'
  | 'approve-calibration'
  | 'start-countdown'
  | 'start-half'
  | 'pause-half'
  | 'resume-half'
  | 'finish-half'
  | 'abort-half'
  | 'confirm-half'
  | 'void-half'
  | 'confirm-swap'
  | 'next-qualifier'
  | 'start-final'
  | 'prepare-final';

export interface AppFlowSnapshot {
  state: AppFlowState;
  competitionPhase: 'qualifier' | 'final';
  halfIndex: 0 | 1;
  paused: boolean;
  halfConfirmed: boolean;
  practiceRequired: boolean;
  qualifierHeatCount: number;
  completedQualifierHeats: number;
}

export class IllegalHostActionError extends Error {
  readonly action: HostAction;
  readonly flowState: AppFlowState;

  constructor(action: HostAction, flowState: AppFlowState) {
    super(`Host action "${action}" is not allowed while app flow is "${flowState}"`);
    this.name = 'IllegalHostActionError';
    this.action = action;
    this.flowState = flowState;
  }
}

/**
 * A deliberately small operational state machine. Domain mutations should be
 * completed first; only then should the matching host action advance this flow.
 */
export class AppFlowStateMachine {
  private flow: AppFlowSnapshot;

  constructor(qualifierHeatCount: number, snapshot?: AppFlowSnapshot) {
    if (!Number.isInteger(qualifierHeatCount) || qualifierHeatCount < 1) {
      throw new RangeError('Qualifier heat count must be a positive integer');
    }

    if (snapshot === undefined) {
      this.flow = {
        state: 'device',
        competitionPhase: 'qualifier',
        halfIndex: 0,
        paused: false,
        halfConfirmed: false,
        practiceRequired: true,
        qualifierHeatCount,
        completedQualifierHeats: 0,
      };
      return;
    }

    validateSnapshot(snapshot, qualifierHeatCount);
    this.flow = structuredClone(snapshot);
  }

  snapshot(): AppFlowSnapshot {
    return structuredClone(this.flow);
  }

  allowedActions(): HostAction[] {
    switch (this.flow.state) {
      case 'device':
        return ['approve-device'];
      case 'roster':
        return ['lock-roster'];
      case 'calibration':
        return ['approve-calibration'];
      case 'practice':
        return ['start-countdown'];
      case 'countdown':
        return ['start-half'];
      case 'half':
        return this.flow.paused
          ? ['resume-half', 'abort-half']
          : ['pause-half', 'finish-half', 'abort-half'];
      case 'swap':
        return this.flow.halfConfirmed
          ? ['confirm-swap']
          : ['confirm-half', 'void-half'];
      case 'review':
        return ['confirm-half', 'void-half'];
      case 'leaderboard':
        return this.flow.completedQualifierHeats < this.flow.qualifierHeatCount
          ? ['next-qualifier']
          : ['start-final'];
      case 'final':
        return ['prepare-final'];
      case 'champion':
        return [];
      default:
        return assertNever(this.flow.state);
    }
  }

  can(action: HostAction): boolean {
    return this.allowedActions().includes(action);
  }

  send(action: HostAction): AppFlowSnapshot {
    if (!this.can(action)) {
      throw new IllegalHostActionError(action, this.flow.state);
    }

    switch (action) {
      case 'approve-device':
        this.flow.state = 'roster';
        break;
      case 'lock-roster':
        this.flow.state = 'calibration';
        break;
      case 'approve-calibration':
        this.flow.state = this.flow.practiceRequired ? 'practice' : 'countdown';
        break;
      case 'start-countdown':
        this.flow.practiceRequired = false;
        this.flow.state = 'countdown';
        break;
      case 'start-half':
        this.flow.state = 'half';
        this.flow.paused = false;
        break;
      case 'pause-half':
        this.flow.paused = true;
        break;
      case 'resume-half':
        this.flow.paused = false;
        break;
      case 'finish-half':
        this.flow.paused = false;
        this.flow.halfConfirmed = false;
        this.flow.state = this.flow.halfIndex === 0 ? 'swap' : 'review';
        break;
      case 'abort-half':
      case 'void-half':
        this.flow.paused = false;
        this.flow.halfConfirmed = false;
        this.flow.practiceRequired = false;
        this.flow.state = 'calibration';
        break;
      case 'confirm-half':
        if (this.flow.state === 'swap') {
          this.flow.halfConfirmed = true;
          break;
        }
        if (this.flow.competitionPhase === 'qualifier') {
          this.flow.completedQualifierHeats += 1;
          this.flow.state = 'leaderboard';
        } else {
          this.flow.state = 'champion';
        }
        break;
      case 'confirm-swap':
        this.flow.halfIndex = 1;
        this.flow.halfConfirmed = false;
        this.flow.practiceRequired = false;
        this.flow.state = 'calibration';
        break;
      case 'next-qualifier':
        this.prepareHeat('qualifier');
        break;
      case 'start-final':
        this.flow.competitionPhase = 'final';
        this.flow.halfIndex = 0;
        this.flow.halfConfirmed = false;
        this.flow.practiceRequired = true;
        this.flow.state = 'final';
        break;
      case 'prepare-final':
        this.prepareHeat('final');
        break;
      default:
        assertNever(action);
    }

    return this.snapshot();
  }

  private prepareHeat(phase: 'qualifier' | 'final'): void {
    this.flow.competitionPhase = phase;
    this.flow.halfIndex = 0;
    this.flow.paused = false;
    this.flow.halfConfirmed = false;
    this.flow.practiceRequired = true;
    this.flow.state = 'calibration';
  }
}

function validateSnapshot(snapshot: AppFlowSnapshot, qualifierHeatCount: number): void {
  if (snapshot.qualifierHeatCount !== qualifierHeatCount) {
    throw new RangeError('Snapshot qualifier heat count does not match this event');
  }
  if (
    !Number.isInteger(snapshot.completedQualifierHeats) ||
    snapshot.completedQualifierHeats < 0 ||
    snapshot.completedQualifierHeats > qualifierHeatCount
  ) {
    throw new RangeError('Snapshot contains an invalid completed heat count');
  }
  if (snapshot.halfIndex !== 0 && snapshot.halfIndex !== 1) {
    throw new RangeError('Snapshot contains an invalid half index');
  }
  if (snapshot.paused && snapshot.state !== 'half') {
    throw new RangeError('Only a running half can be paused');
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled state machine value: ${String(value)}`);
}
