import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  activateProcessingGeneration,
  advanceOperationalRevision,
  allocateProcessingGeneration,
  completeSourceWork,
  createSourceWork,
  listOutstandingWork,
  listStageWork,
  prepareInventorySkeleton,
  readActiveGeneration,
  readGeneration,
  stageWorkId,
} from './processing-generations.js';

const EARLY = new Date('2026-09-08T01:00:00.000Z');
const NOW = new Date('2026-09-08T02:00:00.000Z');
const LATER = new Date('2026-09-08T03:00:00.000Z');

describe('processing generations', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-generations-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function activeGeneration(sourceId = 'source-1'): number {
    const generation = allocateProcessingGeneration(store.db, {
      sourceId,
      policyRevision: 1,
      createdAt: EARLY,
    });
    activateProcessingGeneration(store.db, sourceId, generation);
    return generation;
  }

  it('allocates numbers that are never handed out twice', () => {
    expect(
      allocateProcessingGeneration(store.db, {
        sourceId: 'source-1',
        policyRevision: 1,
        createdAt: EARLY,
      }),
    ).toBe(1);
    expect(
      allocateProcessingGeneration(store.db, {
        sourceId: 'source-1',
        policyRevision: 1,
        createdAt: EARLY,
      }),
    ).toBe(2);
    // Another source numbers its own generations.
    expect(
      allocateProcessingGeneration(store.db, {
        sourceId: 'source-2',
        policyRevision: 1,
        createdAt: EARLY,
      }),
    ).toBe(1);
  });

  it('replaces the active generation in the same step that promotes its successor', () => {
    const first = activeGeneration();
    const second = allocateProcessingGeneration(store.db, {
      sourceId: 'source-1',
      policyRevision: 2,
      createdAt: NOW,
    });

    activateProcessingGeneration(store.db, 'source-1', second);

    expect(readGeneration(store.db, 'source-1', first)?.state).toBe('replaced');
    expect(readActiveGeneration(store.db, 'source-1')?.processingGeneration).toBe(second);
  });

  it('refuses to activate a generation that was already replaced', () => {
    const first = activeGeneration();
    const second = allocateProcessingGeneration(store.db, {
      sourceId: 'source-1',
      policyRevision: 2,
      createdAt: NOW,
    });
    activateProcessingGeneration(store.db, 'source-1', second);

    expect(() => {
      activateProcessingGeneration(store.db, 'source-1', first);
    }).toThrow(/cannot become active/);
    expect(readActiveGeneration(store.db, 'source-1')?.processingGeneration).toBe(second);
  });

  it('advances the counter only for the generation that is active', () => {
    const first = activeGeneration();

    expect(advanceOperationalRevision(store.db, 'source-1', first)).toBe(1);

    const second = allocateProcessingGeneration(store.db, {
      sourceId: 'source-1',
      policyRevision: 2,
      createdAt: NOW,
    });
    activateProcessingGeneration(store.db, 'source-1', second);

    expect(advanceOperationalRevision(store.db, 'source-1', first)).toBeUndefined();
    expect(readGeneration(store.db, 'source-1', first)?.operationalRevision).toBe(1);
    expect(readGeneration(store.db, 'source-1', second)?.operationalRevision).toBe(0);
  });

  it('creates a work row and moves the counter in one step', () => {
    const generation = activeGeneration();

    const advanced = createSourceWork(store.db, {
      workId: 'work-1',
      sourceId: 'source-1',
      processingGeneration: generation,
      kind: 'settlement',
      workKey: 'reference:2',
      dueAt: NOW,
    });

    expect(advanced).toBe(1);
    expect(readGeneration(store.db, 'source-1', generation)?.operationalRevision).toBe(1);
  });

  it('writes nothing when the generation the work belongs to has been replaced', () => {
    const first = activeGeneration();
    const second = allocateProcessingGeneration(store.db, {
      sourceId: 'source-1',
      policyRevision: 2,
      createdAt: NOW,
    });
    activateProcessingGeneration(store.db, 'source-1', second);

    const advanced = createSourceWork(store.db, {
      workId: 'work-1',
      sourceId: 'source-1',
      processingGeneration: first,
      kind: 'settlement',
      workKey: 'reference:2',
      dueAt: NOW,
    });

    expect(advanced).toBeUndefined();
    expect(store.db.prepare('SELECT count(*) AS n FROM source_work').get()).toEqual({ n: 0 });
  });

  it('leaves the counter where it was when the work row is refused', () => {
    const generation = activeGeneration();
    createSourceWork(store.db, {
      workId: 'work-1',
      sourceId: 'source-1',
      processingGeneration: generation,
      kind: 'settlement',
      workKey: 'reference:2',
      dueAt: NOW,
    });

    // The same obligation under a second work id: the unique key refuses it, and the counter
    // advance in the same transaction goes back with it.
    expect(() => {
      createSourceWork(store.db, {
        workId: 'work-2',
        sourceId: 'source-1',
        processingGeneration: generation,
        kind: 'settlement',
        workKey: 'reference:2',
        dueAt: NOW,
      });
    }).toThrow(/UNIQUE/);

    expect(readGeneration(store.db, 'source-1', generation)?.operationalRevision).toBe(1);
    expect(store.db.prepare('SELECT count(*) AS n FROM source_work').get()).toEqual({ n: 1 });
  });

  it('writes one stage row per required stage and repeats nothing on a second preparation', () => {
    const generation = activeGeneration();

    const first = prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: ['enrich', 'entities', 'narrative'],
      dueAt: NOW,
    });
    const second = prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: ['enrich', 'entities', 'narrative'],
      dueAt: NOW,
    });

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(listStageWork(store.db, 'source-1', generation).map((row) => row.stageName)).toEqual([
      'enrich',
      'entities',
      'narrative',
    ]);
    expect(stageWorkId('source-1', generation, 'enrich')).toBe('stage:source-1:1:enrich');
  });

  it('a stage added later is a new obligation and moves the counter again', () => {
    const generation = activeGeneration();
    prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: ['enrich'],
      dueAt: NOW,
    });

    const after = prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: ['enrich', 'entities'],
      dueAt: NOW,
    });

    expect(after).toBe(2);
  });

  it('completes a stage with its typed outcome and refuses one with no reason', () => {
    const generation = activeGeneration();
    prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: ['enrich'],
      dueAt: NOW,
    });
    const workId = stageWorkId('source-1', generation, 'enrich');

    expect(() =>
      completeSourceWork(store.db, workId, { outcome: 'complete', reason: '' }, LATER),
    ).toThrow(/empty reason/);

    const advanced = completeSourceWork(
      store.db,
      workId,
      { outcome: 'not_applicable', reason: 'the source carries no attachments' },
      LATER,
    );

    expect(advanced).toBe(2);
    expect(listStageWork(store.db, 'source-1', generation)).toEqual([
      {
        stageName: 'enrich',
        state: 'completed',
        outcome: {
          outcome: 'not_applicable',
          reason: 'the source carries no attachments',
        },
      },
    ]);
  });

  it('completing the same work twice moves the counter once', () => {
    const generation = activeGeneration();
    prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: ['enrich'],
      dueAt: NOW,
    });
    const workId = stageWorkId('source-1', generation, 'enrich');
    const outcome = { outcome: 'complete' as const, reason: 'enriched' };

    expect(completeSourceWork(store.db, workId, outcome, LATER)).toBe(2);
    expect(completeSourceWork(store.db, workId, outcome, LATER)).toBe(2);
  });

  it('lists outstanding work by its keyset and drops what has completed', () => {
    const generation = activeGeneration();
    prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: ['enrich', 'entities'],
      dueAt: NOW,
    });
    createSourceWork(store.db, {
      workId: 'work-later',
      sourceId: 'source-1',
      processingGeneration: generation,
      kind: 'settlement',
      workKey: 'reference:2',
      dueAt: LATER,
    });

    const due = listOutstandingWork(store.db, NOW, 10);
    expect(due.map((row) => row.workId)).toEqual([
      stageWorkId('source-1', generation, 'enrich'),
      stageWorkId('source-1', generation, 'entities'),
    ]);

    const firstPage = listOutstandingWork(store.db, LATER, 1);
    const secondPage = listOutstandingWork(store.db, LATER, 10, {
      dueAt: firstPage[0]?.dueAt ?? '',
      sourceId: firstPage[0]?.sourceId ?? '',
      workId: firstPage[0]?.workId ?? '',
    });
    expect([...firstPage, ...secondPage]).toHaveLength(3);

    completeSourceWork(
      store.db,
      stageWorkId('source-1', generation, 'enrich'),
      { outcome: 'complete', reason: 'enriched' },
      LATER,
    );
    expect(listOutstandingWork(store.db, LATER, 10)).toHaveLength(2);
  });

  it('seeks the outstanding index rather than reading the whole table', () => {
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT work_id FROM source_work
         WHERE state IN ('pending','retryable','transferred') AND due_at <= ?
         ORDER BY due_at, source_id, work_id`,
      )
      .all(NOW.toISOString()) as { detail: string }[];

    expect(plan.some((row) => row.detail.includes('source_work_outstanding_idx'))).toBe(true);
  });
});
