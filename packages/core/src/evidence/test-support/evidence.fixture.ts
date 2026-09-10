import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  recordScopeMirror,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import {
  recordSourceStateVersion,
  type SourceStateKind,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import {
  writeSourceManifest,
  type SourceManifest,
} from '../../reflection/application/source-manifest.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { prepareEpisode } from '../../reflection/domain/content.js';
import { NODE_SUPPORT_SCOPES } from '../application/node-support.js';
import { GRAPH_NODE_SCOPE } from '../domain/scopes.js';

/**
 * Substrate seeding for the evidence reads: an accepted source with its records, committed
 * incidence, committed source state, and an established scope census. Everything is written
 * through the same helpers the writers use, so a reader that agrees with the fixture agrees
 * with what an acceptance actually leaves behind.
 */

export function seedSource(
  db: SqliteHandle,
  input: {
    readonly sourceId: string;
    readonly sessionId: string;
    readonly identity: string;
    readonly content: ReflectionContent;
    readonly turnIds?: readonly string[];
    readonly now: Date;
  },
): SourceManifest {
  const prepared = prepareEpisode(input.content, input.now);
  return db
    .transaction((): SourceManifest =>
      writeSourceManifest(
        db,
        {
          sourceId: input.sourceId,
          sessionId: input.sessionId,
          identity: input.identity,
          prepared,
          payload: input.content,
          references: undefined,
          lane: undefined,
          origin: undefined,
          pipelineVersion: 'fixture',
          operationKey: `accept:${input.sourceId}`,
          readiness: undefined,
          now: input.now,
        },
        input.turnIds ?? [],
      ),
    )
    .immediate();
}

function acknowledge(db: SqliteHandle, operationId: string, at: Date): void {
  preparePublicationIntent(db, {
    operationId,
    kind: 'intake',
    payloadDigest: `digest:${operationId}`,
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: at,
  });
  acknowledgePublicationIntent(db, {
    operationId,
    resultDigest: `result:${operationId}`,
    resultJson: '{}',
    observedAckAt: at,
  });
}

/** One incidence row in the committed view: the link, its acknowledged version, and the row. */
export function commitIncidence(
  db: SqliteHandle,
  input: {
    readonly sourceId: string;
    readonly nodeId: string;
    readonly role: string;
    readonly operationId: string;
    readonly at: Date;
    /** A closed row records an incidence the writers have since retired. */
    readonly currency?: 'open' | 'closed';
  },
): void {
  const linkId = `${input.sourceId}:${input.nodeId}:${input.role}`;
  db.prepare(
    `INSERT INTO evidence_links (link_id, kind, qualifier, from_id, to_id, record_source, created_at)
     VALUES (?, ?, 'source', ?, ?, 'fixture', ?)
     ON CONFLICT (link_id) DO NOTHING`,
  ).run(linkId, input.role, input.sourceId, input.nodeId, input.at.toISOString());
  db.prepare(
    `INSERT INTO evidence_link_versions
       (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
        observed_at, operation_key, operation_id, known_from, observed_ack_at)
     VALUES (?, 1, NULL, 'asserted', '{}', '{}', ?, ?, ?, ?, ?)`,
  ).run(
    linkId,
    input.at.toISOString(),
    `key:${linkId}`,
    input.operationId,
    input.at.toISOString(),
    input.at.toISOString(),
  );
  db.prepare(
    `INSERT INTO source_incidence (source_id, node_id, role, currency, link_id, link_version)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT (source_id, node_id, role) DO NOTHING`,
  ).run(input.sourceId, input.nodeId, input.role, input.currency ?? 'open', linkId);
  acknowledge(db, input.operationId, input.at);
}

/** One statement about a source, visible in the committed view from `at`. */
export function commitSourceState(
  db: SqliteHandle,
  input: {
    readonly sourceId: string;
    readonly stateKind: SourceStateKind;
    readonly operationId: string;
    readonly at: Date;
  },
): void {
  recordSourceStateVersion(db, {
    sourceId: input.sourceId,
    stateKind: input.stateKind,
    operationId: input.operationId,
    observedAt: input.at,
    knownFrom: input.at,
  });
  acknowledge(db, input.operationId, input.at);
}

/** A scope whose census has been established, so an empty read of it means something. */
export function establishScope(
  db: SqliteHandle,
  endpointId: string,
  relationClass: string,
  at: Date,
): void {
  const operationId = `census:${endpointId}:${relationClass}`;
  prepareScopeAdvance(db, { endpointId, relationClass, operationId, updatedAt: at });
  acknowledgeScopeAdvance(db, {
    endpointId,
    relationClass,
    operationId,
    updatedAt: at,
    censusStatus: 'established',
  });
}

/**
 * A scope nobody has written at all, which is the state an endpoint no producer has covered is
 * actually in: an absent row rather than a counted one. It is the only way to build that state
 * once a writer establishes the scope at the moment it creates the endpoint.
 */
export function dropScope(db: SqliteHandle, endpointId: string, relationClass: string): void {
  db.prepare(
    'DELETE FROM evidence_scope_versions WHERE endpoint_id = ? AND relation_class = ?',
  ).run(endpointId, relationClass);
}

/**
 * Every scope a support reading asks about this node, established.
 *
 * Taken from the reader's own list rather than written out here, so a test cannot certify a node
 * under a scope set the production predicate has moved past.
 */
export function establishNodeSupportScopes(db: SqliteHandle, nodeId: string, at: Date): void {
  for (const scope of NODE_SUPPORT_SCOPES) {
    establishScope(db, nodeId, scope, at);
  }
}

/**
 * The graph counter a node's semantic state is read from: counted, and mirrored at one reading.
 * A judgment binds it, so a node without it has a statement nobody has proved is the current one.
 */
export function establishNodeState(
  db: SqliteHandle,
  nodeId: string,
  input: { readonly revision: number; readonly at: Date },
): void {
  establishScope(db, nodeId, GRAPH_NODE_SCOPE, input.at);
  recordScopeMirror(db, {
    endpointId: nodeId,
    relationClass: GRAPH_NODE_SCOPE,
    mirroredRevision: input.revision,
    operationId: `state:${nodeId}:${String(input.revision)}`,
    mirroredAt: input.at,
  });
}

export function checkedContext(
  overrides: { readonly mode?: ReadMode; readonly now?: Date } = {},
): CheckedReadContext {
  return {
    mode: overrides.mode ?? {},
    now: overrides.now ?? new Date('2026-09-08T12:00:00.000Z'),
    coverageEpoch: 'epoch-1',
    contractVersion: 1,
    fieldPolicyVersion: 1,
    coverageState: 'active',
    historySince: '2026-01-01T00:00:00.000Z',
  };
}
