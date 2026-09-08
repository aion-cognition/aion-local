import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  publishedScopeToken,
  readScopeVersion,
  recordScopeMirror,
  rejectScopeAdvance,
  scopeSupportsVerifiedEmpty,
  scopeVersionToken,
  type ScopeKey,
} from './evidence-scope.js';

const SCOPE: ScopeKey = { endpointId: 'node-1', relationClass: 'sqlite:mention:in' };
const NOW = new Date('2026-09-08T02:00:00.000Z');
const LATER = new Date('2026-09-08T03:00:00.000Z');

describe('evidence scope versions', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-scope-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('has no token and supports no empty baseline until something writes the scope', () => {
    expect(publishedScopeToken(store.db, SCOPE)).toBeUndefined();
    expect(scopeSupportsVerifiedEmpty(store.db, SCOPE)).toBe(false);
  });

  it('invalidates a reader token when the first relation lands in an established empty scope', () => {
    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'baseline', updatedAt: NOW });
    acknowledgeScopeAdvance(store.db, {
      ...SCOPE,
      operationId: 'baseline',
      updatedAt: NOW,
      censusStatus: 'established',
    });

    const readerToken = publishedScopeToken(store.db, SCOPE);
    expect(readerToken).toBe(scopeVersionToken(SCOPE.endpointId, SCOPE.relationClass, 1));
    expect(scopeSupportsVerifiedEmpty(store.db, SCOPE)).toBe(true);

    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'first-relation', updatedAt: LATER });
    acknowledgeScopeAdvance(store.db, {
      ...SCOPE,
      operationId: 'first-relation',
      updatedAt: LATER,
    });

    expect(publishedScopeToken(store.db, SCOPE)).not.toBe(readerToken);
  });

  it('leaves the published token alone when a prepared advance is rejected', () => {
    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'baseline', updatedAt: NOW });
    acknowledgeScopeAdvance(store.db, { ...SCOPE, operationId: 'baseline', updatedAt: NOW });
    const before = publishedScopeToken(store.db, SCOPE);

    expect(prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-2', updatedAt: NOW })).toBe(
      2,
    );
    expect(publishedScopeToken(store.db, SCOPE)).toBe(before);

    expect(rejectScopeAdvance(store.db, { ...SCOPE, operationId: 'op-2', updatedAt: LATER })).toBe(
      true,
    );
    expect(publishedScopeToken(store.db, SCOPE)).toBe(before);

    // The rejected number is spent: the next attempt takes a fresh one.
    expect(prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-3', updatedAt: LATER })).toBe(
      3,
    );
    const acknowledged = acknowledgeScopeAdvance(store.db, {
      ...SCOPE,
      operationId: 'op-3',
      updatedAt: LATER,
    });
    expect(acknowledged).toBe(3);
    expect(publishedScopeToken(store.db, SCOPE)).toBe(
      scopeVersionToken(SCOPE.endpointId, SCOPE.relationClass, 3),
    );
  });

  it('changes the published token exactly once per acknowledgment', () => {
    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: NOW });
    expect(
      acknowledgeScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: NOW }),
    ).toBe(1);
    const after = publishedScopeToken(store.db, SCOPE);

    expect(
      acknowledgeScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: LATER }),
    ).toBeUndefined();
    expect(publishedScopeToken(store.db, SCOPE)).toBe(after);
  });

  it('refuses a second operation holding the pending slot and repeats one for its own', () => {
    expect(prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: NOW })).toBe(
      1,
    );
    expect(prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: NOW })).toBe(
      1,
    );

    expect(() =>
      prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-2', updatedAt: NOW }),
    ).toThrow(/already has a pending advance owned by op-1/);
  });

  it('ignores an acknowledgment from an operation that does not hold the pending slot', () => {
    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: NOW });

    expect(
      acknowledgeScopeAdvance(store.db, { ...SCOPE, operationId: 'stranger', updatedAt: NOW }),
    ).toBeUndefined();
    expect(readScopeVersion(store.db, SCOPE)).toMatchObject({
      publishedRevision: 0,
      pendingRevision: 1,
      pendingOperationId: 'op-1',
    });
  });

  it('keeps a census unbackfilled until a baseline operation establishes it', () => {
    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: NOW });
    acknowledgeScopeAdvance(store.db, {
      ...SCOPE,
      operationId: 'op-1',
      updatedAt: NOW,
      censusStatus: 'unbackfilled',
    });

    expect(scopeSupportsVerifiedEmpty(store.db, SCOPE)).toBe(false);

    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-2', updatedAt: LATER });
    acknowledgeScopeAdvance(store.db, { ...SCOPE, operationId: 'op-2', updatedAt: LATER });

    // An acknowledgment that says nothing about the census leaves it where it was.
    expect(readScopeVersion(store.db, SCOPE)?.censusStatus).toBe('unbackfilled');
  });

  it('refuses a half-written pending pair at the store', () => {
    prepareScopeAdvance(store.db, { ...SCOPE, operationId: 'op-1', updatedAt: NOW });

    expect(() =>
      store.db.prepare('UPDATE evidence_scope_versions SET pending_operation_id = NULL').run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('records a graph-owned counter as a mirror that can only prove staleness', () => {
    recordScopeMirror(store.db, {
      ...SCOPE,
      mirroredRevision: 4,
      operationId: 'op-1',
      mirroredAt: NOW,
    });
    recordScopeMirror(store.db, {
      ...SCOPE,
      mirroredRevision: 5,
      operationId: 'op-2',
      mirroredAt: LATER,
    });

    expect(
      store.db.prepare('SELECT mirrored_revision, operation_id FROM evidence_scope_mirrors').all(),
    ).toEqual([{ mirrored_revision: 5, operation_id: 'op-2' }]);
  });
});
