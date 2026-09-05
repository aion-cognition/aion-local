import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead, runWrite } from './connection.js';
import { ENTITY_MENTION_TYPE, ENTITY_TYPE_PROPERTY } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, ENTITY_LABEL } from './labels.js';
import { ENTITY_NAME_PROPERTY, STRUCTURAL_PROPERTY } from './seed-queries.js';
import { toGraphDateTime, toGraphInteger, toGraphVector, type Row } from './values.js';
import { vectorInputHash } from '../../reflection/domain/vector-input.js';
import type { Vector } from '../providers/types.js';

/**
 * The reads and writes over an entity's description state, which two operations act on.
 * An entity's description is written once, by whichever episode first named it, and never
 * touched again by ordinary extraction (`entity-queries.ts`'s merge is `ON CREATE` only).
 * Description freshness rewrites one that fell behind its mentions; curiosity asks about one
 * that was never written or never re-derived, which is the same state read for a different
 * answer. Mention count is not read off a node property: `access_count` also moves on every
 * recall a node is surfaced by, so it cannot tell a description that fell behind real new
 * mentions from one that fell behind search traffic. Counting `MENTIONS` edges directly is the
 * true signal.
 */

/** Baseline mention count as of the description currently on the node, absent until a refresh writes it. */
export const DESCRIPTION_MENTION_COUNT_PROPERTY = 'description_mention_count';
export const PRIOR_DESCRIPTIONS_PROPERTY = 'prior_descriptions';
export const DESCRIPTION_REFRESHED_AT_PROPERTY = 'description_refreshed_at';
export const DESCRIPTION_REFRESH_METHOD_PROPERTY = 'description_refresh_method';
/** When a correction retired the description; the wording itself moves to `prior_descriptions`. */
export const DESCRIPTION_RETIRED_AT_PROPERTY = 'description_retired_at';

/**
 * When the substrate filed a question about this entity. It is a permanent mark rather than a
 * cooldown: a question already asked is either answered, superseded, or closed by its horizon,
 * and asking again would put the same sentence back in front of whoever is already ignoring it.
 * A later refresh of the description deliberately leaves it alone.
 */
export const CURIOSITY_ASKED_AT_PROPERTY = 'curiosity_asked_at';

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

export type UndescribedEntity = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Empty for the retired-gloss state, which is one of the two ways in here. */
  readonly text: string;
  readonly mentions: number;
};

/**
 * Entities the substrate has no answer for: a gloss a correction retired, or one nothing has
 * ever re-derived while the mentions piled up. The two are one population, since both describe
 * a well-connected identity the store cannot say anything current about.
 *
 * An entity already carrying `curiosity_asked_at` is excluded outright rather than aged out.
 * The question that stamped it is still standing or was already closed, and either way the hole
 * has been named once.
 */
const FIND_UNDESCRIBED_ENTITIES = [
  'MATCH (e:Entity)',
  `WHERE ${currentOnly('e')}`,
  `  AND coalesce(e.${STRUCTURAL_PROPERTY}, false) = false`,
  `  AND e.${CURIOSITY_ASKED_AT_PROPERTY} IS NULL`,
  `OPTIONAL MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(e)`,
  // `count(ep)` for the reason the stale-description read uses it: an entity with no mention
  // edge still yields one row with `ep` bound to null, which `count(*)` would read as one.
  'WITH e, count(ep) AS mentions',
  `WHERE e.${MEMORY_PROPERTIES.text} IS NULL`,
  `   OR (e.${DESCRIPTION_REFRESHED_AT_PROPERTY} IS NULL AND mentions >= $mentionFloor)`,
  `RETURN e.id AS id, e.${ENTITY_NAME_PROPERTY} AS name, e.${ENTITY_TYPE_PROPERTY} AS type,`,
  `       e.${MEMORY_PROPERTIES.text} AS text, mentions`,
  // Most mentioned first: the hole the substrate trips over most often is the one worth a
  // question, and a run capped at a couple of entities has to spend them on that.
  'ORDER BY mentions DESC, e.id',
  'LIMIT $limit',
].join('\n');

export async function findUndescribedEntities(
  driver: Driver,
  input: { readonly mentionFloor: number; readonly limit: number },
): Promise<UndescribedEntity[]> {
  if (input.limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    {
      cypher: FIND_UNDESCRIBED_ENTITIES,
      parameters: {
        mentionFloor: toGraphInteger(input.mentionFloor),
        limit: toGraphInteger(input.limit),
      },
    },
    (row: Row) => ({
      id: row.id as string,
      name: (row.name as string | null) ?? '',
      type: (row.type as string | null) ?? '',
      text: (row.text as string | null) ?? '',
      mentions: typeof row.mentions === 'number' ? row.mentions : Number(row.mentions ?? 0),
    }),
  );
}

/**
 * Marks the entity as asked about. The currency test is here because a whole model call runs
 * between the selection read and this write, long enough for a merge or a forget to close the
 * entity, and a stamp on a closed node would silence a question about the identity that
 * absorbed it.
 */
const STAMP_CURIOSITY_ASKED = [
  `MATCH (e:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: $id })`,
  `WHERE ${currentOnly('e')}`,
  `SET e.${CURIOSITY_ASKED_AT_PROPERTY} = $now`,
  'RETURN e.id AS id',
].join('\n');

export async function stampCuriosityAsked(
  driver: Driver,
  input: { readonly id: string; readonly now: Date },
): Promise<boolean> {
  const rows = await runWrite(
    driver,
    {
      cypher: STAMP_CURIOSITY_ASKED,
      parameters: { id: input.id, now: toGraphDateTime(input.now) },
    },
    (row: Row) => row.id as string,
  );
  return rows.length > 0;
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
  `MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: $entityId })`,
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
 *
 * The currency test is here rather than only on the candidate read. Two model calls run between
 * the two, long enough for a merge, an identifier decay, or `aion forget` to close the entity,
 * and this write is an in-place replacement with no bitemporal close to undo it.
 *
 * The append is conditional because an entity whose gloss a correction retired carries no
 * `text` at all (`subject-family.ts`), and Neo4j refuses a list holding a null. This write is
 * what re-derives such a gloss, which is why it also clears the retirement stamp: the node
 * answers again, from the mentions it has now.
 */
const REFRESH_ENTITY_DESCRIPTION = [
  `MATCH (e:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: $id })`,
  `WHERE ${currentOnly('e')}`,
  `SET e.${PRIOR_DESCRIPTIONS_PROPERTY} = CASE WHEN e.${MEMORY_PROPERTIES.text} IS NULL`,
  `      THEN coalesce(e.${PRIOR_DESCRIPTIONS_PROPERTY}, [])`,
  `      ELSE coalesce(e.${PRIOR_DESCRIPTIONS_PROPERTY}, []) + [e.${MEMORY_PROPERTIES.text}] END,`,
  `    e.${MEMORY_PROPERTIES.text} = $text,`,
  `    e.${MEMORY_PROPERTIES.contentVector} = $contentVector,`,
  `    e.${MEMORY_PROPERTIES.contentVectorHash} = $contentVectorHash,`,
  `    e.${DESCRIPTION_MENTION_COUNT_PROPERTY} = $mentionCount,`,
  `    e.${DESCRIPTION_REFRESHED_AT_PROPERTY} = $now,`,
  `    e.${DESCRIPTION_REFRESH_METHOD_PROPERTY} = $method,`,
  `    e.${DESCRIPTION_RETIRED_AT_PROPERTY} = null`,
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
