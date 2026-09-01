import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyEntityMerge } from './entity-merge-writer.js';
import { DedupFakeGraph } from './stages/entity-dedup.fixture.js';
import { loadEntityDedupDetails } from '../../infrastructure/graph/entity-dedup-queries.js';
import { ENTITY_NAME_VECTOR_PROPERTY } from '../../infrastructure/graph/seed-queries.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { entityMergeLedgerKey } from '../domain/entity-merge.js';

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
    const key = entityMergeLedgerKey('canon-1', ['dup-1']);
    expect(getLedgerEntry(store.db, key)).toBeDefined();
  });
});
