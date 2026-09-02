import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-mention-queries.js';
import { BACKBONE_TYPES, BASE_NODE_LABEL, ENTITY_LABEL } from './labels.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import type { Row } from './values.js';

/**
 * The graph evidence tier 2 weighs for a nominated entity pair. Everything here is a fact
 * about the store rather than a score: how much history the two share, how much of their
 * neighbourhood they share, how far apart they were first seen, and how often each is
 * mentioned at all. Nothing is averaged and nothing is combined; the cascade reads the facts
 * and decides.
 *
 * The two overlap signals are deliberately taken over disjoint edge sets. Provenance comes
 * from the mention edges; the neighbourhood excludes both mention directions along with the
 * backbone, so a pair that shares three episodes does not also collect three "shared
 * neighbours" for the same three episodes. Reading one signal twice and calling it two is how
 * a weighted combination talks itself into a merge.
 *
 * Currency-filtered on every node it touches, entity sides included: a pair with a closed side
 * has nothing left to merge, and comes back as no row at all rather than as a row of zeroes.
 */

export type EntityPairRequest = {
  readonly leftId: string;
  readonly rightId: string;
};

export type EntityPairSignals = {
  readonly leftId: string;
  readonly rightId: string;
  /** Sorted here rather than in Cypher, which has no list sort without a procedure the image
   * does not guarantee. A decision record built from this is then stable across runs. */
  readonly sharedEpisodeIds: readonly string[];
  readonly sharedEpisodeCount: number;
  readonly sharedEpisodeJaccard: number;
  readonly neighborOverlapCount: number;
  readonly neighborOverlapJaccard: number;
  /**
   * Days between the closest episode on each side, zero when they share one. Absent when a
   * side has no current episode: nothing was measured, which is not the same as measuring
   * zero distance, and a caller that zero-fills it has invented evidence.
   */
  readonly temporalGapDays?: number;
  /** Distinct current episodes mentioning each side, which is the strength signal, not `access_count`. */
  readonly leftEpisodeCount: number;
  readonly rightEpisodeCount: number;
};

/** The one hop the neighbourhood is allowed to take, as a Cypher predicate on the relationship. */
function neighbourEdge(variable: string): string {
  return `NOT type(${variable}) IN [${BACKBONE_TYPES}] AND type(${variable}) <> '${ENTITY_MENTION_TYPE}'`;
}

const SECONDS_PER_DAY = 86_400;

/**
 * One read for the whole batch. The episode collections are gathered a side at a time, because
 * two optional matches held open together multiply into a cross product and every count taken
 * from it is wrong by the size of the other side.
 *
 * The gap is the minimum over every pair of episode times, which is quadratic in the mention
 * counts. At local scale those are tens, and the alternative (sorting both lists in Cypher)
 * needs a procedure this deployment does not guarantee. Size it again if an entity ever
 * accumulates thousands of mentions.
 */
