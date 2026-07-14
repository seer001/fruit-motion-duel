import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { TournamentEvent } from '../types/game';

export const EVENT_STORE_SCHEMA_VERSION = 1 as const;

const DEFAULT_DATABASE_NAME = 'body-fruit-duel';
const EVENT_OBJECT_STORE = 'events';
const ACTIVE_EVENT_KEY = 'active';

interface EventDatabaseSchema extends DBSchema {
  events: {
    key: typeof ACTIVE_EVENT_KEY;
    value: TournamentEvent;
  };
}

export interface EventStore {
  save(event: TournamentEvent): Promise<void>;
  load(): Promise<TournamentEvent | null>;
  clear(): Promise<void>;
}

export interface IndexedDbEventStoreOptions {
  databaseName?: string;
}

export class UnsupportedEventSchemaError extends Error {
  constructor(schemaVersion: unknown) {
    super(`Unsupported tournament event schema: ${String(schemaVersion)}`);
    this.name = 'UnsupportedEventSchemaError';
  }
}

/**
 * Stores the complete event as one IndexedDB record. A save is therefore an
 * atomic replacement: readers see either the previous snapshot or the new one.
 */
export class IndexedDbEventStore implements EventStore {
  readonly databaseName: string;

  private databasePromise: Promise<IDBPDatabase<EventDatabaseSchema>> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: IndexedDbEventStoreOptions = {}) {
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  }

  save(event: TournamentEvent): Promise<void> {
    assertSchemaV1(event);
    const snapshot = cloneEvent(event);

    return this.enqueueWrite(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(EVENT_OBJECT_STORE, 'readwrite');
      await transaction.store.put(snapshot, ACTIVE_EVENT_KEY);
      await transaction.done;
    });
  }

  async load(): Promise<TournamentEvent | null> {
    await this.pendingWrite;
    const database = await this.openDatabase();
    const event = await database.get(EVENT_OBJECT_STORE, ACTIVE_EVENT_KEY);

    if (event === undefined) {
      return null;
    }

    assertSchemaV1(event);
    return event;
  }

  clear(): Promise<void> {
    return this.enqueueWrite(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(EVENT_OBJECT_STORE, 'readwrite');
      await transaction.store.delete(ACTIVE_EVENT_KEY);
      await transaction.done;
    });
  }

  close(): void {
    if (this.databasePromise === null) {
      return;
    }

    void this.databasePromise.then((database) => database.close());
    this.databasePromise = null;
  }

  private openDatabase(): Promise<IDBPDatabase<EventDatabaseSchema>> {
    this.databasePromise ??= openDB<EventDatabaseSchema>(
      this.databaseName,
      EVENT_STORE_SCHEMA_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains(EVENT_OBJECT_STORE)) {
            database.createObjectStore(EVENT_OBJECT_STORE);
          }
        },
      },
    );

    return this.databasePromise;
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const nextWrite = this.pendingWrite.then(operation, operation);
    this.pendingWrite = nextWrite.catch(() => undefined);
    return nextWrite;
  }
}

/** A dependency-free test double that observes the same snapshot semantics. */
export class MemoryEventStore implements EventStore {
  private event: TournamentEvent | null;

  constructor(initialEvent: TournamentEvent | null = null) {
    if (initialEvent !== null) {
      assertSchemaV1(initialEvent);
    }
    this.event = initialEvent === null ? null : cloneEvent(initialEvent);
  }

  async save(event: TournamentEvent): Promise<void> {
    assertSchemaV1(event);
    this.event = cloneEvent(event);
  }

  async load(): Promise<TournamentEvent | null> {
    return this.event === null ? null : cloneEvent(this.event);
  }

  async clear(): Promise<void> {
    this.event = null;
  }
}

/** Acronym-preserving alias for callers that prefer the platform spelling. */
export { IndexedDbEventStore as IndexedDBEventStore };

export function createEventStore(
  options: IndexedDbEventStoreOptions = {},
): IndexedDbEventStore {
  return new IndexedDbEventStore(options);
}

function assertSchemaV1(event: TournamentEvent): void {
  if (event.schemaVersion !== EVENT_STORE_SCHEMA_VERSION) {
    const value = event as { schemaVersion?: unknown };
    throw new UnsupportedEventSchemaError(value.schemaVersion);
  }
}

function cloneEvent(event: TournamentEvent): TournamentEvent {
  return structuredClone(event);
}
