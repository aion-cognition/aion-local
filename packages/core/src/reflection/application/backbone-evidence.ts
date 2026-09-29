import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { owesBirthEstablishment } from './derived-node-evidence.js';
import {
  acknowledgeMintedNodeState,
  discardMintedNodeState,
  nodeStateScope,
  prepareMintedNodeState,
} from '../../evidence/application/node-state.js';
import { NODE_SUPPORT_ROLE_SCOPES } from '../../evidence/application/node-support.js';
import {
  BACKBONE_EXTRACTION_METHOD,
  readBackboneBirthIds,
  readBackboneBirthIdsInTransaction,
} from '../../infrastructure/graph/backbone.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
  type ScopeKey,
} from '../../infrastructure/sqlite/evidence-scope.js';

/**
 * The census the Member, the Workspace and the Substrate are born with.
 *
 * An entity judgment reads a node's own state and every role its sources arrive through, and
 * withholds a pair whose counters nobody established. An extracted entity is counted by the stage
 * that mints it. The backbone is minted by the bootstrap, which runs before any coordinator exists,
 * so nothing counted it: every later mention moved its counters without establishing them, and
 * every pair naming a backbone identity was withheld for good.
 *
 * The claim is the one a minted entity makes, for the same reason. The bootstrap drew the id, so
 * no record could name it before, and every writer since advances these counters as it records an
 * incidence. It is made only for an identity carrying the bootstrap's creation mark, the node's own
 * record that this bootstrap drew it; a backbone node an older build minted keeps what it has.
 */

export const BACKBONE_BIRTH_EFFECTS = {
  census: 'backbone_birth_census',
} as const;

const Payload = z.strictObject({
  observedAt: z.string().min(1),
  /** The backbone identities whose census is owed, as the caller found them. */
  nodeIds: z.array(z.string().min(1)).min(1),
});

const Result = z.strictObject({
  established: z.number().int().nonnegative(),
});

type BackboneBirthData = z.infer<typeof Payload>;

/**
 * Every support counter a birth establishes: the whole set, as a minted entity takes it, because
 * a reader that finds one role uncounted answers unknown however many others are. The node's own
 * state counter is graph-authority and takes a mirror, so it goes through its own pair of calls.
 */
function supportScopes(data: BackboneBirthData): readonly ScopeKey[] {
  return data.nodeIds.flatMap((endpointId) =>
    NODE_SUPPORT_ROLE_SCOPES.map((relationClass) => ({ endpointId, relationClass })),
  );
}

export const backboneBirthPublication = new PublicationOperation({
  kind: 'backbone_birth',
  effectKinds: [BACKBONE_BIRTH_EFFECTS.census],
  payload: Payload,
  data: Payload,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('backbone birth evidence cannot publish before the coverage registry exists');
    }
    return Promise.resolve({
      data: payload,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: [
        ...supportScopes(payload).map((scope) => ({
          kind: 'relation_scope' as const,
          id: scope.endpointId,
          scope: scope.relationClass,
        })),
        ...payload.nodeIds.map((nodeId) => ({
          kind: 'relation_scope' as const,
          id: nodeId,
          scope: nodeStateScope(nodeId).relationClass,
        })),
      ],
      effects: [{ kind: BACKBONE_BIRTH_EFFECTS.census, detail: { nodes: payload.nodeIds.length } }],
    });
  },
  async check(context, data) {
    // Read under the guard, in both stores. An id the bootstrap did not mark is not this write's to
    // count, and one already counted refuses rather than claiming the same population twice.
    const births = new Set(await readBackboneBirthIdsInTransaction(context.graph));
    if (!data.nodeIds.every((nodeId) => births.has(nodeId))) {
      return { status: 'rejected', reason: 'not_a_backbone_birth' };
    }
    if (!data.nodeIds.every((nodeId) => owesBirthEstablishment(context.db, nodeId))) {
      return { status: 'rejected', reason: 'birth_census_established' };
    }
    return { status: 'valid' };
  },
  applyGraph(_context, data) {
    // Nothing is written to the graph. The bootstrap wrote the identities; this records what
    // their birth entitles them to, under the guard that fences the counters it moves.
    return Promise.resolve({ established: data.nodeIds.length });
  },
  prepareSqlite(context, data) {
    const observedAt = new Date(data.observedAt);
    for (const scope of supportScopes(data)) {
      prepareScopeAdvance(context.db, {
        ...scope,
        operationId: context.operationId,
        updatedAt: observedAt,
      });
    }
    for (const nodeId of data.nodeIds) {
      prepareMintedNodeState(context.db, nodeId, context.operationId, observedAt);
    }
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    for (const scope of supportScopes(data)) {
      acknowledgeScopeAdvance(context.db, {
        ...scope,
        operationId: context.operationId,
        updatedAt: new Date(context.knownFrom),
        censusStatus: 'established',
        coverageJson: JSON.stringify({
          basis: 'minted_identity',
          endpointId: scope.endpointId,
          scope: scope.relationClass,
          mintedBy: BACKBONE_EXTRACTION_METHOD,
          knownFrom: context.knownFrom,
        }),
      });
    }
    for (const nodeId of data.nodeIds) {
      acknowledgeMintedNodeState(context.db, nodeId, context.operationId, context.knownFrom);
    }
    return undefined;
  },
  discardSqlite(context, data) {
    const observedAt = new Date(data.observedAt);
    for (const scope of supportScopes(data)) {
      rejectScopeAdvance(context.db, {
        ...scope,
        operationId: context.operationId,
        updatedAt: observedAt,
      });
    }
    for (const nodeId of data.nodeIds) {
      discardMintedNodeState(context.db, nodeId, context.operationId, observedAt);
    }
    return undefined;
  },
});

export type BackboneBirthOutcome =
  | { readonly status: 'nothing_owed' }
  | { readonly status: 'published'; readonly operationId: string; readonly established: number }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Counts every backbone identity the bootstrap minted that nobody has counted yet.
 *
 * Called where a coordinator first stands and before anything reflects: the service start. A
 * restart finds nothing owed and publishes nothing. A refused or interrupted attempt leaves the
 * obligation in both stores, so the next start finds it again.
 */
export async function publishBackboneBirth(deps: {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly publications: Pick<PublicationCoordinator, 'publish'>;
  readonly now?: Date;
}): Promise<BackboneBirthOutcome> {
  const owed = (await readBackboneBirthIds(deps.driver)).filter((nodeId) =>
    owesBirthEstablishment(deps.db, nodeId),
  );
  if (owed.length === 0) {
    return { status: 'nothing_owed' };
  }
  const operationId = randomUUID();
  const outcome = await deps.publications.publish({
    kind: backboneBirthPublication.kind,
    operationId,
    payload: { observedAt: (deps.now ?? new Date()).toISOString(), nodeIds: owed },
  });
  if (outcome.status !== 'acknowledged') {
    return { status: 'refused', reason: outcome.reason };
  }
  return {
    status: 'published',
    operationId,
    established: backboneBirthPublication.decodeResult(outcome.result).established,
  };
}
