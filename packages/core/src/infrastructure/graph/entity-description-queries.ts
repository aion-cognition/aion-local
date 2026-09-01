import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead, runWrite } from './connection.js';
import { ENTITY_MENTION_TYPE, ENTITY_TYPE_PROPERTY } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { ENTITY_NAME_PROPERTY, STRUCTURAL_PROPERTY } from './seed-queries.js';
import { toGraphDateTime, toGraphInteger, toGraphVector, type Row } from './values.js';
import { vectorInputHash } from '../../reflection/domain/vector-input.js';
import type { Vector } from '../providers/types.js';

/**
 * The reads and the one write behind description freshness. An entity's description is
 * written once, by whichever episode first named it, and never touched again by ordinary
 * extraction (`entity-queries.ts`'s merge is `ON CREATE` only). Mention count is not read off
 * a node property: `access_count` also moves on every recall a node is surfaced by, so it
 * cannot tell a description that fell behind real new mentions from one that fell behind
 * search traffic. Counting `MENTIONS` edges directly is the true signal.
 */

/** Baseline mention count as of the description currently on the node, absent until a refresh writes it. */
export const DESCRIPTION_MENTION_COUNT_PROPERTY = 'description_mention_count';
export const PRIOR_DESCRIPTIONS_PROPERTY = 'prior_descriptions';
export const DESCRIPTION_REFRESHED_AT_PROPERTY = 'description_refreshed_at';
export const DESCRIPTION_REFRESH_METHOD_PROPERTY = 'description_refresh_method';
/** When a correction retired the description; the wording itself moves to `prior_descriptions`. */
export const DESCRIPTION_RETIRED_AT_PROPERTY = 'description_retired_at';

/** Provenance stamped on every regenerated description. */
export const DESCRIPTION_REFRESH_METHOD = 'introspection_description_freshness';

/**
 * A description is written by exactly the mention that created the entity, so a node that has
 * never been refreshed has an implicit baseline of one: coalescing the stored baseline to 1
 * is not a guess, it is the fact the merge-on-create write establishes.
 */
const IMPLICIT_BASELINE_MENTIONS = 1;

export type StaleDescriptionEntity = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly text: string;
  readonly mentions: number;
  readonly baseline: number;
};

const FIND_STALE_DESCRIPTION_ENTITIES = [
  'MATCH (e:Entity)',
  `WHERE ${currentOnly('e')}`,
  `  AND coalesce(e.${STRUCTURAL_PROPERTY}, false) = false`,
  `OPTIONAL MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(e)`,
  // `count(ep)`, not `count(*)`: an entity with no mention edge still yields one row from
  // `OPTIONAL MATCH` with `ep` bound to null, and `count(*)` would read that as one mention.
  'WITH e, count(ep) AS mentions',
  `WITH e, mentions, mentions - coalesce(e.${DESCRIPTION_MENTION_COUNT_PROPERTY}, $implicitBaseline) AS growth`,
  'WHERE growth >= $growthThreshold',
  `RETURN e.id AS id, e.${ENTITY_NAME_PROPERTY} AS name, e.${ENTITY_TYPE_PROPERTY} AS type,`,
  `       e.${MEMORY_PROPERTIES.text} AS text, mentions,`,
  `       coalesce(e.${DESCRIPTION_MENTION_COUNT_PROPERTY}, $implicitBaseline) AS baseline`,
  'ORDER BY growth DESC, e.id',
  'LIMIT $limit',
].join('\n');

export async function findStaleDescriptionEntities(
  driver: Driver,
  input: { readonly growthThreshold: number; readonly limit: number },
): Promise<StaleDescriptionEntity[]> {
  if (input.limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    {
      cypher: FIND_STALE_DESCRIPTION_ENTITIES,
      parameters: {
        growthThreshold: toGraphInteger(input.growthThreshold),
        implicitBaseline: toGraphInteger(IMPLICIT_BASELINE_MENTIONS),
        limit: toGraphInteger(input.limit),
      },
    },
    (row: Row) => ({
      id: row.id as string,
      name: (row.name as string | null) ?? '',
      type: (row.type as string | null) ?? '',
      text: (row.text as string | null) ?? '',
      mentions: typeof row.mentions === 'number' ? row.mentions : Number(row.mentions ?? 0),
      baseline: typeof row.baseline === 'number' ? row.baseline : Number(row.baseline ?? 0),
    }),
  );
}

