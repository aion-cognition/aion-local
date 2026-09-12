import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  sourceSuppressionOperationId,
  sourceSuppressionPublication,
} from './source-suppression.js';
import { GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import {
  PUBLICATION_KINDS,
  type PublicationAckContext,
  type PublicationContext,
  type PublicationPlan,
  type PublicationSqliteContext,
} from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readScopeMirror } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import {
  hasPendingSourceState,
  isSourceForgotten,
  listSourceStateVersions,
} from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * The suppression writer's durable half, driven without a graph.
 *
 * A forget is two writes that have to agree: the stamp the graph carries and the statement the
 * records keep. These cases are about the second one and about what happens to it when the first
 * does not land, which is the failure the fence reads as an obligation nobody can discharge.
 */

const NOW = '2026-09-12T09:00:00.000Z';
const SOURCE = 'episode-1';
const STRANGER = 'claim-1';

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  recordSourceRecord(store.db, {
    sourceId: SOURCE,
    sessionId: 'session-1',
    verificationStatus: 'pinned',
    verificationReason: 'fixture',
    occurredAt: NOW,
    createdAt: new Date(NOW),
  });
});

afterEach(() => {
  store.close();
});

/** The committed view asks whether the statement's own operation acknowledged; this says yes. */
function acknowledgeIntent(operationId: string): void {
  preparePublicationIntent(store.db, {
    operationId,
    kind: 'source_suppression',
    payloadDigest: `digest:${operationId}`,
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: new Date(NOW),
  });
  acknowledgePublicationIntent(store.db, {
    operationId,
    resultDigest: `result:${operationId}`,
    resultJson: '{}',
    observedAckAt: new Date(NOW),
  });
}

function plan(act: 'forget' | 'unforget', nodeId: string): PublicationPlan {
  return {
    data: { act, nodeId, observedAt: NOW },
    expected: {
      coverageEpoch: 'epoch-1',
      evidence: buildEvidenceRevision([]),
      sources: [],
      heads: [],
    },
    scopes: [],
    effects: [{ kind: 'source_suppression_statement', detail: { nodeId, act } }],
  };
}

function sqliteContext(operationId: string): PublicationSqliteContext {
  return { operationId, sequence: '1', db: store.db };
}

function ackContext(operationId: string): PublicationAckContext {
  return {
    ...sqliteContext(operationId),
    sequence: '1',
    knownFrom: NOW,
    observedAckAt: NOW,
    clockClamped: false,
  };
}

/** A transaction that answers one suppression-state read and nothing else. */
function graphSaying(rows: readonly Record<string, unknown>[]): GraphTransaction {
  return new GraphTransaction({
    run: () =>
      Promise.resolve({
        records: rows.map((row) => ({ toObject: () => row })),
      }) as never,
  });
}

function checkContext(graph: GraphTransaction): PublicationContext {
  return {
    operationId: 'op-check',
    sequence: null,
    graph,
    db: store.db,
    now: new Date(NOW),
    installedKinds: [...PUBLICATION_KINDS],
  };
}

it('refuses an act on a node the guard cannot find', async () => {
  for (const act of ['forget', 'unforget'] as const) {
    await expect(
      sourceSuppressionPublication.check(checkContext(graphSaying([])), plan(act, SOURCE)),
    ).resolves.toEqual({ status: 'deferred', reason: 'node_absent' });
  }
});

it('refuses a forget on a node that already carries the stamp', async () => {
  await expect(
    sourceSuppressionPublication.check(
      checkContext(graphSaying([{ forgotten: true }])),
      plan('forget', SOURCE),
    ),
  ).resolves.toEqual({ status: 'deferred', reason: 'already_forgotten' });
});

it('refuses an unforget on a node that was never forgotten', async () => {
  await expect(
    sourceSuppressionPublication.check(
      checkContext(graphSaying([{ forgotten: false }])),
      plan('unforget', SOURCE),
    ),
  ).resolves.toEqual({ status: 'deferred', reason: 'not_forgotten' });
});

it('admits each act against the state it is the reversal of', async () => {
  await expect(
    sourceSuppressionPublication.check(
      checkContext(graphSaying([{ forgotten: false }])),
      plan('forget', SOURCE),
    ),
  ).resolves.toEqual({ status: 'valid' });
  await expect(
    sourceSuppressionPublication.check(
      checkContext(graphSaying([{ forgotten: true }])),
      plan('unforget', SOURCE),
    ),
  ).resolves.toEqual({ status: 'valid' });
});

