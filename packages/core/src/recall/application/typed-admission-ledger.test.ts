import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordTypedAdmissions } from './typed-admission-ledger.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import type { FusedItem } from '../domain/fusion.js';

const SESSION = 'session-1';
const NOW = new Date('2026-09-01T00:00:00.000Z');

const POLICY: AdmissionPolicy = {
  vectorFloor: 0.35,
  corroborationFloor: 0.33,
  bm25Mode: 'exact',
  typedAdmissionEnabled: true,
  typedAdmissionActivationFloor: 0.14,
};

/** An arrival admitted by the typed tier: one edge's contribution, and the node's whole score. */
function typedItem(): FusedItem {
  return {
    id: 'item-1',
    labels: ['Episode', 'Memory', 'AionNode'],
    content: 'the deploy was rolled back',
    rationale: { method: 'activation', score: 0.41, path: 'a -> b' },
    relevance: 0.34,
    measured: 0.34,
    score: 0.02,
    currency: 'current',
    activation: 0.62,
    typedEvidence: { edgeType: 'CONTRADICTS', contribution: 0.21 },
    evidence: [{ method: 'vector', relevance: 0.34 }],
    admittedBy: {
      rule: 'typed_admission',
      score: 0.34,
      qualifying: ['typed-edge: CONTRADICTS', 'vector 0.34'],
    },
  };
}

describe('the typed admission ledger row', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-typed-ledger-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the edge contribution the gate read and the floor it cleared', () => {
    recordTypedAdmissions(store.db, SESSION, NOW, withCurrency(), [typedItem()], POLICY);

    const entry = getLedgerEntry(
      store.db,
      `typed_admission:${SESSION}:${NOW.toISOString()}:item-1`,
    );
    expect(entry?.summary).toEqual({
      itemId: 'item-1',
      edgeType: 'CONTRADICTS',
      typedContribution: 0.21,
      activationFloor: 0.14,
      activationScore: 0.62,
      cosine: 0.34,
      clearedFloor: 0.33,
      failedFloor: 0.35,
    });
  });
});
