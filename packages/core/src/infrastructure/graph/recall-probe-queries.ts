import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-mention-queries.js';
import { BASE_NODE_LABEL, EXTRACTION_TYPE } from './labels.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import { toGraphDateTime, toGraphInteger, type Row } from './values.js';

/**
 * The two structural reads behind the recall self-probe. Both answer the same kind of question
 * from opposite ends: did the substrate hand back what it was told, and did what it handed back
 * ever get used.
 *
 * Neither read writes anything, and neither stamps access: a probe that reinforced what it
 * looked at would raise its own score on the next run.
 */

export type PackCoverageInput = {
  /** The archived episode the probe asked for. */
  readonly episodeId: string;
  /** Every item id the pack rendered, across all its buckets. */
  readonly candidateIds: readonly string[];
};

/**
 * Three ways a pack answers for an episode, and they are one query because a caller needs the
 * union, not which of them fired: the episode itself came back, something extraction pulled out
 * of it came back, or the narrative that compressed it came back. A pack holding only the
 * narrative still answered the question, since the narrative is what the substrate kept.
 */
export function buildPackCoverageStatement(input: PackCoverageInput): GraphStatement {
  const cypher = [
    'MATCH (episode:Episode { id: $episodeId })',
    'UNWIND $candidateIds AS candidateId',
    `MATCH (item:${BASE_NODE_LABEL} { id: candidateId })`,
    'WHERE item.id = episode.id',
    `   OR (item)-[:${EXTRACTION_TYPE}]->(episode)`,
    `   OR (episode)-[:${SUMMARIZED_BY_TYPE}]->(item)`,
    'RETURN DISTINCT item.id AS id',
  ].join('\n');
  return { cypher, parameters: { episodeId: input.episodeId, candidateIds: input.candidateIds } };
}

/**
 * Which of the pack's items cover the episode. Empty means the pack answered with something
 * else, which is a miss whatever else it holds.
 */
export async function findPackCoverage(
  driver: Driver,
  input: PackCoverageInput,
): Promise<readonly string[]> {
  if (input.candidateIds.length === 0) {
    return [];
  }
  const statement = buildPackCoverageStatement(input);
  return runRead(driver, statement, (row: Row) => row.id as string);
}

export type ServedItemReference = {
  readonly itemId: string;
  readonly firstServedAt: Date;
};

/**
 * Whether a served memory turned up in what the member said next. Two edges count, and they are
 * the two ways a later episode points at an existing node: the episode mentions it, or the node
 * gained provenance on it, which is what a restated claim gets. `occurred_at` rather than a
 * write stamp, because the question is whether the conversation that followed the serve used
 * the memory, and the conversation's own clock is when it happened.
 */
export function buildServedReferenceStatement(
  items: readonly ServedItemReference[],
  limit: number,
): GraphStatement {
  const cypher = [
    'UNWIND $items AS served',
    `MATCH (item:${BASE_NODE_LABEL} { id: served.id })`,
    'WHERE EXISTS {',
    `  MATCH (later:Episode)-[:${ENTITY_MENTION_TYPE}]->(item)`,
    `  WHERE later.${BITEMPORAL_PROPERTIES.occurredAt} > served.at`,
    '} OR EXISTS {',
    `  MATCH (item)-[:${EXTRACTION_TYPE}]->(later:Episode)`,
    `  WHERE later.${BITEMPORAL_PROPERTIES.occurredAt} > served.at`,
    '}',
    'RETURN DISTINCT item.id AS id',
    'LIMIT $limit',
  ].join('\n');
  return {
    cypher,
    parameters: {
      items: items.map((item) => ({ id: item.itemId, at: toGraphDateTime(item.firstServedAt) })),
      limit: toGraphInteger(limit),
    },
  };
}

/** How many of the served items a later episode reached. Zero is a real answer, not a failure. */
export async function countServedReferences(
  driver: Driver,
  items: readonly ServedItemReference[],
): Promise<number> {
  if (items.length === 0) {
    return 0;
  }
  const statement = buildServedReferenceStatement(items, items.length);
  const rows = await runRead(driver, statement, (row: Row) => row.id as string);
  return rows.length;
}
