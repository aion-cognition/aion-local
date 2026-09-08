import { expect, it } from 'vitest';

import {
  buildEvidenceRevision,
  parseAffectedScopes,
  parsePublicationPreconditions,
} from './preconditions.js';
import { SqliteStore } from '../sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../sqlite/ops-ledger.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';

it('canonicalizes a dependency set without dropping its kind or accepting conflicting versions', () => {
  const first = { kind: 'source' as const, id: 'id', scope: 'source.content', version: 'v1' };
  const second = { kind: 'node' as const, id: 'id', scope: 'graph.node_state', version: 'v2' };
  const a = buildEvidenceRevision([first, second, first]);
  expect(a).toEqual(buildEvidenceRevision([second, first]));
  expect(a.dependencies).toHaveLength(2);
  expect(() => buildEvidenceRevision([first, { ...first, version: 'changed' }])).toThrow(
    'two observed versions',
  );
});

it('rejects a corrupt dependency digest and duplicate source fences', () => {
  const good = {
    coverageEpoch: 'epoch',
    evidence: buildEvidenceRevision([]),
    sources: [],
    heads: [],
  };
  expect(parsePublicationPreconditions(good)).toEqual(good);
  expect(() =>
    parsePublicationPreconditions({
      ...good,
      evidence: { ...good.evidence, digest: 'wrong' },
    }),
  ).toThrow('digest');
  const source = { sourceId: 'source', generation: '1', acceptedReferenceVersion: '0' };
  expect(() => parsePublicationPreconditions({ ...good, sources: [source, source] })).toThrow(
    'unique',
  );
});

it('preserves endpoint and kind when deduplicating affected scopes', () => {
  const a = { kind: 'relation_scope' as const, id: 'a', scope: 'sqlite:mention:out' };
  const b = { ...a, id: 'b' };
  expect(parseAffectedScopes([a, b, a])).toEqual([a, b]);
});

it('rolls back a promise-returning SQLite effect and restores the ordinary busy policy', async () => {
  const store = new SqliteStore({ filePath: ':memory:', busyTimeoutMs: 1250 });
  try {
    expect(() =>
      publicationWrite(store.db, () => {
        markLedgerApplied(store.db, 'must-roll-back', 1);
        return Promise.resolve();
      }),
    ).toThrow('async_sqlite_effect');
    expect(getLedgerEntry(store.db, 'must-roll-back')).toBeUndefined();
    expect(store.db.inTransaction).toBe(false);
    expect(store.db.pragma('busy_timeout', { simple: true })).toBe(1250);
    await Promise.resolve();
  } finally {
    store.close();
  }
});
