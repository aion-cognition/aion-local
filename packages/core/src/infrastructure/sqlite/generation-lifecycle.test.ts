import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  CONFLICTING_PROGRESS_ON_REPLACEMENT,
  DUPLICATE_ON_REPLACEMENT,
  markInventoryComplete,
  replaceProcessingGeneration,
  SUPERSEDED_GENERATION,
} from './generation-lifecycle.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  completeSourceWork,
  prepareGenerationWork,
  prepareInventorySkeleton,
  readGeneration,
  stageWorkId,
} from './processing-generations.js';
import { readGenerationWork } from './source-readiness.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const SOURCE = 'source-1';
const STAGES = ['entities', 'cognitive'];

describe('generation replacement', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-generation-lifecycle-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function prepared(stageNames: readonly string[] = STAGES): number {
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: SOURCE,
      policyRevision: 1,
      createdAt: NOW,
    });
    prepareInventorySkeleton(store.db, {
      sourceId: SOURCE,
      processingGeneration: generation,
      stageNames,
      dueAt: NOW,
    });
    return generation;
  }

  function settlement(generation: number, workKey: string, workId: string): void {
    prepareGenerationWork(store.db, {
      workId,
      sourceId: SOURCE,
      processingGeneration: generation,
      kind: 'settlement',
      workKey,
      dueAt: NOW,
    });
  }

  it('supersedes the displaced generation execution and says why', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    const second = prepared();

    const outcome = replaceProcessingGeneration(store.db, {
      sourceId: SOURCE,
      replacementGeneration: second,
    });

    expect(outcome.replacedGeneration).toBe(first);
    expect(outcome.obsoleted).toBe(2);
    expect(readGenerationWork(store.db, SOURCE, first).map((row) => row.state)).toEqual([
      'obsolete',
      'obsolete',
    ]);
    expect(readGenerationWork(store.db, SOURCE, first)[0]?.reason).toBe(SUPERSEDED_GENERATION);
    expect(readGeneration(store.db, SOURCE, first)?.state).toBe('replaced');
    expect(readGeneration(store.db, SOURCE, second)?.state).toBe('active');
  });

  it('carries a settlement obligation onto the replacement with its identity unchanged', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    settlement(first, 'reference:1', 'settlement:source-1:1');
    const second = prepared();

    const outcome = replaceProcessingGeneration(store.db, {
      sourceId: SOURCE,
      replacementGeneration: second,
    });

    expect(outcome.carried).toBe(1);
    const carried = readGenerationWork(store.db, SOURCE, second).find(
      (row) => row.kind === 'settlement',
    );
    expect(carried).toMatchObject({ workId: 'settlement:source-1:1', state: 'pending' });
    expect(
      readGenerationWork(store.db, SOURCE, first).filter((row) => row.kind === 'settlement'),
    ).toEqual([]);
  });

  it('closes a carried obligation the replacement already owes rather than colliding with it', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    settlement(first, 'reference:1', 'settlement:old');
    const second = prepared();
    settlement(second, 'reference:1', 'settlement:new');

    const outcome = replaceProcessingGeneration(store.db, {
      sourceId: SOURCE,
      replacementGeneration: second,
    });

    expect(outcome.carried).toBe(0);
    const closed = readGenerationWork(store.db, SOURCE, first).find(
      (row) => row.workId === 'settlement:old',
    );
    expect(closed).toMatchObject({ state: 'obsolete', reason: DUPLICATE_ON_REPLACEMENT });
    const held = readGenerationWork(store.db, SOURCE, second).find(
      (row) => row.workId === 'settlement:new',
    );
    expect(held).toMatchObject({ state: 'pending' });
  });

  it('rebinds the carried obligation when the replacement holds only a fresh preparation', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    settlement(first, 'reference:1', 'settlement:old');
    store.db
      .prepare('UPDATE source_work SET continuation_json = ? WHERE work_id = ?')
      .run('{"after":"pair-12"}', 'settlement:old');
    const second = prepared();
    settlement(second, 'reference:1', 'settlement:new');

    const outcome = replaceProcessingGeneration(store.db, {
      sourceId: SOURCE,
      replacementGeneration: second,
    });

    expect(outcome.carried).toBe(1);
    expect(
      readGenerationWork(store.db, SOURCE, second).filter((row) => row.kind === 'settlement'),
    ).toMatchObject([{ workId: 'settlement:old', state: 'pending' }]);
  });

  it('pins the carried obligation when both rows under one key have got somewhere', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    settlement(first, 'reference:1', 'settlement:old');
    const second = prepared();
    settlement(second, 'reference:1', 'settlement:new');
    store.db
      .prepare('UPDATE source_work SET continuation_json = ? WHERE work_id IN (?, ?)')
      .run('{"after":"pair-12"}', 'settlement:old', 'settlement:new');

    const outcome = replaceProcessingGeneration(store.db, {
      sourceId: SOURCE,
      replacementGeneration: second,
    });

    expect(outcome.carried).toBe(0);
    // The pin travels with the replacement under a key of its own. Left in the replaced
    // generation it would be invisible to active readiness, and a source nobody can reconcile
    // would read as a source that owes nothing.
    expect(
      readGenerationWork(store.db, SOURCE, second).find((row) => row.workId === 'settlement:old'),
    ).toMatchObject({
      state: 'pinned',
      reason: CONFLICTING_PROGRESS_ON_REPLACEMENT,
      workKey: 'conflict:reference:1',
    });
    expect(
      readGenerationWork(store.db, SOURCE, second).find((row) => row.workId === 'settlement:new'),
    ).toMatchObject({ state: 'pending' });
  });

  it('refuses an old generation completion after the replacement takes over', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    const second = prepared();
    replaceProcessingGeneration(store.db, { sourceId: SOURCE, replacementGeneration: second });

    expect(
      completeSourceWork(
        store.db,
        stageWorkId(SOURCE, first, 'entities'),
        { outcome: 'complete', reason: 'accepted_pass_applied' },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      readGenerationWork(store.db, SOURCE, first).find((row) => row.stageName === 'entities'),
    ).toMatchObject({ state: 'obsolete' });
  });

  it('advances the readiness counter when a replacement lands', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    const second = prepared();
    const before = readGeneration(store.db, SOURCE, second)?.operationalRevision ?? -1;

    const outcome = replaceProcessingGeneration(store.db, {
      sourceId: SOURCE,
      replacementGeneration: second,
    });

    expect(outcome.readinessRevision).toBeGreaterThan(before);
  });

  it('activates a first generation with nothing to displace', () => {
    const first = prepared();

    const outcome = replaceProcessingGeneration(store.db, {
      sourceId: SOURCE,
      replacementGeneration: first,
    });

    expect(outcome).toMatchObject({ replacedGeneration: undefined, obsoleted: 0, carried: 0 });
  });
});

describe('inventory completeness', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-inventory-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves the counter with the flag and repeats without moving it', () => {
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: SOURCE,
      policyRevision: 1,
      createdAt: NOW,
    });
    activateProcessingGeneration(store.db, SOURCE, generation);
    const before = readGeneration(store.db, SOURCE, generation)?.operationalRevision ?? -1;

    const first = markInventoryComplete(store.db, SOURCE, generation, true);
    expect(first).toBe(before + 1);
    expect(readGeneration(store.db, SOURCE, generation)?.inventoryComplete).toBe(true);
    expect(markInventoryComplete(store.db, SOURCE, generation, true)).toBe(first);
  });

  it('refuses a generation that is not active', () => {
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: SOURCE,
      policyRevision: 1,
      createdAt: NOW,
    });

    expect(markInventoryComplete(store.db, SOURCE, generation, true)).toBeUndefined();
    expect(readGeneration(store.db, SOURCE, generation)?.inventoryComplete).toBe(false);
  });
});
