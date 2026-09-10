import type { Driver } from 'neo4j-driver';

import { readRelationScope } from '../../evidence/application/dependencies.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import { loadMemberSourceNodes } from '../../infrastructure/graph/narrative-queries.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { ChunkEnrichmentNode } from '../domain/chunk-render.js';

/**
 * The extracted nodes a chunk's remaining allowance may buy, and the fence they arrive under.
 *
 * Enrichment is optional, which decides whether it may be OMITTED. It does not decide whether it
 * may be submitted unfenced: once a node's text is in the prompt, or its id is cited, the revision
 * rests on it exactly as it rests on a member's raw passage, and F12 D9 asks for every read the
 * answer stood on. A node whose state nobody can certify is therefore left out rather than sent.
 *
 * Nomination happens over the SUBMITTED MEMBERSHIP first and the bound is applied to that. A
 * session-wide read bounded across every episode a session ever held will spend its whole limit on
 * older members and hand back nothing for the chunk being narrated.
 */

/** Extracted nodes one chunk's revision may consider. Applied after the membership restriction. */
export const CHUNK_ENRICHMENT_LIMIT = 32;

export type ChunkEnrichment = {
  readonly nodes: readonly ChunkEnrichmentNode[];
  readonly dependencies: readonly EvidenceDependency[];
  /** Nodes the read found and could not certify, named rather than quietly dropped. */
  readonly uncertified: readonly string[];
};

export type EnrichmentDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
};

/**
 * What proves an enrichment node is the one that was read: its own retained state, and the
 * extraction population it was drawn from.
 *
 * Both or neither. A node bound on its state alone goes on standing after the extraction set it
 * belongs to changes, and a node bound on the extraction scope alone goes on standing after its
 * own text is rewritten — which is the case this fence exists for.
 */
function nodeDependencies(
  db: SqliteHandle,
  nodeId: string,
): readonly EvidenceDependency[] | undefined {
  const state = readRelationScope(db, {
    kind: 'node',
    endpointId: nodeId,
    scope: GRAPH_NODE_SCOPE,
    empty: false,
  });
  const extraction = readRelationScope(db, {
    kind: 'relation_scope',
    endpointId: nodeId,
    scope: durableRoleScope('extraction', 'out'),
    empty: false,
  });
  return state.status === 'verified' && extraction.status === 'verified'
    ? [state.dependency, extraction.dependency]
    : undefined;
}

export async function resolveChunkEnrichment(
  deps: EnrichmentDeps,
  memberIds: readonly string[],
  now: Date,
  limit: number = CHUNK_ENRICHMENT_LIMIT,
): Promise<ChunkEnrichment> {
  const candidates = await loadMemberSourceNodes(deps.driver, memberIds, limit, now);
  const nodes: ChunkEnrichmentNode[] = [];
  const dependencies: EvidenceDependency[] = [];
  const uncertified: string[] = [];
  for (const candidate of candidates) {
    const fence = nodeDependencies(deps.db, candidate.id);
    if (fence === undefined) {
      uncertified.push(candidate.id);
      continue;
    }
    nodes.push({
      id: candidate.id,
      kind: candidate.kind,
      text: candidate.text,
      sourceId: candidate.episodeId,
    });
    dependencies.push(...fence);
  }
  return { nodes, dependencies, uncertified };
}
