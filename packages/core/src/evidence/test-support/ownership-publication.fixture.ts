import { z } from 'zod';

import { checkedContext } from './evidence.fixture.js';
import { projectOwnershipSummary } from '../../infrastructure/graph/ownership-summary-queries.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { CommittedIncidence } from '../../infrastructure/sqlite/committed-evidence.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import {
  ownershipCensusEstablished,
  ownershipIncidence,
  ownershipSummaryFor,
} from '../application/ownership.js';
import { OWNERSHIP_SCOPES, ownershipEvidenceVersion } from '../domain/ownership.js';
import { durableRoleScope } from '../domain/scopes.js';

/**
 * A semantic write that changes which sources carry a node, shaped the way a converted writer
 * will be: the incidence rows prepare in the SQLite intent, the graph summary is written inside
 * the same operation's graph transaction, and the acknowledgment is what makes the projection
 * trustworthy. Between the graph commit and that acknowledgment the summary is durable and
 * unproved at the same time, which is the state the pre-limit predicate has to detect.
 */

const Row = z.strictObject({ sourceId: z.string().min(1), role: z.string().min(1) });
const Payload = z.strictObject({ nodeId: z.string().min(1), rows: z.array(Row) });
export type OwnershipPayload = z.infer<typeof Payload>;
const Result = z.strictObject({ id: z.string(), wrote: z.boolean() });

const NOW = new Date('2026-09-08T06:00:00.000Z');

function pendingRows(data: OwnershipPayload): readonly CommittedIncidence[] {
  return data.rows.map((row) => ({
    sourceId: row.sourceId,
    nodeId: data.nodeId,
    role: row.role,
    currency: 'open' as const,
    linkId: `${row.sourceId}:${data.nodeId}:${row.role}`,
    linkVersion: 1,
  }));
}

/**
 * What the node will carry once this operation lands: the rows already committed plus the ones
 * this intent prepared. The committed view cannot see a prepared row, so the summary is derived
 * from both rather than from a read that would describe the substrate before the write.
 */
function summaryAfter(db: SqliteHandle, data: OwnershipPayload) {
  const context = checkedContext();
  const committed = ownershipIncidence(db, [data.nodeId], context);
  const merged = [...committed];
  for (const row of pendingRows(data)) {
    if (!merged.some((held) => held.sourceId === row.sourceId && held.role === row.role)) {
      merged.push(row);
    }
  }
  return ownershipSummaryFor(db, data.nodeId, merged, context, {
    // The scopes this operation advances are counted by its own acknowledgment.
    censusEstablished: data.rows.length > 0 || ownershipCensusEstablished(db, data.nodeId),
  });
}

function writeIncidence(db: SqliteHandle, operationId: string, data: OwnershipPayload): void {
  for (const row of data.rows) {
    const linkId = `${row.sourceId}:${data.nodeId}:${row.role}`;
    db.prepare(
      `INSERT INTO evidence_links (link_id, kind, qualifier, from_id, to_id, record_source, created_at)
       VALUES (?, ?, 'source', ?, ?, 'fixture', ?)
       ON CONFLICT (link_id) DO NOTHING`,
    ).run(linkId, row.role, row.sourceId, data.nodeId, NOW.toISOString());
    db.prepare(
      `INSERT INTO evidence_link_versions
         (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
          observed_at, operation_key, operation_id, known_from, observed_ack_at)
       VALUES (?, 1, NULL, 'asserted', '{}', '{}', ?, ?, ?, NULL, NULL)
       ON CONFLICT (link_id, version) DO NOTHING`,
    ).run(linkId, NOW.toISOString(), `key:${linkId}`, operationId);
    db.prepare(
      `INSERT INTO source_incidence (source_id, node_id, role, currency, link_id, link_version)
       VALUES (?, ?, ?, 'open', ?, 1)
       ON CONFLICT (source_id, node_id, role) DO NOTHING`,
    ).run(row.sourceId, data.nodeId, row.role, linkId);
  }
}

function retireIncidence(db: SqliteHandle, nodeId: string, sourceId: string): void {
  db.prepare(
    `UPDATE source_incidence SET currency = 'closed' WHERE node_id = ? AND source_id = ?`,
  ).run(nodeId, sourceId);
}

/** Closes every row a source holds on the node, which is how a shared node becomes own-only. */
export function retireOwnership(db: SqliteHandle, nodeId: string, sourceId: string): void {
  retireIncidence(db, nodeId, sourceId);
}

export class OwnershipProjectionPublication extends PublicationOperation<
  OwnershipPayload,
  OwnershipPayload,
  z.infer<typeof Result>
> {
  constructor() {
    super({
      kind: 'semantic_write',
      effectKinds: ['ownership_projection'],
      payload: Payload,
      data: Payload,
      result: Result,
      async prepare(context, payload) {
        const coverage = readCurrentCoverageContract(context.db);
        if (coverage === undefined) {
          throw new Error('fixture coverage is absent');
        }
        return Promise.resolve({
          data: payload,
          expected: {
            coverageEpoch: coverage.epoch,
            evidence: buildEvidenceRevision([]),
            sources: [],
            heads: [],
          },
          scopes: OWNERSHIP_SCOPES.map(({ role, direction }) => ({
            kind: 'relation_scope' as const,
            id: payload.nodeId,
            scope: durableRoleScope(role, direction),
          })),
          effects: [{ kind: 'ownership_projection', detail: { id: payload.nodeId } }],
        });
      },
      check() {
        return Promise.resolve({ status: 'valid' });
      },
      async applyGraph(context, data) {
        const pairing = readSubstratePairing(context.db);
        if (pairing === undefined || context.sequence === null) {
          throw new Error('the projection needs a paired substrate and a sequence');
        }
        const summary = summaryAfter(context.db, data);
        const wrote = await projectOwnershipSummary(context.graph, {
          nodeId: data.nodeId,
          sessions: summary.sessions,
          unknownAttribution: summary.unknownAttribution,
          censusEstablished: summary.censusEstablished,
          evidenceVersion: ownershipEvidenceVersion(summary),
          sequence: context.sequence,
          substrateId: pairing.substrateId,
        });
        return { id: data.nodeId, wrote };
      },
      prepareSqlite(context, data) {
        writeIncidence(context.db, context.operationId, data);
        for (const { role, direction } of OWNERSHIP_SCOPES) {
          prepareScopeAdvance(context.db, {
            endpointId: data.nodeId,
            relationClass: durableRoleScope(role, direction),
            operationId: context.operationId,
            updatedAt: NOW,
          });
        }
        return undefined;
      },
      acknowledgeSqlite(context, data) {
        for (const { role, direction } of OWNERSHIP_SCOPES) {
          acknowledgeScopeAdvance(context.db, {
            endpointId: data.nodeId,
            relationClass: durableRoleScope(role, direction),
            operationId: context.operationId,
            updatedAt: new Date(context.knownFrom),
            censusStatus: 'established',
          });
        }
        context.db
          .prepare(
            `UPDATE evidence_link_versions SET known_from = ?, observed_ack_at = ?
             WHERE operation_id = ? AND known_from IS NULL`,
          )
          .run(context.knownFrom, context.observedAckAt, context.operationId);
        return undefined;
      },
      discardSqlite(context, data) {
        for (const { role, direction } of OWNERSHIP_SCOPES) {
          rejectScopeAdvance(context.db, {
            endpointId: data.nodeId,
            relationClass: durableRoleScope(role, direction),
            operationId: context.operationId,
            updatedAt: NOW,
          });
        }
        return undefined;
      },
    });
  }
}