it('prepares a statement that is durable and invisible until the acknowledgment', () => {
  const operationId = sourceSuppressionOperationId('forget', SOURCE, new Date(NOW));
  sourceSuppressionPublication.prepareSqlite(sqliteContext(operationId), plan('forget', SOURCE));
  acknowledgeIntent(operationId);

  expect(listSourceStateVersions(store.db, SOURCE)).toMatchObject([
    { stateKind: 'forgotten', knownFrom: null },
  ]);
  expect(hasPendingSourceState(store.db, SOURCE)).toBe(true);
  expect(isSourceForgotten(store.db, SOURCE)).toBe(false);
});

it('promotes the statement and advances the node state mirror on acknowledgment', () => {
  const operationId = sourceSuppressionOperationId('forget', SOURCE, new Date(NOW));
  const forget = plan('forget', SOURCE);
  sourceSuppressionPublication.prepareSqlite(sqliteContext(operationId), forget);
  acknowledgeIntent(operationId);
  sourceSuppressionPublication.acknowledgeSqlite(ackContext(operationId), forget, {
    changed: true,
  });

  expect(hasPendingSourceState(store.db, SOURCE)).toBe(false);
  expect(isSourceForgotten(store.db, SOURCE)).toBe(true);
  expect(
    readScopeMirror(store.db, { endpointId: SOURCE, relationClass: GRAPH_NODE_SCOPE }),
  ).toMatchObject({ mirroredRevision: 1, operationId });
});

it('ends the chain with an unforget rather than erasing the forget', () => {
  const forgetId = sourceSuppressionOperationId('forget', SOURCE, new Date(NOW));
  const forget = plan('forget', SOURCE);
  sourceSuppressionPublication.prepareSqlite(sqliteContext(forgetId), forget);
  acknowledgeIntent(forgetId);
  sourceSuppressionPublication.acknowledgeSqlite(ackContext(forgetId), forget, { changed: true });

  const unforgetId = sourceSuppressionOperationId('unforget', SOURCE, new Date(NOW));
  const unforget = plan('unforget', SOURCE);
  sourceSuppressionPublication.prepareSqlite(sqliteContext(unforgetId), unforget);
  acknowledgeIntent(unforgetId);
  sourceSuppressionPublication.acknowledgeSqlite(ackContext(unforgetId), unforget, {
    changed: true,
  });

  expect(isSourceForgotten(store.db, SOURCE)).toBe(false);
  expect(listSourceStateVersions(store.db, SOURCE).map((entry) => entry.stateKind)).toEqual([
    'forgotten',
    'unforgotten',
  ]);
});

it('releases the prepared statement when the operation is discarded', () => {
  const operationId = sourceSuppressionOperationId('forget', SOURCE, new Date(NOW));
  const forget = plan('forget', SOURCE);
  sourceSuppressionPublication.prepareSqlite(sqliteContext(operationId), forget);
  expect(hasPendingSourceState(store.db, SOURCE)).toBe(true);

  sourceSuppressionPublication.discardSqlite(sqliteContext(operationId), forget, 'node_absent');

  // Left behind, this row is owed by an operation that will never acknowledge: no retry carries
  // its identity, and the eviction fence reads a pending statement as a decision about to move.
  expect(hasPendingSourceState(store.db, SOURCE)).toBe(false);
  expect(listSourceStateVersions(store.db, SOURCE)).toEqual([]);
});

it('releases the prepared statement when the graph found nothing to move', () => {
  const operationId = sourceSuppressionOperationId('forget', SOURCE, new Date(NOW));
  const forget = plan('forget', SOURCE);
  sourceSuppressionPublication.prepareSqlite(sqliteContext(operationId), forget);
  acknowledgeIntent(operationId);
  sourceSuppressionPublication.acknowledgeSqlite(ackContext(operationId), forget, {
    changed: false,
  });

  expect(hasPendingSourceState(store.db, SOURCE)).toBe(false);
  expect(isSourceForgotten(store.db, SOURCE)).toBe(false);
});

it('writes no statement for a node the records do not hold as a source', () => {
  const operationId = sourceSuppressionOperationId('forget', STRANGER, new Date(NOW));
  const forget = plan('forget', STRANGER);
  sourceSuppressionPublication.prepareSqlite(sqliteContext(operationId), forget);
  acknowledgeIntent(operationId);
  sourceSuppressionPublication.acknowledgeSqlite(ackContext(operationId), forget, {
    changed: true,
  });

  // The statement table is keyed by source and there is no second table for the rest of the
  // graph. The receipt is the durable record in that case, and the mirror still moves.
  expect(listSourceStateVersions(store.db, STRANGER)).toEqual([]);
  expect(
    readScopeMirror(store.db, { endpointId: STRANGER, relationClass: GRAPH_NODE_SCOPE }),
  ).toMatchObject({ mirroredRevision: 1 });
});
