import type { Driver } from 'neo4j-driver';
import { z } from 'zod';

import { PublicationOperation } from '../../publication/operation.js';
import { buildEvidenceRevision } from '../../publication/preconditions.js';
import type { PublicationKind } from '../../publication/types.js';
import { readCurrentCoverageContract } from '../../sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  publishedScopeToken,
  rejectScopeAdvance,
} from '../../sqlite/evidence-scope.js';
import { getLedgerEntry, markLedgerApplied } from '../../sqlite/ops-ledger.js';
import { runRead, type GraphTransaction } from '../connection.js';

const Payload = z.strictObject({
  nodeId: z.string().min(1),
  value: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  expectedScope: z.string(),
});
const Result = z.strictObject({ id: z.string(), value: z.string(), version: z.number().int() });
export type ProbePayload = z.infer<typeof Payload>;
const SCOPE = 'sqlite:stated_derivation:out';
const NOW = new Date('2026-09-08T06:00:00.000Z');

export async function seedPublicationProbe(
  driver: Driver,
  db: SqliteHandle,
  id: string,
): Promise<string> {
  await driver.executeQuery(
    'CREATE (n:PublicationFixture {id: $id, value: "initial", version: 0})',
    { id },
  );
  db.prepare(
    `INSERT INTO evidence_scope_versions
    (endpoint_id, relation_class, published_revision, allocated_revision, census_status, updated_at)
    VALUES (?, ?, 0, 0, 'established', ?)`,
  ).run(id, SCOPE, NOW.toISOString());
  return publishedScopeToken(db, { endpointId: id, relationClass: SCOPE }) ?? '';
}

export async function readPublicationProbe(
  driver: Driver,
  id: string,
): Promise<z.infer<typeof Result> | undefined> {
  return (
    await runRead(
      driver,
      'MATCH (n:PublicationFixture {id: $id}) RETURN n.id AS id, n.value AS value, n.version AS version',
      { id },
      (row) => Result.parse(row),
    )
  )[0];
}

export async function overwriteProbeVersion(
  driver: Driver,
  id: string,
  version: number,
): Promise<void> {
  await driver.executeQuery(
    'MATCH (n:PublicationFixture {id: $id}) SET n.version = toInteger($version)',
    { id, version },
  );
}

export async function renameGuardIdentity(driver: Driver, from: string, to: string): Promise<void> {
  await driver.executeQuery(
    'MATCH (g:PublicationGuard {substrate_id: $from}) SET g.substrate_id = $to',
    { from, to },
  );
}

export async function readProbeMaterialization(driver: Driver, id: string): Promise<string | null> {
  return (
    (
      await runRead(
        driver,
        'MATCH (n:PublicationFixture {id: $id}) RETURN n.materialized_for AS value',
        { id },
        (row) => (typeof row.value === 'string' ? row.value : null),
      )
    )[0] ?? null
  );
}

async function graphVersion(tx: GraphTransaction, id: string): Promise<number | undefined> {
  return (
    await tx.run(
      'MATCH (n:PublicationFixture {id: $id}) RETURN n.version AS version',
      { id },
      (row) => (typeof row.version === 'number' ? row.version : undefined),
    )
  )[0];
}

/** The fixture exercises real scoped storage and deliberately non-idempotent acknowledgment work. */
export class ProbePublication extends PublicationOperation<
  ProbePayload,
  ProbePayload,
  z.infer<typeof Result>
