import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyEntityMerge, type EntityMergeWriteResult } from './entity-merge-writer.js';
import { DedupFakeGraph } from './stages/entity-dedup.fixture.js';
import { loadEntityDedupDetails } from '../../infrastructure/graph/entity-dedup-queries.js';
import { ENTITY_NAME_VECTOR_PROPERTY } from '../../infrastructure/graph/seed-queries.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listEntityMergeDecisions } from '../../infrastructure/sqlite/entity-merge-decisions.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { ENTITY_CASCADE_VERSION, entityMergeLedgerKey } from '../domain/entity-merge.js';

/**
 * `applyEntityMerge`'s post-commit branch: the graph write already landed, and only the
 * best-effort vector cleanup after it can still fail. `DedupFakeGraph` never fails any
 * statement on its own, so the throwing path needs a graph that fails on purpose.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');

/** Fails only the statement `clearEntityVectors` issues, the way a busy vector index would. */
class VectorCleanupThrowsGraph extends DedupFakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (cypher.includes(`SET n.${ENTITY_NAME_VECTOR_PROPERTY} = null`)) {
      throw new Error('vector index unavailable');
    }
    return super.executeQuery(cypher, parameters);
  }
}

let store: SqliteStore;
let dataDir: string;
let logger: Logger;

/** A canonical and one duplicate, ready to load as dedup details. */
function seededGraph(): DedupFakeGraph {
  const graph = new DedupFakeGraph();
  for (const id of ['canon-1', 'dup-1']) {
    graph.seedNode(id, ['Entity', 'Memory', 'AionNode'], {
      name: id,
      name_norm: id,
      type: 'concept',
    });
  }
  return graph;
}

async function mergeDuplicate(
  graph: DedupFakeGraph,
  cascadeVersion: string,
): Promise<EntityMergeWriteResult> {
  const [canonical, member] = await loadEntityDedupDetails(graph.driver, ['canon-1', 'dup-1']);
  if (canonical === undefined || member === undefined) {
    throw new Error('seeded entities did not load');
  }
  return applyEntityMerge(
    { driver: graph.driver, db: store.db, logger },
    {
      canonical,
      members: [canonical, member],
      tier: 'tier0',
      reasons: ['test'],
      signals: [],
      method: 'test_merge',
      cascadeVersion,
      now: NOW,
    },
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-merge-writer-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a post-commit vector cleanup that throws', () => {
  it('still lands the merge and reports the cleanup as deferred', async () => {
    const graph = new VectorCleanupThrowsGraph();
    graph.seedNode('canon-1', ['Entity', 'Memory', 'AionNode'], {
      name: 'canon-1',
      name_norm: 'canon-1',
      type: 'concept',
    });
    graph.seedNode('dup-1', ['Entity', 'Memory', 'AionNode'], {
      name: 'dup-1',
      name_norm: 'dup-1',
      type: 'concept',
    });
    const [canonical, member] = await loadEntityDedupDetails(graph.driver, ['canon-1', 'dup-1']);
    if (canonical === undefined || member === undefined) {
      throw new Error('seeded entities did not load');
    }

    const result = await applyEntityMerge(
      { driver: graph.driver, db: store.db, logger },
      {
        canonical,
        members: [canonical, member],
        tier: 'tier0',
        reasons: ['test'],
        signals: [],
        method: 'test_merge',
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: 'merged', vectorCleanupDeferred: true });
    // The ledger mark still lands after a deferred cleanup: the graph write committed, and a
    // best-effort index refresh failing is not a reason to replay a merge that already happened.
    const key = entityMergeLedgerKey(ENTITY_CASCADE_VERSION, 'canon-1', ['dup-1']);
    expect(getLedgerEntry(store.db, key)).toBeDefined();
  });
});

describe('a merge re-decided under a later cascade version', () => {
  it('writes its own decision row instead of stopping at the earlier version gate', async () => {
    const first = await mergeDuplicate(seededGraph(), 'cascade-1');
    expect(first.status).toBe('merged');

    // A fresh graph and the same ledger, so the only thing that can stop the second write is
    // the operation gate the first merge marked.
    const second = await mergeDuplicate(seededGraph(), 'cascade-2');

    expect(second.status).toBe('merged');
    expect(listEntityMergeDecisions(store.db).map((decision) => decision.cascadeVersion)).toEqual([
      'cascade-1',
      'cascade-2',
    ]);
  });
});