export type EntityMentionContext = {
  readonly episodeId: string;
  readonly text: string;
  readonly occurredAt?: Date;
};

/**
 * What the entity has been mentioned in since, most recent first: the source the
 * re-synthesis prompt grounds itself in. Older than the description itself is nothing new to
 * fold in, so this reads recency rather than the whole mention history.
 */
const FIND_ENTITY_MENTION_CONTEXTS = [
  `MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(:Entity { id: $entityId })`,
  `WHERE ep.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `RETURN ep.id AS episode_id, coalesce(ep.${MEMORY_PROPERTIES.summary}, ep.${MEMORY_PROPERTIES.text}) AS text,`,
  `       ep.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at`,
  `ORDER BY ep.${BITEMPORAL_PROPERTIES.occurredAt} DESC, ep.id DESC`,
  'LIMIT $limit',
].join('\n');

export async function findEntityMentionContexts(
  driver: Driver,
  entityId: string,
  limit: number,
): Promise<EntityMentionContext[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    {
      cypher: FIND_ENTITY_MENTION_CONTEXTS,
      parameters: { entityId, limit: toGraphInteger(limit) },
    },
    (row: Row) => {
      const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : undefined;
      return {
        episodeId: row.episode_id as string,
        text: (row.text as string | null) ?? '',
        ...(occurredAt === undefined ? {} : { occurredAt }),
      };
    },
  );
}

/**
 * Rewrites the description in place. The old value moves to `prior_descriptions` rather than
 * being dropped: Neo4j properties cannot hold a list of objects, so provenance for one entry
 * (who wrote it, when) is not attached per string, and lives instead on the node as the single
 * most recent refresh's method and timestamp, which is what every entry after the first one
 * was written under.
 */
const REFRESH_ENTITY_DESCRIPTION = [
  'MATCH (e:Entity { id: $id })',
  `SET e.${PRIOR_DESCRIPTIONS_PROPERTY} = coalesce(e.${PRIOR_DESCRIPTIONS_PROPERTY}, []) + [e.${MEMORY_PROPERTIES.text}],`,
  `    e.${MEMORY_PROPERTIES.text} = $text,`,
  `    e.${MEMORY_PROPERTIES.contentVector} = $contentVector,`,
  `    e.${MEMORY_PROPERTIES.contentVectorHash} = $contentVectorHash,`,
  `    e.${DESCRIPTION_MENTION_COUNT_PROPERTY} = $mentionCount,`,
  `    e.${DESCRIPTION_REFRESHED_AT_PROPERTY} = $now,`,
  `    e.${DESCRIPTION_REFRESH_METHOD_PROPERTY} = $method`,
  'RETURN e.id AS id',
].join('\n');

export type RefreshEntityDescriptionInput = {
  readonly id: string;
  readonly text: string;
  readonly contentVector: Vector;
  readonly mentionCount: number;
  readonly now: Date;
};

export async function refreshEntityDescription(
  driver: Driver,
  input: RefreshEntityDescriptionInput,
): Promise<boolean> {
  const rows = await runWrite(
    driver,
    {
      cypher: REFRESH_ENTITY_DESCRIPTION,
      parameters: {
        id: input.id,
        text: input.text,
        contentVector: toGraphVector(input.contentVector),
        contentVectorHash: vectorInputHash(input.text),
        mentionCount: toGraphInteger(input.mentionCount),
        now: toGraphDateTime(input.now),
        method: DESCRIPTION_REFRESH_METHOD,
      },
    },
    (row: Row) => row.id as string,
  );
  return rows.length > 0;
}
