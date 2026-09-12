import type { Driver } from 'neo4j-driver';

import { readRelationScope } from '../../evidence/application/dependencies.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import { loadMemberSourceNodes } from '../../infrastructure/graph/narrative-queries.js';
import { canonicalJson } from '../../infrastructure/publication/json.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import { committedIncidenceForSource } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { ChunkEnrichmentNode } from '../domain/chunk-render.js';

/**
 * The extracted nodes a chunk's remaining allowance may buy, and the fence they arrive under.
 *
 * Enrichment is optional, which decides whether it may be OMITTED. It does not decide whether it
 * may be submitted unfenced: once a node's text is in the prompt, or its id is cited, the revision
 * rests on it exactly as it rests on a member's raw passage, and the revision has to name every
 * read it stood on. A node whose state nobody can certify is left out rather than sent.
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

/** Whether two readings of one node's fence are the same reading. */
function sameFence(
  before: readonly EvidenceDependency[],
  after: readonly EvidenceDependency[] | undefined,
): boolean {
  if (before.length !== after?.length) {
    return false;
  }
  return before.every(
    (dependency, index) => canonicalJson(dependency) === canonicalJson(after[index]),
  );
}

/**
 * How much of the members' recorded extraction population may be fenced before nomination.
 *
 * Twice the nomination's own bound, walked in the same member order and by node id within a
 * member, so the fences cover everything that read can return: a node the graph offers without a
 * committed incidence spends a nomination slot and no fence slot, never the other way round. The
 * headroom is what absorbs the reverse case, a recorded node the graph no longer projects.
 */
export const ENRICHMENT_FENCE_CEILING = CHUNK_ENRICHMENT_LIMIT * 2;

/**
 * The fences, taken over the extraction population the records already name.
 *
 * This runs BEFORE the nominating query rather than after it, which is the whole point. The
 * nominating query returns text, so a fence read afterwards was acquired after the read it claims
 * to prove, and a token acquired after a read proves nothing about that read.
 */
function openFences(
  db: SqliteHandle,
  memberIds: readonly string[],
  limit: number,
): Map<string, readonly EvidenceDependency[]> {
  const fences = new Map<string, readonly EvidenceDependency[]>();
  for (const memberId of memberIds) {
    if (fences.size >= ENRICHMENT_FENCE_CEILING) {
      break;
    }
    for (const row of committedIncidenceForSource(db, memberId, { role: 'extraction', limit })) {
      const fence = nodeDependencies(db, row.nodeId);
      if (fence !== undefined && !fences.has(row.nodeId)) {
        fences.set(row.nodeId, fence);
      }
      if (fences.size >= ENRICHMENT_FENCE_CEILING) {
        break;
      }
    }
  }
  return fences;
}

/**
 * The enrichment one chunk's revision may submit, and the fences that prove it was read whole.
 *
 * The interval opens on the records, closes on the records, and the nominating read sits inside
 * it. Nomination stays bounded over the submitted membership, which is what keeps a session-wide
 * limit from spending itself on older episodes; what changed is that its text is now admitted only
 * where the node's state and extraction population read the same at both ends of the interval it
 * was read in. A node that moved across the interval is omitted, which is the fallback an optional
 * input is allowed, and named so the omission is visible.
 */
export async function resolveChunkEnrichment(
  deps: EnrichmentDeps,
  memberIds: readonly string[],
  now: Date,
  limit: number = CHUNK_ENRICHMENT_LIMIT,
): Promise<ChunkEnrichment> {
  const opening = openFences(deps.db, memberIds, limit);
  const nominated = await loadMemberSourceNodes(deps.driver, memberIds, limit, now);
  const nodes: ChunkEnrichmentNode[] = [];
  const dependencies: EvidenceDependency[] = [];
  const uncertified: string[] = [];
  const read = new Set<string>();
  for (const candidate of nominated) {
    // The default read mode is currency-aware rather than currency-filtered, so one node can come
    // back as more than one reading. Its fence covers the node, not a reading of it, and picking
    // one of several under a single token would be the certification this fence exists to refuse.
    if (read.has(candidate.id)) {
      continue;
    }
    read.add(candidate.id);
    const before = opening.get(candidate.id);
    if (before === undefined || !sameFence(before, nodeDependencies(deps.db, candidate.id))) {
      uncertified.push(candidate.id);
      continue;
    }
    nodes.push({
      id: candidate.id,
      kind: candidate.kind,
      text: candidate.text,
      sourceId: candidate.episodeId,
    });
    dependencies.push(...before);
  }
  return { nodes, dependencies, uncertified };
}
