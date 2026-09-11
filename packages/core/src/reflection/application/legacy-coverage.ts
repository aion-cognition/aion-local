import { durableRoleScope, nodeScopeDirection } from '../../evidence/domain/scopes.js';
import type { LegacyCoverageEdge } from '../../infrastructure/graph/legacy-narrative-input.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeStatedLinkVersions,
  evidenceLinkId,
  lastLinkVersionForOperation,
  prepareMaterializedLinkVersion,
  prepareRetirementVersion,
} from '../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { commitSourceIncidence } from '../../infrastructure/sqlite/source-incidence.js';
import { hashContent } from '../domain/content.js';

export type LegacyCoverageWrite = {
  readonly sourceIds: readonly string[];
  readonly nodeId: string;
  readonly create: boolean;
  readonly closed: readonly LegacyCoverageEdge[];
  readonly observedAt: string;
  readonly occurredAt: string;
};

/** The graph receives this identity before creation, so recovery cannot invent a different edge. */
export function legacyCoverageEdgeId(sourceId: string, nodeId: string): string {
  return hashContent(['legacy-coverage', sourceId, nodeId]);
}

type CoverageRecord = {
  readonly sourceId: string;
  readonly narrativeId: string;
  readonly relationId: string;
  readonly clocks: Readonly<Record<string, string>>;
  readonly closed: boolean;
  readonly linkId: string;
};

function linksOf(input: LegacyCoverageWrite): readonly CoverageRecord[] {
  return [
    ...(input.create
      ? input.sourceIds.map((sourceId) => ({
          sourceId,
          narrativeId: input.nodeId,
          relationId: legacyCoverageEdgeId(sourceId, input.nodeId),
          clocks: { tx_from: input.observedAt },
          closed: false,
        }))
      : []),
    ...input.closed.map((edge) => ({ ...edge, closed: true })),
  ].map((edge) => ({
    ...edge,
    linkId: evidenceLinkId('source_coverage', 'retained_node', edge.sourceId, edge.narrativeId),
  }));
}

export function legacyCoverageScopes(input: LegacyCoverageWrite) {
  const node = nodeScopeDirection('source_coverage');
  const source = node === 'in' ? 'out' : 'in';
  const scopes = new Map<string, { endpointId: string; relationClass: string }>();
  for (const link of linksOf(input)) {
    for (const entry of [
      { endpointId: link.sourceId, relationClass: durableRoleScope('source_coverage', source) },
      { endpointId: link.narrativeId, relationClass: durableRoleScope('source_coverage', node) },
    ]) {
      scopes.set(`${entry.endpointId}\n${entry.relationClass}`, entry);
    }
  }
  return [...scopes.values()];
}

/** Records positive coverage and its closures in the same durable intent as the graph mutation. */
export function prepareLegacyCoverage(
  db: SqliteHandle,
  input: LegacyCoverageWrite,
  operationId: string,
): void {
  for (const link of linksOf(input)) {
    prepareMaterializedLinkVersion(db, {
      linkId: link.linkId,
      kind: 'source_coverage',
      qualifier: 'retained_node',
      fromId: link.sourceId,
      toId: link.narrativeId,
      originalRelId: link.relationId,
      operationId,
      operationKey: `legacy-coverage:${operationId}:${link.linkId}:open`,
      recordSource: 'legacy_narrative',
      recordedValues: {
        currency: link.clocks.tx_until === undefined ? 'open' : 'closed',
        relation_type: 'SUMMARIZED_BY',
        ...link.clocks,
      },
      temporalProof: { basis: 'recorded_graph_clocks', ...link.clocks },
      observedAt: new Date(input.observedAt),
    });
    if (link.closed) {
      prepareRetirementVersion(db, {
        linkId: link.linkId,
        operationId,
        operationKey: `legacy-coverage:${operationId}:${link.linkId}:close`,
        recordedValues: {
          currency: 'closed',
          ...link.clocks,
          valid_until: input.occurredAt,
          tx_until: link.clocks.tx_until ?? input.observedAt,
        },
        temporalProof: {
          basis: 'recorded_graph_clocks',
          ...link.clocks,
          valid_until: input.occurredAt,
          tx_until: link.clocks.tx_until ?? input.observedAt,
        },
        observedAt: new Date(input.observedAt),
      });
    }
  }
  for (const scope of legacyCoverageScopes(input)) {
    prepareScopeAdvance(db, { ...scope, operationId, updatedAt: new Date(input.observedAt) });
  }
}

export function acknowledgeLegacyCoverage(
  db: SqliteHandle,
  input: LegacyCoverageWrite,
  operationId: string,
  knownFrom: string,
  observedAckAt: string,
): void {
  acknowledgeStatedLinkVersions(db, operationId, knownFrom, observedAckAt);
  for (const link of linksOf(input)) {
    const version = lastLinkVersionForOperation(db, link.linkId, operationId);
    if (version !== undefined) {
      commitSourceIncidence(db, {
        sourceId: link.sourceId,
        nodeId: link.narrativeId,
        role: 'source_coverage',
        linkId: link.linkId,
        linkVersion: version,
        currency: link.closed ? 'closed' : 'open',
        clocks: {
          ...link.clocks,
          ...(link.closed
            ? { valid_until: input.occurredAt, tx_until: link.clocks.tx_until ?? input.observedAt }
            : {}),
        },
      });
    }
  }
  for (const scope of legacyCoverageScopes(input)) {
    acknowledgeScopeAdvance(db, {
      ...scope,
      operationId,
      updatedAt: new Date(knownFrom),
      ...(input.create && scope.endpointId === input.nodeId
        ? {
            censusStatus: 'established' as const,
            coverageJson: JSON.stringify({
              basis: 'new_narrative',
              sources: input.sourceIds,
              operationId,
            }),
          }
        : {}),
    });
  }
}

export function discardLegacyCoverage(
  db: SqliteHandle,
  input: LegacyCoverageWrite,
  operationId: string,
): void {
  for (const scope of legacyCoverageScopes(input)) {
    rejectScopeAdvance(db, { ...scope, operationId, updatedAt: new Date(input.observedAt) });
  }
}
