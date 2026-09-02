import type { Driver } from 'neo4j-driver';

import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead } from './connection.js';
import { ENTITY_ALIASES_PROPERTY } from './entity-identity-queries.js';
import {
  ENTITY_MENTION_TYPE,
  ENTITY_TYPE_COUNTS_PROPERTY,
  ENTITY_TYPE_PROPERTY,
} from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { ENTITY_LABEL } from './labels.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  LAST_ACCESSED_PROPERTY,
  STRUCTURAL_PROPERTY,
} from './seed-queries.js';
import { fromGraphVector, toGraphInteger, toGraphVector, type Row } from './values.js';
import { asCosine } from './vector-indexes.js';
import type { Vector } from '../providers/types.js';

/**
 * The graph side of entity deduplication. Everything that decides who is canonical lives in
 * `reflection/domain/entity-merge.ts`; the merge write itself lives in
 * `entity-merge-queries.ts`, and this module only reads the candidates a similarity search
 * needs.
 */

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
  /**
   * Distinct current episodes that mention the entity, which is the strength signal canonical
   * selection reads. Not the sum of `MENTIONS.count`: an entity named forty times in one
   * episode has been seen once, and a sum lets one loud episode outweigh a year of history.
   * Independent of `access_count`, which recall also bumps.
   */
  readonly mentionCount: number;
  /** Counted type readings, as the JSON string the node stores; `{}` until one is recorded. */
  readonly typeCounts: string;
  /** The stored description, which tier 3 reads as evidence. Empty on a node that has none. */
  readonly description: string;
};

const LOAD_ENTITY_DEDUP_DETAILS = [
  'UNWIND $ids AS wantedId',
  `MATCH (n:${ENTITY_LABEL} { id: wantedId })`,
  `OPTIONAL MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(n)`,
  `WHERE ${currentOnly('ep')}`,
  'WITH n, count(DISTINCT ep) AS mentionCount',
  `RETURN n.id AS id, n.${ENTITY_NAME_PROPERTY} AS name, n.${ENTITY_NAME_NORM_PROPERTY} AS name_norm,`,
  `       n.${ENTITY_TYPE_PROPERTY} AS type, coalesce(n.${STRUCTURAL_PROPERTY}, false) AS is_structural,`,
  `       n.${ENTITY_NAME_VECTOR_PROPERTY} AS name_vec,`,
  `       n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AS current,`,
  `       n.${BITEMPORAL_PROPERTIES.txFrom} AS tx_from,`,
  `       coalesce(n.${ENTITY_ALIASES_PROPERTY}, []) AS aliases,`,
  `       coalesce(n.${ACCESS_COUNT_PROPERTY}, 0) AS access_count,`,
  `       n.${LAST_ACCESSED_PROPERTY} AS last_accessed,`,
  `       coalesce(n.${ENTITY_TYPE_COUNTS_PROPERTY}, '{}') AS type_counts,`,
  `       coalesce(n.${MEMORY_PROPERTIES.text}, '') AS description,`,
  '       mentionCount',
].join('\n');

function mapDedupEntityDetail(row: Row): DedupEntityDetail {
  const nameVector = fromGraphVector(row.name_vec);
  const txFrom = row.tx_from;
  const lastAccessed = row.last_accessed;
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? '',
    nameNorm: (row.name_norm as string | null) ?? '',
    type: (row.type as string | null) ?? '',
    isStructural: row.is_structural === true,
    ...(nameVector === undefined ? {} : { nameVector }),
    current: row.current === true,
    ...(txFrom instanceof Date ? { txFrom } : {}),
    aliases: (row.aliases as string[] | null) ?? [],
    accessCount: (row.access_count as number | null) ?? 0,
    ...(lastAccessed instanceof Date ? { lastAccessed } : {}),
    mentionCount: (row.mentionCount as number | null) ?? 0,
    typeCounts: (row.type_counts as string | null) ?? '{}',
    description: (row.description as string | null) ?? '',
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
  readonly excludeId: string;
  readonly vector: Vector;
  readonly threshold: number;
  readonly limit: number;
};

export type SimilarCurrentEntityMatch = {
  readonly id: string;
  readonly type: string;
  readonly score: number;
};

/**
 * Current Entity nodes near a name vector, of any type. Unlike `entitySimilaritySeeds`
 * (recall's read, which stays currency-aware rather than currency-filtered), a merge candidate
 * must still hold currency, or the search would propose absorbing into (or out of) an
 * identity a previous run already closed.
 *
 * The search carries no predicate on type and never will: it used to filter on the subject's
 * own type, which made a cross-type duplicate invisible, and PostgreSQL existed as tool, topic
 * and organization at once with no run able to see it. Type comes back on the row as data for
 * the stage to weigh.
 *
 * `vector.similarity.cosine` rescales onto [0,1] the same way the vector index does
 * (`(1 + cos) / 2`), so the result is converted back to a true cosine before it is compared
 * against a threshold pinned as one.
 */
const FIND_SIMILAR_CURRENT_ENTITIES = [
  `MATCH (n:${ENTITY_LABEL})`,
  'WHERE n.id <> $excludeId',
  `  AND ${currentOnly('n')}`,
  `  AND n.${ENTITY_NAME_VECTOR_PROPERTY} IS NOT NULL`,
  `  AND size(n.${ENTITY_NAME_VECTOR_PROPERTY}) = $dimension`,
  `WITH n, ${asCosine(`vector.similarity.cosine(n.${ENTITY_NAME_VECTOR_PROPERTY}, $vector)`)} AS score`,
  'WHERE score >= $threshold',
  `RETURN n.id AS id, n.${ENTITY_TYPE_PROPERTY} AS type, score`,
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
      excludeId: input.excludeId,
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      threshold: input.threshold,
      limit: toGraphInteger(input.limit),
    },
    (row) => ({
      id: row.id as string,
      type: (row.type as string | null) ?? '',
      score: row.score as number,
    }),
  );
}
