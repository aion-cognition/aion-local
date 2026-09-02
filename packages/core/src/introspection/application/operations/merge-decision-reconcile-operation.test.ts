import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mergeDecisionReconcileOperation } from './merge-decision-reconcile-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { loadEntityDedupDetails } from '../../../infrastructure/graph/entity-dedup-queries.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  getEntityMergeDecisionByKey,
  listEntityMergeDecisions,
} from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import { applyEntityMerge } from '../../../reflection/application/entity-merge-writer.js';
import { DedupFakeGraph } from '../../../reflection/application/stages/entity-dedup.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { introspectionOperations } from '../catalog.js';

/**
 * The merge writes its decision to SQLite and the graph commits before it, so a process that
 * dies in between leaves a `decision_key` on the canonical that nothing answers for. Nothing
 * replays it: every candidate read is currency-filtered and the absorbed side is closed, so
 * the pair can never re-form and an unmerge reports no decision at all.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;
let graph: DedupFakeGraph;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-merge-decision-reconcile-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM entity_merge_decisions');
  db.exec('DELETE FROM ops_ledger');
  graph = new DedupFakeGraph();
  for (const id of ['canon-1', 'dup-1']) {
    graph.seedNode(id, ['Entity', 'Memory', 'AionNode'], {
      name: id,
      name_norm: id,
      type: 'concept',
    });
  }
});

function context(config: Config = DEFAULTS): OperationContext {
  return {
    driver: graph.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

/** One merge, then the SQLite half of it thrown away: exactly what a crash after the commit leaves. */
async function mergeThenLoseTheRecord(): Promise<string> {
  const [canonical, member] = await loadEntityDedupDetails(graph.driver, ['canon-1', 'dup-1']);
  if (canonical === undefined || member === undefined) {
    throw new Error('seeded entities did not load');
  }
  await applyEntityMerge(
    { driver: graph.driver, db, logger },
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
  const [decision] = listEntityMergeDecisions(db);
  if (decision === undefined) {
    throw new Error('the merge wrote no decision to lose');
  }
  db.exec('DELETE FROM entity_merge_decisions');
  return decision.idempotencyKey;
}

describe('a merge whose decision record never reached SQLite', () => {
  it('gets a record back naming the merge the graph still states', async () => {
    const key = await mergeThenLoseTheRecord();
    expect(getEntityMergeDecisionByKey(db, key)).toBeUndefined();

    const outcome = await mergeDecisionReconcileOperation().run(context());

    expect(outcome).toMatchObject({ status: 'applied', itemsAffected: 1 });
    expect(getEntityMergeDecisionByKey(db, key)).toMatchObject({
      canonicalId: 'canon-1',
      memberIds: ['dup-1'],
      tier: 'reconciled',
    });
  });

  it('leaves a merge whose record survived exactly as it is', async () => {
    const [canonical, member] = await loadEntityDedupDetails(graph.driver, ['canon-1', 'dup-1']);
    if (canonical === undefined || member === undefined) {
      throw new Error('seeded entities did not load');
    }
    await applyEntityMerge(
      { driver: graph.driver, db, logger },
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

    const outcome = await mergeDecisionReconcileOperation().run(context());

    expect(outcome).toMatchObject({ status: 'noop', itemsAffected: 0 });
    expect(listEntityMergeDecisions(db).map((decision) => decision.tier)).toEqual(['tier0']);
  });

  it('is a maintenance operation the loop can select', () => {
    expect(introspectionOperations().map((operation) => operation.name)).toContain(
      mergeDecisionReconcileOperation().name,
    );
  });
});
