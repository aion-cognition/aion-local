import { afterEach, expect, it } from 'vitest';

import { resolvedView } from './resolved-view.js';
import {
  sourceStateDependency,
  verifyEvidenceRevision,
} from '../../evidence/application/dependencies.js';
import type { ItemMetadata } from '../../evidence/application/metadata.js';
import { idAddress, evidenceRequestKey } from '../../evidence/domain/address.js';
import { evidenceResult } from '../../evidence/domain/result.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { servedRecords } from '../domain/session-dedup.js';
import { item } from '../domain/test-support/pack.fixture.js';

let store: SqliteStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

it('limits a batch budget issue to its addressed memory while retaining the healthy holding', () => {
  const value: ItemMetadata = {
    provenance: { roots: ['source'], complete: true },
    owningSessions: ['session'],
    sources: ['source'],
    unknownAttribution: false,
    ownership: { sessions: ['session'], unknownAttribution: false, censusEstablished: true },
    narrativeBinding: { status: 'none' },
  };
  const results = new Map(
    ['a', 'b'].map((id) => [
      evidenceRequestKey(idAddress(id)),
      evidenceResult({ address: idAddress(id), residency: 'resident', issues: [], value }),
    ]),
  );
  const view = resolvedView({
    reading: {
      kind: 'resolved',
      results,
      issues: [
        { address: idAddress('a'), field: 'ownership', reason: 'budget_limit', required: false },
      ],
    },
    relatedClaims: new Map(),
    sessionId: 'session',
    attribute: true,
  });
  expect([...view.degraded]).toEqual(['a']);
  expect(
    servedRecords(
      new Set(['a', 'b']),
      new Map([
        ['a', item('a')],
        ['b', item('b')],
      ]),
      view,
    ).map((row) => row.itemId),
  ).toEqual(['b']);
});

it('requires revalidation of a persisted numeric source-state token after its contract widens', () => {
  store = new SqliteStore({ filePath: ':memory:' });
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { observations: ['a recorded fact'] },
    now: new Date('2026-09-08T00:00:00.000Z'),
  });
  const current = sourceStateDependency(store.db, 'source');
  expect(verifyEvidenceRevision(store.db, buildEvidenceRevision([current])).status).toBe('current');
  expect(
    verifyEvidenceRevision(store.db, buildEvidenceRevision([{ ...current, version: '0' }])).status,
  ).toBe('stale');
});
