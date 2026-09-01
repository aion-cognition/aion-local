import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  entityMergeDecisionKey,
  findEntityMergeDecisionsForEntity,
  getEntityMergeDecision,
  getEntityMergeDecisionByKey,
  listEntityMergeDecisions,
  recordEntityMergeDecision,
  type EntityMergeDecisionInput,
} from './entity-merge-decisions.js';

describe('entity merge decision records', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-entity-merge-decisions-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function record(overrides: Partial<EntityMergeDecisionInput> = {}): string {
    return recordEntityMergeDecision(store.db, {
      canonicalId: 'entity-canonical',
      memberIds: ['entity-b', 'entity-a'],
      tier: 'tier0',
      reasons: ['the two names squash to one spelling'],
      signals: [
        {
          memberId: 'entity-a',
          sharedEpisodeCount: 3,
          sharedEpisodeJaccard: 0.5,
          neighborOverlapCount: 2,
          neighborOverlapJaccard: 0.25,
          temporalGapDays: 1.5,
          nameFormRelation: 'squash',
          canonicalMentionCount: 9,
          memberMentionCount: 2,
        },
      ],
      cascadeVersion: 'cascade-1',
      createdAt: '2026-09-01T09:00:00.000Z',
      ...overrides,
    });
  }

  it('reads back the record with member ids sorted whatever order the caller passed', () => {
    const id = record();

    expect(getEntityMergeDecision(store.db, id)).toEqual({
      id,
      canonicalId: 'entity-canonical',
      memberIds: ['entity-a', 'entity-b'],
      tier: 'tier0',
      reasons: ['the two names squash to one spelling'],
      signals: [
        {
          memberId: 'entity-a',
          sharedEpisodeCount: 3,
          sharedEpisodeJaccard: 0.5,
          neighborOverlapCount: 2,
          neighborOverlapJaccard: 0.25,
          temporalGapDays: 1.5,
          nameFormRelation: 'squash',
          canonicalMentionCount: 9,
          memberMentionCount: 2,
        },
      ],
      judge: null,
      cascadeVersion: 'cascade-1',
      idempotencyKey: entityMergeDecisionKey(
        'entity-canonical',
        ['entity-a', 'entity-b'],
        'cascade-1',
      ),
      createdAt: '2026-09-01T09:00:00.000Z',
    });
  });

  it('carries no confidence column, so nothing downstream can threshold on one', () => {
    const columns = (
      store.db.pragma('table_info(entity_merge_decisions)') as { name: string }[]
    ).map((column) => column.name);

    expect(columns).toEqual([
      'id',
      'canonical_id',
      'member_ids',
      'tier',
      'reasons',
      'signals',
      'judge_verdicts',
      'cascade_version',
      'idempotency_key',
      'created_at',
    ]);
  });

  it('keys idempotency on the canonical, the sorted members and the cascade version', () => {
    const key = entityMergeDecisionKey('c', ['b', 'a'], 'cascade-1');

    expect(entityMergeDecisionKey('c', ['a', 'b'], 'cascade-1')).toBe(key);
    expect(entityMergeDecisionKey('c', ['a', 'b'], 'cascade-2')).not.toBe(key);
    expect(entityMergeDecisionKey('c', ['a'], 'cascade-1')).not.toBe(key);
    expect(entityMergeDecisionKey('a', ['b', 'c'], 'cascade-1')).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refreshes the evidence on a replay of the same key rather than adding a second row', () => {
    const first = record();
    const second = record({
      memberIds: ['entity-a', 'entity-b'],
      reasons: ['the two names fold to one spelling'],
      createdAt: '2026-09-02T09:00:00.000Z',
    });

    expect(second).toBe(first);
    expect(listEntityMergeDecisions(store.db)).toHaveLength(1);
    const stored = getEntityMergeDecision(store.db, first);
    expect(stored?.reasons).toEqual(['the two names fold to one spelling']);
    // The first telling is when the merge happened; a replay restates the evidence, not the date.
    expect(stored?.createdAt).toBe('2026-09-01T09:00:00.000Z');
  });

  it('stores both judge passes for a judged tier and null for a deterministic one', () => {
    const deterministic = record();
    const judged = record({
      canonicalId: 'entity-other',
      memberIds: ['entity-c'],
      tier: 'tier3',
      reasons: ['both passes read the two as one referent'],
      judge: {
        detect: { same: true, rationale: 'the shared episodes name the same deployment' },
        review: { same: true, rationale: 'no reading makes these two different things' },
      },
    });

    expect(getEntityMergeDecision(store.db, deterministic)?.judge).toBeNull();
    expect(getEntityMergeDecision(store.db, judged)?.judge).toEqual({
      detect: { same: true, rationale: 'the shared episodes name the same deployment' },
      review: { same: true, rationale: 'no reading makes these two different things' },
    });
  });

  it('finds a decision from the canonical side and from an absorbed member alike', () => {
    const id = record();

    expect(
      findEntityMergeDecisionsForEntity(store.db, 'entity-canonical').map((row) => row.id),
    ).toEqual([id]);
    expect(findEntityMergeDecisionsForEntity(store.db, 'entity-b').map((row) => row.id)).toEqual([
      id,
    ]);
    expect(findEntityMergeDecisionsForEntity(store.db, 'entity-unrelated')).toEqual([]);
  });

  it('answers by idempotency key, which is what an unmerge holds before it holds a row id', () => {
    const id = record();
    const key = entityMergeDecisionKey('entity-canonical', ['entity-a', 'entity-b'], 'cascade-1');

    expect(getEntityMergeDecisionByKey(store.db, key)?.id).toBe(id);
    expect(getEntityMergeDecisionByKey(store.db, 'no-such-key')).toBeUndefined();
  });

  it('drops a duplicate member id before it keys or stores the group', () => {
    const id = record({ canonicalId: 'entity-dup', memberIds: ['entity-x', 'entity-x'] });

    expect(getEntityMergeDecision(store.db, id)?.memberIds).toEqual(['entity-x']);
    expect(getEntityMergeDecision(store.db, id)?.idempotencyKey).toBe(
      entityMergeDecisionKey('entity-dup', ['entity-x'], 'cascade-1'),
    );
  });
});
