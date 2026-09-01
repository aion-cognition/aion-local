import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import {
  ENTITY_ALIASES_PROPERTY,
  MERGE_PROVENANCE_PROPERTY,
} from '../../../infrastructure/graph/entity-dedup-queries.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_MENTION_TYPE,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  ENTITY_PARTICIPATION_TYPE,
  ENTITY_TYPE_COUNTS_PROPERTY,
  ENTITY_TYPE_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { PROTECTED_RELATIONSHIP_TYPES } from '../../../infrastructure/graph/protected-relationships.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  LAST_ACCESSED_PROPERTY,
  STRUCTURAL_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import { FakeGraph, type FakeNode } from '../../test-support/fake-graph.fixture.js';

/**
 * The dedup stage's own statements on top of the shared `FakeGraph`: mention-count
 * hydration, the name-vector similarity search, and the merged-node edge enumeration. Node
 * merges, edge upserts, and node locks are already modeled by the base fake. Vector cosine
 * math is plain JS here; the real function is proven against a live server in
 * `entity-dedup.int.test.ts`.
 */

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** The backbone plus both mention directions, which the neighbourhood signal excludes. */
const NON_NEIGHBOUR_TYPES = new Set<string>([
  ...PROTECTED_RELATIONSHIP_TYPES,
  ENTITY_MENTION_TYPE,
  ENTITY_PARTICIPATION_TYPE,
]);

