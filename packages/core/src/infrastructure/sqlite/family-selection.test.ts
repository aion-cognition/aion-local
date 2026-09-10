import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  acknowledgeFamilySelection,
  readFamilySelection,
  type SessionNarrativeFamily,
} from './family-selection.js';
import { acknowledgePublicationIntent, preparePublicationIntent } from './publication-intents.js';

const EARLIER = new Date('2026-09-10T01:00:00.000Z');
const LATER = new Date('2026-09-10T02:00:00.000Z');

describe('acknowledged session representation', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore({ filePath: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  function prepare(operationId: string): void {
    preparePublicationIntent(store.db, {
      operationId,
      kind: 'family_cutover',
      payloadDigest: operationId,
      payloadJson: '{}',
      affectedScopesJson: '[]',
      expectedJson: '{}',
      preparedActionsJson: '[]',
      createdAt: EARLIER,
    });
  }

  function select(
    operationId: string,
    family: SessionNarrativeFamily,
    expectedVersion: number,
    at: Date,
  ): void {
    prepare(operationId);
    store.db
      .transaction(() => {
        acknowledgeFamilySelection(store.db, {
          sessionId: 'session',
          operationId,
          family,
          expectedVersion,
        });
        acknowledgePublicationIntent(store.db, {
          operationId,
          resultDigest: operationId,
          resultJson: '{}',
          observedAckAt: at,
        });
      })
      .immediate();
  }

  it('does not expose a preference until the operation that owns it is acknowledged', () => {
    expect(readFamilySelection(store.db, 'session')).toBeUndefined();
    prepare('initial');
    store.db
      .transaction(() => {
        acknowledgeFamilySelection(store.db, {
          sessionId: 'session',
          operationId: 'initial',
          family: 'legacy_session_overview',
          expectedVersion: 0,
        });
        expect(readFamilySelection(store.db, 'session')).toBeUndefined();
        acknowledgePublicationIntent(store.db, {
          operationId: 'initial',
          resultDigest: 'initial',
          resultJson: '{}',
          observedAckAt: EARLIER,
        });
      })
      .immediate();
    expect(readFamilySelection(store.db, 'session')).toMatchObject({
      family: 'legacy_session_overview',
      version: 1,
      knownFrom: EARLIER.toISOString(),
    });
  });

  it('selects by knowledge time while preserving the earlier preference', () => {
    select('legacy', 'legacy_session_overview', 0, EARLIER);
    select('cutover', 'chunk', 1, LATER);
    expect(
      readFamilySelection(store.db, 'session', new Date(EARLIER.getTime() - 1)),
    ).toBeUndefined();
    expect(readFamilySelection(store.db, 'session', new Date(LATER.getTime() - 1))?.family).toBe(
      'legacy_session_overview',
    );
    expect(readFamilySelection(store.db, 'session', LATER)?.family).toBe('chunk');
    expect(readFamilySelection(store.db, 'session')?.version).toBe(2);
  });

  it('uses sequence-backed version order when the acknowledgment clocks clamp equal', () => {
    select('legacy', 'legacy_session_overview', 0, LATER);
    select('cutover', 'chunk', 1, EARLIER);
    expect(readFamilySelection(store.db, 'session', LATER)).toMatchObject({
      family: 'chunk',
      version: 2,
      knownFrom: LATER.toISOString(),
    });
  });

  it('replays the same preference once and refuses a changed or stale request', () => {
    select('legacy', 'legacy_session_overview', 0, EARLIER);
    const append = () =>
      acknowledgeFamilySelection(store.db, {
        sessionId: 'session',
        operationId: 'legacy',
        family: 'legacy_session_overview' as const,
        expectedVersion: 0,
      });
    expect(append).toThrow('acknowledgment transaction');
    expect(store.db.transaction(append).immediate()).toBe(1);
    expect(() =>
      store.db
        .transaction(() =>
          acknowledgeFamilySelection(store.db, {
            sessionId: 'session',
            operationId: 'legacy',
            family: 'chunk',
            expectedVersion: 0,
          }),
        )
        .immediate(),
    ).toThrow('changed its recorded preference');
    expect(() =>
      store.db
        .transaction(() =>
          acknowledgeFamilySelection(store.db, {
            sessionId: 'session',
            operationId: 'stale',
            family: 'chunk',
            expectedVersion: 0,
          }),
        )
        .immediate(),
    ).toThrow('moved before acknowledgment');
    expect(store.db.prepare('SELECT count(*) AS n FROM family_selection_log').get()).toEqual({
      n: 1,
    });
  });

  it('rolls back the preference with the rest of a failed acknowledgment', () => {
    prepare('rolled-back');
    expect(() =>
      store.db
        .transaction(() => {
          acknowledgeFamilySelection(store.db, {
            sessionId: 'session',
            operationId: 'rolled-back',
            family: 'chunk',
            expectedVersion: 0,
          });
          throw new Error('interrupt acknowledgment');
        })
        .immediate(),
    ).toThrow('interrupt acknowledgment');
    expect(store.db.prepare('SELECT count(*) AS n FROM family_selection_log').get()).toEqual({
      n: 0,
    });
  });
});
