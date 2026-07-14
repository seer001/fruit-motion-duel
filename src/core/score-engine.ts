import type { ScoreBreakdown } from '../types/game';

export const FRUIT_BASE_SCORE = 100;
export const BOMB_PENALTY = 200;

export type ScoreEventType = 'fruit-hit' | 'fruit-miss' | 'bomb-hit';

export interface ScoreEvent {
  id: string;
  type: ScoreEventType;
}

export interface ScoreEventResult {
  applied: boolean;
  delta: number;
  breakdown: ScoreBreakdown;
}

export function comboBonus(combo: number): number {
  if (!Number.isInteger(combo) || combo < 0) {
    throw new RangeError('combo must be a non-negative integer');
  }
  if (combo >= 20) return 60;
  if (combo >= 10) return 40;
  if (combo >= 5) return 20;
  return 0;
}

export class ScoreEngine {
  private readonly processedEventIds = new Set<string>();
  private state: ScoreBreakdown;

  constructor(initial?: Partial<ScoreBreakdown>) {
    this.state = {
      score: initial?.score ?? 0,
      fruitHits: initial?.fruitHits ?? 0,
      fruitMisses: initial?.fruitMisses ?? 0,
      bombsHit: initial?.bombsHit ?? 0,
      combo: initial?.combo ?? 0,
      maxCombo: initial?.maxCombo ?? initial?.combo ?? 0,
    };
    this.assertValidState();
  }

  apply(event: ScoreEvent): ScoreEventResult {
    if (event.id.length === 0) {
      throw new Error('score event id must not be empty');
    }
    if (this.processedEventIds.has(event.id)) {
      return { applied: false, delta: 0, breakdown: this.snapshot() };
    }

    this.processedEventIds.add(event.id);
    const previousScore = this.state.score;

    switch (event.type) {
      case 'fruit-hit': {
        this.state.fruitHits += 1;
        this.state.combo += 1;
        this.state.maxCombo = Math.max(this.state.maxCombo, this.state.combo);
        this.state.score += FRUIT_BASE_SCORE + comboBonus(this.state.combo);
        break;
      }
      case 'fruit-miss': {
        this.state.fruitMisses += 1;
        this.state.combo = 0;
        break;
      }
      case 'bomb-hit': {
        this.state.bombsHit += 1;
        this.state.combo = 0;
        this.state.score = Math.max(0, this.state.score - BOMB_PENALTY);
        break;
      }
    }

    return {
      applied: true,
      delta: this.state.score - previousScore,
      breakdown: this.snapshot(),
    };
  }

  applyEvent(event: ScoreEvent): ScoreEventResult {
    return this.apply(event);
  }

  hasProcessed(eventId: string): boolean {
    return this.processedEventIds.has(eventId);
  }

  snapshot(): ScoreBreakdown {
    return { ...this.state };
  }

  reset(): void {
    this.processedEventIds.clear();
    this.state = {
      score: 0,
      fruitHits: 0,
      fruitMisses: 0,
      bombsHit: 0,
      combo: 0,
      maxCombo: 0,
    };
  }

  private assertValidState(): void {
    for (const [key, value] of Object.entries(this.state)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${key} must be a non-negative integer`);
      }
    }
    if (this.state.maxCombo < this.state.combo) {
      throw new RangeError('maxCombo cannot be lower than combo');
    }
  }
}
