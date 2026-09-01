import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  findEntityMergeProposalsForNode,
  getEntityMergeProposal,
  listEntityMergeProposals,
  recordEntityMergeProposal,
  reopenEntityMergeProposal,
  resolveEntityMergeProposal,
} from './entity-merge-proposals.js';

describe('entity merge proposal accessors', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-entity-merge-proposals-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function record(
    overrides: Partial<Parameters<typeof recordEntityMergeProposal>[1]> = {},
  ): string {
    return recordEntityMergeProposal(store.db, {
      subject: { id: 'entity-b', name: 'Postgres', type: 'concept' },
      candidate: { id: 'entity-a', name: 'Postgres', type: 'tool' },
      similarity: 0.97,
      similaritySource: 'name_cosine',
      episodeId: 'episode-2',
      createdAt: '2026-08-28T09:00:00.000Z',
      ...overrides,
    });
  }

  it('records the pair open, id-sorted, with both names and types', () => {
    const id = record();

    expect(getEntityMergeProposal(store.db, id)).toEqual({
      id,
      leftId: 'entity-a',
      leftName: 'Postgres',
      leftType: 'tool',
      rightId: 'entity-b',
      rightName: 'Postgres',
      rightType: 'concept',
      similarity: 0.97,
      similaritySource: 'name_cosine',
      episodeId: 'episode-2',
      createdAt: '2026-08-28T09:00:00.000Z',
      resolvedAt: null,
    });
  });

  it('refreshes one row when the same pair is detected from the other side', () => {
    const first = record();
    const second = record({
      subject: { id: 'entity-a', name: 'Postgres', type: 'tool' },
      candidate: { id: 'entity-b', name: 'PostgreSQL', type: 'concept' },
      similarity: 0.99,
      similaritySource: 'name_cosine',
      episodeId: 'episode-7',
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    expect(second).toBe(first);
    expect(listEntityMergeProposals(store.db)).toHaveLength(1);
    expect(getEntityMergeProposal(store.db, first)).toMatchObject({
      rightName: 'PostgreSQL',
      similarity: 0.99,
      similaritySource: 'name_cosine',
      episodeId: 'episode-7',
      // The refresh reports what is newly known, not a new discovery date.
      createdAt: '2026-08-28T09:00:00.000Z',
    });
  });

  it('finds a proposal from either endpoint', () => {
    const id = record();

    expect(findEntityMergeProposalsForNode(store.db, 'entity-a').map((row) => row.id)).toEqual([
      id,
    ]);
    expect(findEntityMergeProposalsForNode(store.db, 'entity-b').map((row) => row.id)).toEqual([
      id,
    ]);
    expect(findEntityMergeProposalsForNode(store.db, 'entity-z')).toEqual([]);
  });

  it('resolves once and keeps the resolution through a later refresh', () => {
    const id = record();

    expect(resolveEntityMergeProposal(store.db, id, '2026-08-29T00:00:00.000Z')).toBe(true);
    expect(resolveEntityMergeProposal(store.db, id)).toBe(false);

    record({ similarity: 0.5 });
    expect(getEntityMergeProposal(store.db, id)).toMatchObject({
      similarity: 0.5,
      similaritySource: 'name_cosine',
      resolvedAt: '2026-08-29T00:00:00.000Z',
    });
  });

  it('reopens a resolved row and refuses an already-open one', () => {
    const id = record();

    expect(reopenEntityMergeProposal(store.db, id)).toBe(false);

    resolveEntityMergeProposal(store.db, id, '2026-08-29T00:00:00.000Z');
    expect(reopenEntityMergeProposal(store.db, id)).toBe(true);
    expect(getEntityMergeProposal(store.db, id)?.resolvedAt).toBeNull();

    expect(reopenEntityMergeProposal(store.db, id)).toBe(false);
  });

  it('returns nothing for an id it never issued', () => {
    expect(getEntityMergeProposal(store.db, 'not-an-id')).toBeUndefined();
    expect(resolveEntityMergeProposal(store.db, 'not-an-id')).toBe(false);
  });
});
