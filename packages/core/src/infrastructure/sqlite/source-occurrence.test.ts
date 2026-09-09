import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { acknowledgePublicationIntent, preparePublicationIntent } from './publication-intents.js';
import { recordSourceRecord } from './source-identity.js';
import {
  acknowledgeSourceStateVersions,
  hasPendingSourceState,
  isSourceForgotten,
  listSourceStateVersions,
  readSourceResidency,
  recordSourceStateVersion,
  sourceResidencyState,
  transitionSourceResidency,
} from './source-lifecycle.js';
import { occurrenceCandidates, resolveSourceOccurrence } from './source-occurrence.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const KEY = { identityHash: 'identity-hash-1', sessionId: 'session-a' };

let dir: string;
let store: SqliteStore;

/** The publication a statement about a source travels in, acknowledged. */
function acknowledgeOperation(operationId: string): void {
  preparePublicationIntent(store.db, {
    operationId,
    kind: 'source_suppression',
    payloadDigest: `digest:${operationId}`,
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  acknowledgePublicationIntent(store.db, {
    operationId,
    resultDigest: `result:${operationId}`,
    resultJson: '{}',
    observedAckAt: NOW,
  });
}

function seedOccurrence(sourceId: string, identityHash = KEY.identityHash): void {
  recordSourceRecord(store.db, {
    sourceId,
    sessionId: KEY.sessionId,
    verificationStatus: 'verified',
    occurredAt: NOW.toISOString(),
    createdAt: new Date(NOW.getTime() + sourceId.length),
    archive: {
      canonicalArchiveId: `archive-${sourceId}`,
      archiveSchemaVersion: 1,
      identityHash,
      verifiedContentDigest: 'digest',
      verificationPolicyVersion: 1,
      archivedAt: NOW.toISOString(),
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-occurrence-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('occurrence resolution', () => {
  it('reports an absent key rather than inventing a candidate', () => {
    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({ kind: 'absent' });
    expect(occurrenceCandidates(store.db, KEY)).toEqual([]);
  });

  it('answers with the original source while it is held', () => {
    seedOccurrence('source-1');

    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({
      kind: 'held',
      sourceId: 'source-1',
      residency: 'resident',
    });
  });

  it('answers with the original source after eviction, so nothing is rebuilt to decide identity', () => {
    seedOccurrence('source-1');
    transitionSourceResidency(store.db, {
      sourceId: 'source-1',
      state: 'evicted',
      operationId: 'operation-1',
      transitionedAt: NOW,
    });

    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({
      kind: 'held',
      sourceId: 'source-1',
      residency: 'evicted',
    });
  });

  it('calls a forgotten occurrence a new one and leaves its forget stamp alone', () => {
    seedOccurrence('source-1');
    recordSourceStateVersion(store.db, {
      sourceId: 'source-1',
      stateKind: 'forgotten',
      operationId: 'operation-forget',
      observedAt: NOW,
      knownFrom: NOW,
    });
    acknowledgeOperation('operation-forget');

    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({
      kind: 'forgotten',
      priorSourceIds: ['source-1'],
    });
    expect(isSourceForgotten(store.db, 'source-1')).toBe(true);
  });

  it('reads an unforget as the newest statement in the same chain', () => {
    seedOccurrence('source-1');
    recordSourceStateVersion(store.db, {
      sourceId: 'source-1',
      stateKind: 'forgotten',
      operationId: 'operation-forget',
      observedAt: NOW,
      knownFrom: NOW,
    });
    recordSourceStateVersion(store.db, {
      sourceId: 'source-1',
      stateKind: 'unforgotten',
      operationId: 'operation-unforget',
      observedAt: NOW,
      knownFrom: NOW,
    });
    acknowledgeOperation('operation-forget');
    acknowledgeOperation('operation-unforget');

    expect(isSourceForgotten(store.db, 'source-1')).toBe(false);
    expect(resolveSourceOccurrence(store.db, KEY)).toMatchObject({ kind: 'held' });
  });

  it('pins when two live occurrences claim one key instead of picking one', () => {
    seedOccurrence('source-1');
    seedOccurrence('source-2');

    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({
      kind: 'ambiguous',
      sourceIds: ['source-1', 'source-2'],
    });
  });

  it('selects the surviving occurrence when its predecessor was forgotten', () => {
    seedOccurrence('source-1');
    seedOccurrence('source-2');
    recordSourceStateVersion(store.db, {
      sourceId: 'source-1',
      stateKind: 'forgotten',
      operationId: 'operation-forget',
      observedAt: NOW,
      knownFrom: NOW,
    });
    acknowledgeOperation('operation-forget');

    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({
      kind: 'held',
      sourceId: 'source-2',
      residency: 'resident',
    });
  });

  it('leaves an unacknowledged forget outside the committed answer', () => {
    seedOccurrence('source-1');
    recordSourceStateVersion(store.db, {
      sourceId: 'source-1',
      stateKind: 'forgotten',
      operationId: 'operation-in-flight',
      observedAt: NOW,
    });

    expect(isSourceForgotten(store.db, 'source-1')).toBe(false);
    expect(hasPendingSourceState(store.db, 'source-1')).toBe(true);
    expect(listSourceStateVersions(store.db, 'source-1')).toHaveLength(1);
  });

  it('discloses the uncertainty rather than minting against a statement in flight', () => {
    seedOccurrence('source-1');
    recordSourceStateVersion(store.db, {
      sourceId: 'source-1',
      stateKind: 'forgotten',
      operationId: 'operation-in-flight',
      observedAt: NOW,
    });

    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({
      kind: 'uncertain',
      sourceIds: ['source-1'],
    });
  });

  it('takes the forget once its publication acknowledges it', () => {
    seedOccurrence('source-1');
    recordSourceStateVersion(store.db, {
      sourceId: 'source-1',
      stateKind: 'forgotten',
      operationId: 'operation-forget',
      observedAt: NOW,
    });
    acknowledgeSourceStateVersions(store.db, 'operation-forget', NOW.toISOString());
    acknowledgeOperation('operation-forget');

    expect(hasPendingSourceState(store.db, 'source-1')).toBe(false);
    expect(resolveSourceOccurrence(store.db, KEY)).toEqual({
      kind: 'forgotten',
      priorSourceIds: ['source-1'],
    });
  });

  it('keeps a different session out of the key', () => {
    seedOccurrence('source-1');

    expect(resolveSourceOccurrence(store.db, { ...KEY, sessionId: 'session-b' })).toEqual({
      kind: 'absent',
    });
  });
});

describe('residency transitions', () => {
  it('reads a source with no row as resident', () => {
    expect(sourceResidencyState(store.db, 'source-1')).toBe('resident');
    expect(readSourceResidency(store.db, 'source-1')).toBeUndefined();
  });

  it('spends a projection generation on every attempt, including a repeat of one that failed', () => {
    const first = transitionSourceResidency(store.db, {
      sourceId: 'source-1',
      state: 'retiring',
      operationId: 'operation-1',
      transitionedAt: NOW,
    });
    const second = transitionSourceResidency(store.db, {
      sourceId: 'source-1',
      state: 'retiring',
      operationId: 'operation-2',
      transitionedAt: NOW,
    });

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(readSourceResidency(store.db, 'source-1')).toMatchObject({
      state: 'retiring',
      projectionGeneration: 2,
      activeOperationId: 'operation-2',
    });
  });
});
