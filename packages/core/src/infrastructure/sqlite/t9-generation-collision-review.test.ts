import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { replaceProcessingGeneration } from './generation-lifecycle.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  prepareGenerationWork,
  prepareInventorySkeleton,
} from './processing-generations.js';

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

  it('preserves the identity and continuation of carried settlement work on a key collision', () => {
    const first = prepared();
    activateProcessingGeneration(store.db, SOURCE, first);
    settlement(first, 'ref:1', 'old');
    store.db
      .prepare('UPDATE source_work SET input_revision_json=?,continuation_json=? WHERE work_id=?')
      .run('{"proof":"p1"}', '{"after":"pair-12"}', 'old');
    const second = prepared();
    settlement(second, 'ref:1', 'new');
    replaceProcessingGeneration(store.db, { sourceId: SOURCE, replacementGeneration: second });
    const active = store.db
      .prepare(
        "SELECT work_id,input_revision_json,continuation_json FROM source_work WHERE source_id=? AND processing_generation=? AND kind='settlement' AND state='pending'",
      )
      .get(SOURCE, second);
    expect(active).toEqual({
      work_id: 'old',
      input_revision_json: '{"proof":"p1"}',
      continuation_json: '{"after":"pair-12"}',
    });
  });
});
