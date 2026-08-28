import neo4j, { type Driver } from 'neo4j-driver';
import type { Vector } from '../providers/types.js';
import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { BITEMPORAL_PROPERTIES, writeStampedNodeInTransaction } from './bitemporal.js';
import { type GraphTransaction, inWriteTransaction, runRead, runWrite } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { ENTITY_MENTION_TYPE, ENTITY_TYPE_PROPERTY } from './entity-queries.js';
import { BASE_NODE_LABEL } from './labels.js';
import { lockNodeInTransaction } from './locks.js';
import { isRelationshipType } from './relationships.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  LAST_ACCESSED_PROPERTY,
  STRUCTURAL_PROPERTY,
} from './seed-queries.js';
import { fromGraphVector, toGraphVector, type Row } from './values.js';

/**
 * Whitepaper §6.5: the graph side of entity deduplication. Everything that decides who is
 * canonical lives in `reflection/domain/entity-merge.ts`; this module only reads the
 * candidates a similarity search needs and writes the merge once the stage has decided one.
 */

const ENTITY_LABEL = 'Entity';

/** The property the merged names land in. Read back by `aion why` (P5) as the identity's history. */
export const ENTITY_ALIASES_PROPERTY = 'aliases';

/** Procedure arguments and `LIMIT` are Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

export type DedupEntityDetail = {
  readonly id: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly type: string;
  readonly isStructural: boolean;
  /** Absent when the vector has not been embedded yet; such a node cannot be a search subject. */
  readonly nameVector?: Vector;
  /** `valid_until IS NULL`. A subject or candidate that already lost currency has already been merged. */
  readonly current: boolean;
  readonly txFrom?: Date;
  readonly aliases: readonly string[];
  readonly accessCount: number;
  readonly lastAccessed?: Date;
  /** Sum of incoming `MENTIONS.count`, independent of `access_count` (which recall also bumps). */
  readonly mentionCount: number;
};

const LOAD_ENTITY_DEDUP_DETAILS = [
  'UNWIND $ids AS wantedId',
  `MATCH (n:${ENTITY_LABEL} { id: wantedId })`,
  `OPTIONAL MATCH (:Episode)-[m:${ENTITY_MENTION_TYPE}]->(n)`,
  'WITH n, coalesce(sum(m.count), 0) AS mentionCount',
  `RETURN n.id AS id, n.${ENTITY_NAME_PROPERTY} AS name, n.${ENTITY_NAME_NORM_PROPERTY} AS name_norm,`,
  `       n.${ENTITY_TYPE_PROPERTY} AS type, coalesce(n.${STRUCTURAL_PROPERTY}, false) AS is_structural,`,
  `       n.${ENTITY_NAME_VECTOR_PROPERTY} AS name_vec,`,
  `       n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AS current,`,
  `       n.${BITEMPORAL_PROPERTIES.txFrom} AS tx_from,`,
  `       coalesce(n.${ENTITY_ALIASES_PROPERTY}, []) AS aliases,`,
  `       coalesce(n.${ACCESS_COUNT_PROPERTY}, 0) AS access_count,`,
  `       n.${LAST_ACCESSED_PROPERTY} AS last_accessed,`,
  '       mentionCount',
].join('\n');

function mapDedupEntityDetail(row: Row): DedupEntityDetail {
  const nameVector = fromGraphVector(row.name_vec);
  const txFrom = row.tx_from;
  const lastAccessed = row.last_accessed;
  return {
    id: row.id as string,
    name: String(row.name ?? ''),
    nameNorm: String(row.name_norm ?? ''),
    type: String(row.type ?? ''),
    isStructural: row.is_structural === true,
    ...(nameVector === undefined ? {} : { nameVector }),
    current: row.current === true,
    ...(txFrom instanceof Date ? { txFrom } : {}),
    aliases: (row.aliases as string[] | null) ?? [],
    accessCount: (row.access_count as number | null) ?? 0,
    ...(lastAccessed instanceof Date ? { lastAccessed } : {}),
    mentionCount: (row.mentionCount as number | null) ?? 0,
  };
}

