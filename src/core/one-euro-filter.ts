import type { Point } from '../types/game';

export interface OneEuroFilterOptions {
  frequency?: number;
  minCutoff?: number;
  beta?: number;
  derivativeCutoff?: number;
}

const DEFAULT_FREQUENCY = 60;
const DEFAULT_MIN_CUTOFF = 1;
const DEFAULT_DERIVATIVE_CUTOFF = 1;

function smoothingFactor(elapsedSeconds: number, cutoff: number): number {
  const timeConstant = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + timeConstant / elapsedSeconds);
}

function lowPass(alpha: number, value: number, previous: number): number {
  return alpha * value + (1 - alpha) * previous;
}

/** Timestamp-aware scalar implementation of the One Euro Filter. */
export class OneEuroFilter {
  private readonly fallbackElapsedSeconds: number;
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly derivativeCutoff: number;
  private previousRaw: number | null = null;
  private previousFiltered: number | null = null;
  private previousDerivative = 0;
  private previousTimestampMs: number | null = null;

  constructor(options: OneEuroFilterOptions = {}) {
    const frequency = options.frequency ?? DEFAULT_FREQUENCY;
    this.minCutoff = options.minCutoff ?? DEFAULT_MIN_CUTOFF;
    this.beta = options.beta ?? 0;
    this.derivativeCutoff = options.derivativeCutoff ?? DEFAULT_DERIVATIVE_CUTOFF;

    if (!Number.isFinite(frequency) || frequency <= 0) {
      throw new RangeError('frequency must be positive');
    }
    if (!Number.isFinite(this.minCutoff) || this.minCutoff <= 0) {
      throw new RangeError('minCutoff must be positive');
    }
    if (!Number.isFinite(this.beta) || this.beta < 0) {
      throw new RangeError('beta must be non-negative');
    }
    if (!Number.isFinite(this.derivativeCutoff) || this.derivativeCutoff <= 0) {
      throw new RangeError('derivativeCutoff must be positive');
    }

    this.fallbackElapsedSeconds = 1 / frequency;
  }

  filter(value: number, timestampMs?: number): number {
    if (!Number.isFinite(value)) {
      throw new TypeError('value must be finite');
    }
    if (timestampMs !== undefined && !Number.isFinite(timestampMs)) {
      throw new TypeError('timestampMs must be finite');
    }

    if (this.previousRaw === null || this.previousFiltered === null) {
      this.previousRaw = value;
      this.previousFiltered = value;
      this.previousTimestampMs = timestampMs ?? null;
      return value;
    }

    if (
      timestampMs !== undefined &&
      this.previousTimestampMs !== null &&
      timestampMs <= this.previousTimestampMs
    ) {
      return this.previousFiltered;
    }

    const elapsedSeconds =
      timestampMs !== undefined && this.previousTimestampMs !== null
        ? (timestampMs - this.previousTimestampMs) / 1_000
        : this.fallbackElapsedSeconds;
    const derivative = (value - this.previousRaw) / elapsedSeconds;
    const derivativeAlpha = smoothingFactor(elapsedSeconds, this.derivativeCutoff);
    const filteredDerivative = lowPass(
      derivativeAlpha,
      derivative,
      this.previousDerivative,
    );
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const valueAlpha = smoothingFactor(elapsedSeconds, cutoff);
    const filtered = lowPass(valueAlpha, value, this.previousFiltered);

    this.previousRaw = value;
    this.previousFiltered = filtered;
    this.previousDerivative = filteredDerivative;
    if (timestampMs !== undefined) this.previousTimestampMs = timestampMs;
    return filtered;
  }

  reset(value?: number, timestampMs?: number): void {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new TypeError('value must be finite');
    }
    if (timestampMs !== undefined && !Number.isFinite(timestampMs)) {
      throw new TypeError('timestampMs must be finite');
    }

    this.previousRaw = value ?? null;
    this.previousFiltered = value ?? null;
    this.previousDerivative = 0;
    this.previousTimestampMs = value === undefined ? null : (timestampMs ?? null);
  }
}

export class OneEuroPointFilter {
  private readonly x: OneEuroFilter;
  private readonly y: OneEuroFilter;

  constructor(options: OneEuroFilterOptions = {}) {
    this.x = new OneEuroFilter(options);
    this.y = new OneEuroFilter(options);
  }

  filter(point: Point, timestampMs?: number): Point {
    return {
      x: this.x.filter(point.x, timestampMs),
      y: this.y.filter(point.y, timestampMs),
    };
  }

  reset(point?: Point, timestampMs?: number): void {
    this.x.reset(point?.x, timestampMs);
    this.y.reset(point?.y, timestampMs);
  }
}
