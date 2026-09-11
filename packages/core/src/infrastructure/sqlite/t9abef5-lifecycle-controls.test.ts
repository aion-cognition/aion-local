import { afterEach, beforeEach, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  recordEntityMergeProposal,
  reopenEntityMergeProposal,
  resolveEntityMergeProposal,
} from './entity-merge-proposals.js';
import {
  recordSupersessionProposal,
  reopenSupersessionProposal,
  resolveSupersessionProposal,
} from './supersession-proposals.js';
import {
  proposalHistoryToken,
  proposalStanding,
} from '../../introspection/application/orphan-census.js';

let store: SqliteStore;
const AT = '2026-05-01T00:00:00.000Z';
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});
afterEach(() => {
  store.close();
});

it('keeps a resolved replay stable and rolls back an uncommitted lifecycle', () => {
  const input = {
    oldId: 'node',
    newId: 'other',
    confidence: 1,
    episodeId: 'source',
    createdAt: AT,
  };
  const id = recordSupersessionProposal(store.db, input);
  expect(resolveSupersessionProposal(store.db, id, AT)).toBe(true);
  const standing = proposalStanding(store.db, 'node');
  expect(standing).toEqual({ rows: 1, revisions: 2, pending: 0 });
  const before = proposalHistoryToken(standing);
  expect(recordSupersessionProposal(store.db, input)).toBe(id);
  expect(resolveSupersessionProposal(store.db, id, AT)).toBe(false);
  expect(proposalHistoryToken(proposalStanding(store.db, 'node'))).toBe(before);
  expect(() =>
    store.db
      .transaction(() => {
        expect(reopenSupersessionProposal(store.db, id)).toBe(true);
        expect(resolveSupersessionProposal(store.db, id, AT)).toBe(true);
        throw new Error('abort before commit');
      })
      .immediate(),
  ).toThrow('abort before commit');
  expect(proposalHistoryToken(proposalStanding(store.db, 'node'))).toBe(before);
  expect(reopenSupersessionProposal(store.db, id)).toBe(true);
  expect(resolveSupersessionProposal(store.db, id, AT)).toBe(true);
  expect(proposalHistoryToken(proposalStanding(store.db, 'node'))).not.toBe(before);
});

it('counts a legacy zero-counter proposal lifecycle in both directions', () => {
  store.db
    .prepare(
      `INSERT INTO supersession_proposals
    (id,old_id,new_id,confidence,episode_id,created_at,resolved_at)
    VALUES ('legacy','node','other',1,'source',?,?)`,
    )
    .run(AT, AT);
  expect(proposalStanding(store.db, 'node')).toEqual({ rows: 1, revisions: 0, pending: 0 });
  expect(reopenSupersessionProposal(store.db, 'legacy')).toBe(true);
  expect(resolveSupersessionProposal(store.db, 'legacy', AT)).toBe(true);
  expect(proposalStanding(store.db, 'node')).toEqual({ rows: 1, revisions: 2, pending: 0 });
});

it('counts the merge-proposal lifecycle with the same-clock and duplicate guards', () => {
  const id = recordEntityMergeProposal(store.db, {
    subject: { id: 'node', name: 'First', type: 'person' },
    candidate: { id: 'other', name: 'Second', type: 'person' },
    similarity: 0.9,
    similaritySource: 'name_cosine',
    episodeId: 'source',
    createdAt: AT,
  });
  expect(resolveEntityMergeProposal(store.db, id, AT)).toBe(true);
  const before = proposalHistoryToken(proposalStanding(store.db, 'node'));
  expect(resolveEntityMergeProposal(store.db, id, AT)).toBe(false);
  expect(proposalHistoryToken(proposalStanding(store.db, 'node'))).toBe(before);
  expect(reopenEntityMergeProposal(store.db, id)).toBe(true);
  expect(reopenEntityMergeProposal(store.db, id)).toBe(false);
  expect(resolveEntityMergeProposal(store.db, id, AT)).toBe(true);
  expect(proposalHistoryToken(proposalStanding(store.db, 'node'))).not.toBe(before);
});
