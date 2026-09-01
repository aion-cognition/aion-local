import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import {
  ENTITY_ALIASES_PROPERTY,
  MERGE_PROVENANCE_PROPERTY,
} from '../../../infrastructure/graph/entity-dedup-queries.js';
import {
  ENTITY_MENTION_TYPE,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  ENTITY_TYPE_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
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

export class DedupFakeGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (cypher.includes(`OPTIONAL MATCH (:Episode)-[m:${ENTITY_MENTION_TYPE}]->(n)`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#dedupDetails(parameters));
    }
    if (cypher.includes('vector.similarity.cosine')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#similarEntities(parameters));
    }
    if (cypher.includes(`coalesce(n.${MERGE_PROVENANCE_PROPERTY}, [])`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#mergeProvenance(parameters));
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

  #dedupDetails(parameters: Record<string, unknown>): Row[] {
    const ids = (parameters.ids ?? []) as readonly string[];
    return ids
      .map((id) => this.nodes.get(id))
      .filter((node): node is FakeNode => node !== undefined)
      .map((node) => {
        const mentionCount = this.edgesOfType(ENTITY_MENTION_TYPE)
          .filter((edge) => edge.targetId === node.id)
          .reduce((total, edge) => total + edge.count, 0);
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
