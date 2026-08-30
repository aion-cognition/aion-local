import neo4j, { type Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';

/**
 * The graph side of the backbone repair. An episode reaches its session through one
 * `PARTICIPATES_IN` edge, and intake writes that edge inside the same transaction as the
 * episode, so a missing one means the write was interrupted or an older writer never made it.
 * The episode itself still carries `session_id`, which is what makes the repair a lookup
 * rather than a guess.
 *
 * Nothing here writes. The repair goes through the ordinary edge upsert, so a restored
 * backbone link leaves the same trail every other edge leaves.
 */

const CURRENT = (variable: string): string =>
  [
    `${variable}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `${variable}.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  ].join(' AND ');

/** `LIMIT` is Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

export type BackboneRepairTarget = {
  readonly episodeId: string;
  readonly sessionId: string;
};

/**
 * Oldest first. A break the substrate has carried longest is the one recall has been missing
 * for longest, and taking the newest would spend the batch racing intake for episodes it is
 * still writing.
 *
 * An episode whose `session_id` names no current session is not returned: there is nothing to
 * attach it to, and inventing a session would be a worse answer than leaving the count high.
 */
const FIND_EPISODES_MISSING_SESSION_LINK = [
  'MATCH (e:Episode)',
  `WHERE ${CURRENT('e')} AND e.${MEMORY_PROPERTIES.sessionId} IS NOT NULL`,
  `  AND NOT (e)-[:${CONTAINMENT_TYPE}]->(:Session)`,
  `WITH e ORDER BY e.${BITEMPORAL_PROPERTIES.txFrom}, e.id LIMIT $limit`,
  `MATCH (s:Session { id: e.${MEMORY_PROPERTIES.sessionId} })`,
  `WHERE s.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  'RETURN e.id AS episode_id, s.id AS session_id',
].join('\n');

export async function findEpisodesMissingSessionLink(
  driver: Driver,
  limit: number,
): Promise<readonly BackboneRepairTarget[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_EPISODES_MISSING_SESSION_LINK,
    { limit: toGraphInteger(limit) },
    (row) => ({
      episodeId: row.episode_id as string,
      sessionId: row.session_id as string,
    }),
  );
}