/** Batch hydration for both a run's subjects and the candidates its similarity search turns up. */
export async function loadEntityDedupDetails(
  driver: Driver,
  ids: readonly string[],
): Promise<DedupEntityDetail[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return runRead(driver, LOAD_ENTITY_DEDUP_DETAILS, { ids: unique }, mapDedupEntityDetail);
}

export type FindSimilarCurrentEntitiesInput = {
  readonly type: string;
  readonly excludeId: string;
  readonly vector: Vector;
  readonly threshold: number;
  readonly limit: number;
};

export type SimilarCurrentEntityMatch = {
  readonly id: string;
  readonly score: number;
};

/**
 * §6.5's "current Entity nodes of the same type": unlike `entitySimilaritySeeds` (recall's
 * read, which stays currency-aware rather than currency-filtered), a merge candidate must
 * still hold currency, or the search would propose absorbing into — or out of — an identity
 * a previous run already closed.
 *
 * `vector.similarity.cosine` rescales onto [0,1] the same way the vector index does
 * (`(1 + cos) / 2`), so the result is converted back to a true cosine before it is compared
 * against a threshold pinned as one.
 */
const FIND_SIMILAR_CURRENT_ENTITIES = [
  `MATCH (n:${ENTITY_LABEL})`,
  `WHERE n.${ENTITY_TYPE_PROPERTY} = $type`,
  '  AND n.id <> $excludeId',
  `  AND n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `  AND n.${ENTITY_NAME_VECTOR_PROPERTY} IS NOT NULL`,
  `  AND size(n.${ENTITY_NAME_VECTOR_PROPERTY}) = $dimension`,
  `WITH n, (2.0 * vector.similarity.cosine(n.${ENTITY_NAME_VECTOR_PROPERTY}, $vector) - 1.0) AS score`,
  'WHERE score >= $threshold',
  'RETURN n.id AS id, score',
  'ORDER BY score DESC',
  'LIMIT $limit',
].join('\n');

export async function findSimilarCurrentEntities(
  driver: Driver,
  input: FindSimilarCurrentEntitiesInput,
): Promise<SimilarCurrentEntityMatch[]> {
  return runRead(
    driver,
    FIND_SIMILAR_CURRENT_ENTITIES,
    {
      type: input.type,
      excludeId: input.excludeId,
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      threshold: input.threshold,
      limit: toGraphInteger(input.limit),
    },
    (row) => ({ id: row.id as string, score: row.score as number }),
  );
}

export type RedirectableEdge = {
  readonly mergedId: string;
  readonly type: string;
  readonly direction: 'out' | 'in';
  readonly otherId: string;
  readonly strength: number;
  readonly confidence: number;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
  readonly count: number;
  readonly rationale?: string;
};

/**
 * Every relationship touching a node about to be absorbed, whichever direction it runs.
 * `startNode(r).id = mergedId` reads the direction back off the relationship itself rather
 * than issuing two matches, since a merged node's own edges are read exactly once either way.
 */
const FIND_MERGED_NODE_EDGES = [
  'UNWIND $mergedIds AS mergedId',
  `MATCH (m:${BASE_NODE_LABEL} { id: mergedId })-[r]-(o:${BASE_NODE_LABEL})`,
  'WHERE o.id <> mergedId',
  'RETURN mergedId AS mergedId, type(r) AS type,',
  "       CASE WHEN startNode(r).id = mergedId THEN 'out' ELSE 'in' END AS direction,",
  '       o.id AS otherId, r.strength AS strength, r.confidence AS confidence,',
  '       r.signals AS signals, r.provenance AS provenance, r.count AS count, r.rationale AS rationale',
].join('\n');

function mapRedirectableEdge(row: Row): RedirectableEdge {
  const rationale = row.rationale;
  return {
    mergedId: row.mergedId as string,
    type: row.type as string,
    direction: row.direction === 'in' ? 'in' : 'out',
    otherId: row.otherId as string,
    strength: (row.strength as number | null) ?? 0,
    confidence: (row.confidence as number | null) ?? 0,
    signals: (row.signals as string[] | null) ?? [],
    provenance: (row.provenance as string[] | null) ?? [],
    count: (row.count as number | null) ?? 0,
    ...(typeof rationale === 'string' ? { rationale } : {}),
  };
}

async function findMergedNodeEdgesInTransaction(
  tx: GraphTransaction,
  mergedIds: readonly string[],
): Promise<RedirectableEdge[]> {
  if (mergedIds.length === 0) {
    return [];
  }
  return tx.run(FIND_MERGED_NODE_EDGES, { mergedIds: [...mergedIds] }, mapRedirectableEdge);
}

export type MergeEntityGroupInput = {
  readonly canonicalId: string;
  readonly mergedIds: readonly string[];
  /** The full, final alias list — this call sets the property, it does not append to it. */
  readonly aliases: readonly string[];
  readonly accessCount: number;
  readonly lastAccessed?: Date;
  readonly now: Date;
};

export type MergeEntityGroupResult = {
  readonly edgesRedirected: number;
};

/**
 * One transaction: lock canonical and every merged node (stable order, so two concurrent
 * merges cannot deadlock on each other), read the merged nodes' relationships, and redirect
 * each through the ordinary edge-upsert, which is what makes a collision with an edge
 * canonical already holds sum and max rather than overwrite. An edge whose other endpoint is
 * itself part of this group — including a direct canonical/merged edge — is dropped rather
 * than redirected: after the merge both ends are the same node, and a self-loop records
 * nothing. Bitemporal closure is a separate call (`supersede`, which owns its own
 * transaction); this one only moves what the merged nodes were connected to.
 */
export async function redirectAndAbsorb(
  driver: Driver,
  input: MergeEntityGroupInput,
): Promise<MergeEntityGroupResult> {
  const mergedIds = [...new Set(input.mergedIds)].sort();
  if (mergedIds.length === 0) {
    return { edgesRedirected: 0 };
  }
  const absorbed = new Set([input.canonicalId, ...mergedIds]);

  return inWriteTransaction(driver, async (tx) => {
    await lockNodeInTransaction(tx, input.canonicalId, input.now);
    for (const mergedId of mergedIds) {
      await lockNodeInTransaction(tx, mergedId, input.now);
    }

    const edges = await findMergedNodeEdgesInTransaction(tx, mergedIds);
    let redirected = 0;
    for (const edge of edges) {
      const other = absorbed.has(edge.otherId) ? input.canonicalId : edge.otherId;
      if (other === input.canonicalId) {
        continue;
      }
      if (!isRelationshipType(edge.type)) {
        continue;
      }

      const sourceId = edge.direction === 'out' ? input.canonicalId : other;
      const targetId = edge.direction === 'out' ? other : input.canonicalId;
      await upsertEdgeInTransaction(tx, {
        type: edge.type,
        sourceId,
        targetId,
        strength: edge.strength,
        confidence: edge.confidence,
        signals: edge.signals,
        provenance: edge.provenance,
        count: edge.count,
        ...(edge.rationale === undefined ? {} : { rationale: edge.rationale }),
        now: input.now,
      });
      redirected += 1;
    }

    await writeStampedNodeInTransaction(tx, {
      label: 'Entity',
      id: input.canonicalId,
      now: input.now,
      mergeProperties: {
        [ENTITY_ALIASES_PROPERTY]: input.aliases,
        [ACCESS_COUNT_PROPERTY]: input.accessCount,
        ...(input.lastAccessed === undefined ? {} : { [LAST_ACCESSED_PROPERTY]: input.lastAccessed }),
      },
    });

    return { edgesRedirected: redirected };
  });
}

const CLEAR_ENTITY_VECTORS = [
  'UNWIND $ids AS id',
  `MATCH (n:${BASE_NODE_LABEL} { id: id })`,
  `SET n.${ENTITY_NAME_VECTOR_PROPERTY} = null, n.${MEMORY_PROPERTIES.contentVector} = null`,
  'RETURN n.id AS id',
].join('\n');

/**
 * §6.5: "vector index cleanup ... runs post-commit with best-effort semantics." A merged
 * node stays queryable (superseded, not deleted), so its vectors are cleared rather than the
 * node — otherwise it would keep answering `entitySimilaritySeeds`, which is currency-aware
 * rather than currency-filtered by design and does not exclude a superseded row on its own.
 */
export async function clearEntityVectors(driver: Driver, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return runWrite(driver, CLEAR_ENTITY_VECTORS, { ids: unique }, (row) => row.id as string);
}