const READ_ENTITY_PAIR_SIGNALS = [
  'UNWIND range(0, size($pairs) - 1) AS ordinal',
  'WITH ordinal, $pairs[ordinal] AS pair',
  `MATCH (a:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: pair.left })`,
  `WHERE ${currentOnly('a')}`,
  `MATCH (b:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: pair.right })`,
  `WHERE ${currentOnly('b')}`,

  `OPTIONAL MATCH (ea:Episode)-[:${ENTITY_MENTION_TYPE}]->(a)`,
  `WHERE ${currentOnly('ea')} AND ea.${BITEMPORAL_PROPERTIES.occurredAt} IS NOT NULL`,
  'WITH ordinal, a, b, collect(DISTINCT ea) AS leftEpisodes',
  `OPTIONAL MATCH (eb:Episode)-[:${ENTITY_MENTION_TYPE}]->(b)`,
  `WHERE ${currentOnly('eb')} AND eb.${BITEMPORAL_PROPERTIES.occurredAt} IS NOT NULL`,
  'WITH ordinal, a, b, leftEpisodes, collect(DISTINCT eb) AS rightEpisodes',

  `OPTIONAL MATCH (a)-[ra]-(na:${BASE_NODE_LABEL})`,
  `WHERE ${neighbourEdge('ra')} AND na.id <> a.id AND ${currentOnly('na')}`,
  `  AND coalesce(na.${STRUCTURAL_PROPERTY}, false) = false`,
  'WITH ordinal, a, b, leftEpisodes, rightEpisodes, collect(DISTINCT na.id) AS leftNeighbours',
  `OPTIONAL MATCH (b)-[rb]-(nb:${BASE_NODE_LABEL})`,
  `WHERE ${neighbourEdge('rb')} AND nb.id <> b.id AND ${currentOnly('nb')}`,
  `  AND coalesce(nb.${STRUCTURAL_PROPERTY}, false) = false`,
  'WITH ordinal, a, b, leftEpisodes, rightEpisodes, leftNeighbours,',
  '     collect(DISTINCT nb.id) AS rightNeighbours',

  'WITH ordinal, a, b, leftEpisodes, rightEpisodes, leftNeighbours, rightNeighbours,',
  '     [e IN leftEpisodes | e.id] AS leftEpisodeIds, [e IN rightEpisodes | e.id] AS rightEpisodeIds',
  'WITH ordinal, a, b, leftEpisodes, rightEpisodes, leftNeighbours, rightNeighbours,',
  '     leftEpisodeIds, rightEpisodeIds,',
  '     [id IN leftEpisodeIds WHERE id IN rightEpisodeIds] AS sharedEpisodeIds,',
  '     [id IN leftNeighbours WHERE id IN rightNeighbours] AS sharedNeighbours',

  // The flattened cross product of the two sides' episode times, then its minimum. Both stay
  // reduce() calls because Cypher has no sort or min over a list without a procedure.
  'WITH ordinal, a, b, leftEpisodeIds, rightEpisodeIds, sharedEpisodeIds, sharedNeighbours,',
  '     size(leftNeighbours) + size(rightNeighbours) - size(sharedNeighbours) AS neighbourUnion,',
  '     size(leftEpisodeIds) + size(rightEpisodeIds) - size(sharedEpisodeIds) AS episodeUnion,',
  '     reduce(flat = [], row IN [ea IN leftEpisodes |',
  '       [eb IN rightEpisodes |',
  `         abs(duration.inSeconds(ea.${BITEMPORAL_PROPERTIES.occurredAt},`,
  `                                 eb.${BITEMPORAL_PROPERTIES.occurredAt}).seconds)]] | flat + row) AS gaps`,

  'RETURN ordinal, a.id AS left_id, b.id AS right_id,',
  '       sharedEpisodeIds AS shared_episode_ids,',
  '       size(sharedEpisodeIds) AS shared_episode_count,',
  '       CASE WHEN episodeUnion = 0 THEN 0.0',
  '            ELSE toFloat(size(sharedEpisodeIds)) / episodeUnion END AS shared_episode_jaccard,',
  '       size(sharedNeighbours) AS neighbour_overlap_count,',
  '       CASE WHEN neighbourUnion = 0 THEN 0.0',
  '            ELSE toFloat(size(sharedNeighbours)) / neighbourUnion END AS neighbour_overlap_jaccard,',
  '       reduce(best = null, gap IN gaps |',
  '         CASE WHEN best IS NULL OR gap < best THEN gap ELSE best END) AS gap_seconds,',
  '       size(leftEpisodeIds) AS left_episode_count,',
  '       size(rightEpisodeIds) AS right_episode_count',
  'ORDER BY ordinal',
].join('\n');

function mapEntityPairSignals(row: Row): EntityPairSignals {
  const gapSeconds = row.gap_seconds;
  return {
    leftId: row.left_id as string,
    rightId: row.right_id as string,
    sharedEpisodeIds: [...((row.shared_episode_ids as string[] | null) ?? [])].sort(),
    sharedEpisodeCount: row.shared_episode_count as number,
    sharedEpisodeJaccard: row.shared_episode_jaccard as number,
    neighborOverlapCount: row.neighbour_overlap_count as number,
    neighborOverlapJaccard: row.neighbour_overlap_jaccard as number,
    ...(typeof gapSeconds === 'number' ? { temporalGapDays: gapSeconds / SECONDS_PER_DAY } : {}),
    leftEpisodeCount: row.left_episode_count as number,
    rightEpisodeCount: row.right_episode_count as number,
  };
}

/**
 * The evidence for every nominated pair, in the order asked. A pair whose either side has lost
 * currency is simply absent, so a caller aligning results to requests matches on the ids rather
 * than on position.
 */
export async function readEntityPairSignals(
  driver: Driver,
  pairs: readonly EntityPairRequest[],
): Promise<EntityPairSignals[]> {
  if (pairs.length === 0) {
    return [];
  }
  return runRead(
    driver,
    READ_ENTITY_PAIR_SIGNALS,
    { pairs: pairs.map((pair) => ({ left: pair.leftId, right: pair.rightId })) },
    mapEntityPairSignals,
  );
}
