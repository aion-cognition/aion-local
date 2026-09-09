import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PublicationInvariantError } from './errors.js';
import { PublicationOperation } from './operation.js';
import { buildEvidenceRevision } from './preconditions.js';
import { verifyPublicationState } from './protocol.js';
import { PUBLICATION_PROTOCOL_VERSION, type PublicationPlan } from './types.js';
import type { GuardReceipt } from '../graph/publication-receipt.js';
import { SqliteStore } from '../sqlite/database.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';
import { beginSubstratePairing, completeSubstratePairing } from '../sqlite/publication-control.js';
import * as records from '../sqlite/publication-coordinator-store.js';
import { preparePublicationIntent } from '../sqlite/publication-intents.js';

it('does not report corruption when another connection acknowledges between protocol subreads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-protocol-snapshot-'));
  const path = join(dir, 'store.sqlite');
  const store = new SqliteStore({ filePath: path });
  const other = new Database(path, { fileMustExist: true });
  const now = new Date('2026-09-01T00:00:00.000Z');
  const plan: PublicationPlan = {
    data: {},
    effects: [],
    scopes: [],
    expected: {
      coverageEpoch: 'fixture',
      evidence: buildEvidenceRevision([]),
      sources: [],
      heads: [],
    },
  };
  const handler = new PublicationOperation({
    kind: 'semantic_write',
    effectKinds: [],
    payload: z.object({}),
    data: z.object({}),
    result: z.object({}),
    prepare: async () => plan,
    check: async () => ({ status: 'valid' }),
    applyGraph: async () => ({}),
    prepareSqlite: () => undefined,
    acknowledgeSqlite: () => undefined,
    discardSqlite: () => undefined,
  });
  try {
    const pairing = beginSubstratePairing(store.db, PUBLICATION_PROTOCOL_VERSION);
    completeSubstratePairing(store.db, pairing.substrateId);
    const input = {
      operationId: 'completed-graph-awaiting-ack',
      kind: 'semantic_write' as const,
      payloadJson: '{}',
      digest: records.publicationBindingDigest('semantic_write', '{}', plan),
      plan,
      now,
    };
    const prepared = publicationWrite(store.db, () =>
      records.prepareCoordinatorRecord(store.db, input, true),
    );
    publicationWrite(store.db, () => {
      records.savePublicationResult(store.db, prepared, {});
    });
    const saved = records.publicationRecord(store.db, input.operationId)!;
    const guard: GuardReceipt = {
      substrateId: pairing.substrateId,
      protocolVersion: PUBLICATION_PROTOCOL_VERSION,
      sequence: saved.sequence,
      operationId: saved.operationId,
      intentDigest: saved.payloadDigest,
      resultDigest: saved.resultDigest,
    };
    // The graph receipt is held constant. Both complete SQLite states are legal for it.
    expect(verifyPublicationState(store.db, guard).committed).toBe(true);
    const original = records.assertPendingSlot;
    let injected = false;
    const spy = vi.spyOn(records, 'assertPendingSlot').mockImplementation((db, control) => {
      if (!injected) {
        injected = true;
        publicationWrite(other, () =>
          records.acknowledgeCoordinatorRecord(other, saved, plan, handler, now),
        );
      }
      original(db, control);
    });
    let caught: unknown;
    try {
      verifyPublicationState(store.db, guard);
    } catch (error) {
      caught = error;
    }
    spy.mockRestore();
    expect(injected).toBe(true);
    expect(verifyPublicationState(store.db, guard).pending).toBeUndefined();
    expect(caught).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    other.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps a consistently invalid pending slot an invariant and releases its read snapshot', () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    const pairing = beginSubstratePairing(store.db, PUBLICATION_PROTOCOL_VERSION);
    completeSubstratePairing(store.db, pairing.substrateId);
    const guard: GuardReceipt = {
      substrateId: pairing.substrateId,
      protocolVersion: PUBLICATION_PROTOCOL_VERSION,
      sequence: '0',
      operationId: null,
      intentDigest: null,
      resultDigest: null,
    };
    const before = store.db.prepare('SELECT total_changes() AS n').get();
    expect(verifyPublicationState(store.db, guard).pending).toBeUndefined();
    expect(store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(store.db.inTransaction).toBe(false);
    // An intent without its matching pending slot is genuinely inconsistent, unlike an ACK.
    preparePublicationIntent(store.db, {
      operationId: 'unmatched',
      kind: 'semantic_write',
      payloadDigest: 'fixture',
      payloadJson: '{}',
      affectedScopesJson: '[]',
      expectedJson: '{}',
      preparedActionsJson: '{}',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    let caught: unknown;
    try {
      verifyPublicationState(store.db, guard);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PublicationInvariantError);
    expect(caught).toMatchObject({ reason: 'publication_pending_slot_mismatch', retryable: false });
    expect(store.db.inTransaction).toBe(false);
  } finally {
    store.close();
  }
});
