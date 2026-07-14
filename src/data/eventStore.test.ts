import { describe, expect, it } from 'vitest';

import type { TournamentEvent } from '../types/game';
import { MemoryEventStore } from './eventStore';

describe('MemoryEventStore contract', () => {
  it('atomically snapshots, loads and clears a schema-v1 event', async () => {
    const store = new MemoryEventStore();
    const event = createEvent();

    await store.save(event);
    event.config.title = 'mutated after save';

    const firstLoad = await store.load();
    expect(firstLoad?.config.title).toBe('Test event');
    if (firstLoad !== null) {
      firstLoad.participants[0]!.displayName = 'mutated loaded copy';
    }
    expect((await store.load())?.participants[0]?.displayName).toBe('Player 1');

    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

function createEvent(): TournamentEvent {
  return {
    schemaVersion: 1,
    config: {
      id: 'event-1',
      title: 'Test event',
      difficulty: 'normal',
      qualifierHalfDurationMs: 25_000,
      finalHalfDurationMs: 30_000,
      intermissionMs: 8_000,
      practiceDurationMs: 8_000,
      scriptPoolVersion: 'v1',
      createdAt: 100,
      lockedAt: 100,
    },
    participants: [
      {
        id: 'p1',
        displayName: 'Player 1',
        activeHand: 'right',
        posture: 'standing',
        rankingEligible: true,
        createdAt: 100,
      },
    ],
    heats: [],
    consumedScriptIds: [],
    phase: 'setup',
    updatedAt: 100,
  };
}