export class DedupFakeGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (cypher.includes(`OPTIONAL MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(n)`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#dedupDetails(parameters));
    }
    if (cypher.includes('SHOW PROCEDURES')) {
      this.statements.push({ cypher, parameters });
      // No graph data science plugin behind the fake, so the bulk nominator declares itself
      // unavailable and the unit suite exercises the vector nominator. The GDS arm is proven
      // against a real server in `entity-nomination-queries.int.test.ts`.
      return toResult([{ count: 0 }]);
    }
    if (cypher.includes(`WITH n.${ENTITY_NAME_SQUASH_PROPERTY} AS squash`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#squashGroups(parameters));
    }
    if (cypher.includes(`UNWIND holder.${ENTITY_ALIASES_NORM_PROPERTY} AS aliasKey`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#aliasPairs(parameters));
    }
    if (cypher.includes('UNWIND range(0, size($pairs) - 1) AS ordinal')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#pairSignals(parameters));
    }
    if (cypher.includes('vector.similarity.cosine')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#similarEntities(parameters));
    }
    if (cypher.includes(`coalesce(n.${MERGE_PROVENANCE_PROPERTY}, [])`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#mergeProvenance(parameters));
    }
    if (cypher.includes('UNWIND $ids AS wanted')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#sidesWithoutCurrency(parameters));
    }
    if (cypher.includes('UNWIND $mergedIds AS mergedId') && cypher.includes('startNode(r).id')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#mergedNodeEdges(parameters));
    }
    if (cypher.includes(`SET n.${ENTITY_NAME_VECTOR_PROPERTY} = null`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#clearVectors(parameters));
    }
    if (cypher.includes(`SET n.${ENTITY_NAME_VECTOR_HASH_PROPERTY} = null`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#clearNameVectorHash(parameters));
    }
    if (cypher.includes(`SET old.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#closeSupersededNode(parameters));
    }
    return super.executeQuery(cypher, parameters);
  }

  entities(): FakeNode[] {
    return this.nodesWithLabel('Entity');
  }

  /** Current nodes only, matching the currency predicate every cascade read carries. */
  #currentEntities(): FakeNode[] {
    return this.entities().filter(
      (node) =>
        node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined &&
        node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined,
    );
  }

  /** Distinct current episodes mentioning the entity, which is what the real query counts. */
  #mentioningEpisodes(entityId: string): string[] {
    const episodes = this.edgesOfType(ENTITY_MENTION_TYPE)
      .filter((edge) => edge.targetId === entityId)
      .map((edge) => edge.sourceId)
      .filter((episodeId) => {
        const episode = this.nodes.get(episodeId);
        return (
          episode !== undefined &&
          episode.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined &&
          episode.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined
        );
      });
    return [...new Set(episodes)].sort();
  }

  /** The merge transaction's post-lock currency read: ids that are missing or closed. */
  #sidesWithoutCurrency(parameters: Record<string, unknown>): Row[] {
    const wanted = [...new Set((parameters.ids as string[] | undefined) ?? [])];
    return wanted
      .filter((id) => {
        const node = this.nodes.get(id);
        return (
          node === undefined ||
          node.properties[BITEMPORAL_PROPERTIES.validUntil] !== undefined ||
          node.properties[BITEMPORAL_PROPERTIES.forgottenAt] !== undefined
        );
      })
      .sort()
      .map((id) => ({ id }));
  }

  #squashGroups(parameters: Record<string, unknown>): Row[] {
    const subjectIds = parameters.subjectIds as string[] | null;
    const grouped = new Map<string, string[]>();
    for (const node of this.#currentEntities()) {
      const squash = node.properties[ENTITY_NAME_SQUASH_PROPERTY];
      if (typeof squash !== 'string' || squash.length === 0) {
        continue;
      }
      grouped.set(squash, [...(grouped.get(squash) ?? []), node.id]);
    }
    return [...grouped.entries()]
      .filter(([, ids]) => ids.length > 1)
      .filter(([, ids]) => subjectIds === null || ids.some((id) => subjectIds.includes(id)))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([squash, ids]) => ({ squash, ids: [...ids].sort() }));
  }

  #aliasPairs(parameters: Record<string, unknown>): Row[] {
    const subjectIds = parameters.subjectIds as string[] | null;
    const current = this.#currentEntities();
    const holders = new Map<string, string[]>();
    for (const node of current) {
      for (const key of (node.properties[ENTITY_ALIASES_NORM_PROPERTY] ?? []) as string[]) {
        holders.set(key, [...(holders.get(key) ?? []), node.id]);
      }
    }

    const rows: Row[] = [];
    for (const [aliasKey, holderIds] of holders) {
      const holderId = holderIds[0];
      if (holderIds.length !== 1 || holderId === undefined) {
        continue;
      }
      const owner = current.find(
        (node) => node.properties[ENTITY_NAME_NORM_PROPERTY] === aliasKey && node.id !== holderId,
      );
      if (owner === undefined) {
        continue;
      }
      if (subjectIds !== null && !subjectIds.includes(holderId) && !subjectIds.includes(owner.id)) {
        continue;
      }
      rows.push({ holder_id: holderId, owner_id: owner.id, alias_key: aliasKey });
    }
    return rows.sort((left, right) =>
      `${String(left.alias_key)}${String(left.holder_id)}`.localeCompare(
        `${String(right.alias_key)}${String(right.holder_id)}`,
      ),
    );
  }

  /**
   * The provenance and neighbourhood overlaps, over the same disjoint edge sets the real read
   * uses. The temporal gap is never modeled: unit seeds carry no `occurred_at`, and reporting a
   * zero for a distance nobody measured is the one thing the signal shape forbids.
   */
  #pairSignals(parameters: Record<string, unknown>): Row[] {
    const pairs = (parameters.pairs ?? []) as { left: string; right: string }[];
    const current = new Set(this.#currentEntities().map((node) => node.id));
    return pairs
      .filter((pair) => current.has(pair.left) && current.has(pair.right))
      .map((pair) => {
        const leftEpisodes = this.#mentioningEpisodes(pair.left);
        const rightEpisodes = this.#mentioningEpisodes(pair.right);
        const sharedEpisodes = leftEpisodes.filter((id) => rightEpisodes.includes(id));
        const leftNeighbours = this.#neighbours(pair.left);
        const rightNeighbours = this.#neighbours(pair.right);
        const sharedNeighbours = leftNeighbours.filter((id) => rightNeighbours.includes(id));
        const episodeUnion = leftEpisodes.length + rightEpisodes.length - sharedEpisodes.length;
        const neighbourUnion =
          leftNeighbours.length + rightNeighbours.length - sharedNeighbours.length;
        return {
          left_id: pair.left,
          right_id: pair.right,
          shared_episode_ids: sharedEpisodes,
          shared_episode_count: sharedEpisodes.length,
          shared_episode_jaccard: episodeUnion === 0 ? 0 : sharedEpisodes.length / episodeUnion,
          neighbour_overlap_count: sharedNeighbours.length,
          neighbour_overlap_jaccard:
            neighbourUnion === 0 ? 0 : sharedNeighbours.length / neighbourUnion,
          gap_seconds: null,
          left_episode_count: leftEpisodes.length,
          right_episode_count: rightEpisodes.length,
        };
      });
  }

  /** One hop, excluding the backbone and both mention directions, as the real predicate does. */
  #neighbours(entityId: string): string[] {
    const found = new Set<string>();
    for (const edge of this.edges.values()) {
      if (NON_NEIGHBOUR_TYPES.has(edge.type)) {
        continue;
      }
      if (edge.sourceId === entityId && edge.targetId !== entityId) {
        found.add(edge.targetId);
      }
      if (edge.targetId === entityId && edge.sourceId !== entityId) {
        found.add(edge.sourceId);
      }
    }
    return [...found].sort();
  }

  #dedupDetails(parameters: Record<string, unknown>): Row[] {
    const ids = (parameters.ids ?? []) as readonly string[];
    return ids
      .map((id) => this.nodes.get(id))
      .filter((node): node is FakeNode => node !== undefined)
      .map((node) => {
        const mentionCount = this.#mentioningEpisodes(node.id).length;
        return {
          id: node.id,
          name: node.properties[ENTITY_NAME_PROPERTY],
          name_norm: node.properties[ENTITY_NAME_NORM_PROPERTY],
          type: node.properties[ENTITY_TYPE_PROPERTY],
          is_structural: node.properties[STRUCTURAL_PROPERTY] === true,
          name_vec: node.properties[ENTITY_NAME_VECTOR_PROPERTY] ?? null,
          current: node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined,
          tx_from: node.properties[BITEMPORAL_PROPERTIES.txFrom] ?? null,
          aliases: node.properties[ENTITY_ALIASES_PROPERTY] ?? [],
          access_count: node.properties[ACCESS_COUNT_PROPERTY] ?? 0,
          last_accessed: node.properties[LAST_ACCESSED_PROPERTY] ?? null,
          type_counts: node.properties[ENTITY_TYPE_COUNTS_PROPERTY] ?? '{}',
          description: node.properties[MEMORY_PROPERTIES.text] ?? '',
          mentionCount,
        };
      });
  }

  #similarEntities(parameters: Record<string, unknown>): Row[] {
    const excludeId = parameters.excludeId as string;
    const vector = parameters.vector as number[];
    const threshold = parameters.threshold as number;
    const rawLimit = parameters.limit as { toNumber?: () => number } | number;
    const limit = typeof rawLimit === 'number' ? rawLimit : (rawLimit.toNumber?.() ?? 0);

    const scored = this.entities()
      .filter((node) => node.id !== excludeId)
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined)
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined)
      .filter((node) => Array.isArray(node.properties[ENTITY_NAME_VECTOR_PROPERTY]))
      .map((node) => ({
        id: node.id,
        type: node.properties[ENTITY_TYPE_PROPERTY],
        score: cosine(vector, node.properties[ENTITY_NAME_VECTOR_PROPERTY] as number[]),
      }))
      .filter((row) => row.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  #mergeProvenance(parameters: Record<string, unknown>): Row[] {
    const node = this.nodes.get(parameters.id as string);
    return [{ records: node?.properties[MERGE_PROVENANCE_PROPERTY] ?? [] }];
  }

  #mergedNodeEdges(parameters: Record<string, unknown>): Row[] {
    const mergedIds = new Set((parameters.mergedIds ?? []) as readonly string[]);
    const rows: Row[] = [];
    for (const edge of this.edges.values()) {
      const sourceIsMerged = mergedIds.has(edge.sourceId);
      const targetIsMerged = mergedIds.has(edge.targetId);
      if (!sourceIsMerged && !targetIsMerged) {
        continue;
      }
      if (sourceIsMerged) {
        const otherId = edge.targetId;
        if (otherId !== edge.sourceId) {
          rows.push(this.#edgeRow(edge.sourceId, edge, 'out', otherId));
        }
      }
      if (targetIsMerged && edge.targetId !== edge.sourceId) {
        rows.push(this.#edgeRow(edge.targetId, edge, 'in', edge.sourceId));
      }
    }
    return rows;
  }

  #edgeRow(
    mergedId: string,
    edge: ReturnType<FakeGraph['edgesOfType']>[number],
    direction: 'out' | 'in',
    otherId: string,
  ): Row {
    return {
      mergedId,
      edgeId: edge.id,
      type: edge.type,
      direction,
      otherId,
      strength: edge.strength,
      confidence: edge.confidence,
      signals: edge.signals,
      provenance: edge.provenance,
      count: edge.count,
      rationale: null,
    };
  }

  #clearVectors(parameters: Record<string, unknown>): Row[] {
    const ids = (parameters.ids ?? []) as readonly string[];
    const written: Row[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node === undefined) {
        continue;
      }
      Reflect.deleteProperty(node.properties, ENTITY_NAME_VECTOR_PROPERTY);
      Reflect.deleteProperty(node.properties, MEMORY_PROPERTIES.contentVector);
      written.push({ id });
    }
    return written;
  }

  /** The vector stays; only the hash goes, which is how the next resolution sees it as stale. */
  #clearNameVectorHash(parameters: Record<string, unknown>): Row[] {
    const node = this.nodes.get(parameters.id as string);
    if (node === undefined) {
      return [];
    }
    Reflect.deleteProperty(node.properties, ENTITY_NAME_VECTOR_HASH_PROPERTY);
    return [{ id: node.id }];
  }

  #closeSupersededNode(parameters: Record<string, unknown>): Row[] {
    const id = parameters.oldId as string;
    const node = this.nodes.get(id);
    if (node === undefined) {
      return [];
    }
    if (node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined) {
      node.properties[BITEMPORAL_PROPERTIES.validUntil] = parameters.now;
    }
    if (node.properties[BITEMPORAL_PROPERTIES.txUntil] === undefined) {
      node.properties[BITEMPORAL_PROPERTIES.txUntil] = parameters.now;
    }
    return [
      {
        id,
        validUntil: node.properties[BITEMPORAL_PROPERTIES.validUntil],
        txUntil: node.properties[BITEMPORAL_PROPERTIES.txUntil],
      },
    ];
  }
}

type Counters = {
  readonly nodesCreated: number;
  readonly relationshipsCreated: number;
  readonly propertiesSet: number;
};

const NO_CHANGES: Counters = { nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 };

function toResult(rows: readonly Row[], counters: Counters = NO_CHANGES): unknown {
  return {
    records: rows.map((row) => ({ toObject: () => row })),
    summary: { counters: { updates: () => counters } },
  };
}