> {
  constructor(
    options: {
      readonly kind?: PublicationKind;
      readonly failAck?: () => boolean;
      readonly graphApplied?: () => void;
      readonly finishGraph?: boolean;
      readonly failFinish?: () => boolean;
    } = {},
  ) {
    super({
      kind: options.kind ?? 'semantic_write',
      effectKinds: ['acknowledgment'],
      payload: Payload,
      data: Payload,
      result: Result,
      async prepare(context, payload) {
        if (context.db.inTransaction) {
          throw new Error('prepare entered a SQLite transaction');
        }
        const coverage = readCurrentCoverageContract(context.db);
        if (coverage === undefined) {
          throw new Error('fixture coverage is absent');
        }
        return {
          data: payload,
          expected: {
            coverageEpoch: coverage.epoch,
            evidence: buildEvidenceRevision([
              {
                kind: 'relation_scope',
                id: payload.nodeId,
                scope: SCOPE,
                version: payload.expectedScope,
              },
              {
                kind: 'node',
                id: payload.nodeId,
                scope: 'graph.node_state',
                version: String(payload.expectedVersion),
              },
            ]),
            sources: [],
            heads: [],
          },
          scopes: [{ kind: 'relation_scope', id: payload.nodeId, scope: SCOPE }],
          effects: [{ kind: 'acknowledgment', detail: { id: payload.nodeId } }],
        };
      },
      async check(context, data) {
        if (context.db.inTransaction) {
          throw new Error('check entered a SQLite transaction');
        }
        const version = await graphVersion(context.graph, data.nodeId);
        const token = publishedScopeToken(context.db, {
          endpointId: data.nodeId,
          relationClass: SCOPE,
        });
        return version === data.expectedVersion && token === data.expectedScope
          ? { status: 'valid' }
          : { status: 'deferred', reason: 'evidence_changed' };
      },
      async applyGraph(context, data) {
        if (context.db.inTransaction) {
          throw new Error('graph write entered a SQLite transaction');
        }
        options.graphApplied?.();
        const rows = await context.graph.run(
          `MATCH (n:PublicationFixture {id: $id}) WHERE n.version = toInteger($expected)
           SET n.value = $value, n.version = n.version + 1
           RETURN n.id AS id, n.value AS value, n.version AS version`,
          { id: data.nodeId, expected: data.expectedVersion, value: data.value },
          (row) => Result.parse(row),
        );
        if (rows[0] === undefined) {
          throw new Error('publication fixture version changed');
        }
        return rows[0];
      },
      prepareSqlite(context, data) {
        if (!context.db.inTransaction) {
          throw new Error('prepare was not durable with the intent');
        }
        markLedgerApplied(context.db, `accepted:${context.operationId}`, data);
        prepareScopeAdvance(context.db, {
          endpointId: data.nodeId,
          relationClass: SCOPE,
          operationId: context.operationId,
          updatedAt: NOW,
        });
        return undefined;
      },
      acknowledgeSqlite(context, data) {
        if (!context.db.inTransaction) {
          throw new Error('ack was not atomic');
        }
        acknowledgeScopeAdvance(context.db, {
          endpointId: data.nodeId,
          relationClass: SCOPE,
          operationId: context.operationId,
          updatedAt: new Date(context.knownFrom),
        });
        const key = `ack:${context.operationId}`;
        const old = getLedgerEntry(context.db, key)?.summary;
        const count = typeof old === 'number' ? old : 0;
        markLedgerApplied(context.db, key, count + 1);
        if (options.failAck?.()) {
          throw new Error('ack storage unavailable');
        }
        return undefined;
      },
      discardSqlite(context, data) {
        rejectScopeAdvance(context.db, {
          endpointId: data.nodeId,
          relationClass: SCOPE,
          operationId: context.operationId,
          updatedAt: NOW,
        });
        return undefined;
      },
      ...(options.finishGraph === true
        ? {
            async finishGraph(context, _data, result) {
              if (context.db.inTransaction) {
                throw new Error('graph completion entered a SQLite transaction');
              }
              const rows = await context.graph.run(
                `MATCH (n:PublicationFixture {id: $id}) WHERE n.version = toInteger($version)
             SET n.materialized_for = $operationId RETURN n.id AS id`,
                { id: result.id, version: result.version, operationId: context.operationId },
                (row) => row.id,
              );
              if (rows.length !== 1 || options.failFinish?.()) {
                throw new Error('graph materialization unavailable');
              }
            },
          }
        : {}),
    });
  }
}

export function currentProbeScope(db: SqliteHandle, nodeId: string): string {
  return publishedScopeToken(db, { endpointId: nodeId, relationClass: SCOPE }) ?? '';
}
