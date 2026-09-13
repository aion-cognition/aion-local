import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { inWriteTransaction, runRead, runWrite, type GraphTransaction } from './connection.js';
import { ENTITY_MENTION_TYPE, ENTITY_TYPE_PROPERTY } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { GraphNodeNotFoundError } from './errors.js';
import { BASE_NODE_LABEL, ENTITY_LABEL } from './labels.js';
import { lockNodeInTransaction } from './locks.js';
import { ENTITY_NAME_PROPERTY, STRUCTURAL_PROPERTY } from './seed-queries.js';
import { toGraphDateTime, toGraphInteger, toGraphVector, type Row } from './values.js';
import { hashContent } from '../../reflection/domain/content.js';
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

/**
 * The description state one entity is in right now: what it says, what baseline that description
 * was written against, and how many mentions it has.
 *
 * It is the same reading the stale-description scan makes, for one node rather than the
 * population, and it exists because a request that left the machine has to be checked against the
 * substrate before its answer is applied. A batched refresh is asked hours before it is answered,
 * and in that time the entity can be merged away, forgotten, refreshed by another pass, or have
 * its gloss retired by a correction. Each of those makes the answer about a question nobody is
 * asking any more.
 */
const READ_ENTITY_DESCRIPTION_STATE = [
  `MATCH (e:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: $id })`,
  `WHERE ${currentOnly('e')}`,
  `OPTIONAL MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(e)`,
  // `count(ep)` for the reason the population read uses it: an entity with no mention edge still
  // yields one row with `ep` bound to null, which `count(*)` would read as one.
  'WITH e, count(ep) AS mentions',
  `RETURN e.${MEMORY_PROPERTIES.text} AS text, mentions,`,
  `       coalesce(e.${DESCRIPTION_MENTION_COUNT_PROPERTY}, $implicitBaseline) AS baseline`,
].join('\n');

export type EntityDescriptionState = {
  /** Empty where a correction retired the gloss, which is a different question from the one asked. */
  readonly text: string;
  readonly mentions: number;
  readonly baseline: number;
};

export async function readEntityDescriptionState(
  driver: Driver,
  id: string,
): Promise<EntityDescriptionState | undefined> {
  const rows = await runRead(
    driver,
    {
      cypher: READ_ENTITY_DESCRIPTION_STATE,
      parameters: { id, implicitBaseline: toGraphInteger(IMPLICIT_BASELINE_MENTIONS) },
    },
    (row: Row) => ({
      text: (row.text as string | null) ?? '',
      mentions: typeof row.mentions === 'number' ? row.mentions : Number(row.mentions ?? 0),
      baseline: typeof row.baseline === 'number' ? row.baseline : Number(row.baseline ?? 0),
    }),
  );
  return rows[0];
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
 * Which of these mentioning episodes a reader can still see, and what each one now says.
 *
 * A re-synthesis prompt is grounded in the episodes it selected, so what its answer has to be
 * checked against is those ids. A count of whatever mentions the entity carries now is a
 * different question: five sources can go out, one of them can be forgotten while the request is
 * at the remote, and four will still be standing when the answer lands. The text comes back with
 * the id because a readable id is not the input the model was given.
 */
const FIND_READABLE_MENTION_SOURCES = [
  `MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: $entityId })`,
  `WHERE ep.id IN $episodeIds AND ep.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `RETURN ep.id AS episode_id, coalesce(ep.${MEMORY_PROPERTIES.summary}, ep.${MEMORY_PROPERTIES.text}) AS text`,
].join('\n');

/** One episode the prompt quoted, as the prompt read it. */
export type QuotedMentionSource = {
  readonly episodeId: string;
  readonly text: string;
};

function toQuotedSource(row: Row): QuotedMentionSource {
  return { episodeId: row.episode_id as string, text: (row.text as string | null) ?? '' };
}

export async function readableMentionSources(
  driver: Driver,
  entityId: string,
  episodeIds: readonly string[],
): Promise<QuotedMentionSource[]> {
  if (episodeIds.length === 0) {
    return [];
  }
  return runRead(
    driver,
    {
      cypher: FIND_READABLE_MENTION_SOURCES,
      parameters: { entityId, episodeIds: [...episodeIds] },
    },
    toQuotedSource,
  );
}

/**
 * The selected sources in the order they were quoted, or nothing where one of them is no longer
 * readable. Order is part of it: the prompt numbers its excerpts, so the same five episodes in
 * another order are a different reading.
 */
export function quotedMentionSources(
  selected: readonly string[],
  readable: readonly QuotedMentionSource[],
): readonly QuotedMentionSource[] | undefined {
  const byId = new Map(readable.map((source) => [source.episodeId, source.text]));
  const quoted: QuotedMentionSource[] = [];
  for (const episodeId of selected) {
    const text = byId.get(episodeId);
    if (text === undefined) {
      return undefined;
    }
    quoted.push({ episodeId, text });
  }
  return quoted;
}

/**
 * What the prompt read, as one value: the selected episodes and their text.
 *
 * The ids alone do not describe it. An episode can be rewritten while a request about it is at
 * the remote, and an answer checked against ids would publish a sentence derived from text the
 * store no longer holds.
 */
export function mentionSourceDigest(sources: readonly QuotedMentionSource[]): string {
  return hashContent(sources.map((source) => [source.episodeId, source.text]));
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
 * A caller that is publishing an answer about a gloss it read earlier names that gloss and the
 * sources the answer was grounded in, and both are tested under the entity's own lock rather
 * than before it. The window between any check and this write holds an embed, and a description
 * another pass committed in that window must not be overwritten by the answer to the older
 * question. `$expectedText` and `$sourceCount` are null for a caller writing a description it
 * derived from the node it is looking at, which has no earlier reading to defend.
 *
 * The append is conditional because an entity whose gloss a correction retired carries no
 * `text` at all (`subject-family.ts`), and Neo4j refuses a list holding a null. This write is
 * what re-derives such a gloss, which is why it also clears the retirement stamp: the node
 * answers again, from the mentions it has now.
 */
const REFRESH_ENTITY_DESCRIPTION = [
  `MATCH (e:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: $id })`,
  `WHERE ${currentOnly('e')}`,
  `  AND ($expectedText IS NULL OR coalesce(e.${MEMORY_PROPERTIES.text}, '') = $expectedText)`,
  `OPTIONAL MATCH (ep:Episode)-[:${ENTITY_MENTION_TYPE}]->(e)`,
  `  WHERE ep.id IN $sources AND ep.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  // Distinct, because one episode reaching the entity twice is one readable source.
  'WITH e, count(DISTINCT ep) AS readable',
  'WHERE $sourceCount IS NULL OR readable = $sourceCount',
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
  /** The gloss this answer revised. The write matches only while the node still says it. */
  readonly expectedText?: string;
  /** The mentions the answer was grounded in. The write matches only while all are readable. */
  readonly sources?: readonly string[];
  /** What those mentions said where the request was built, re-read and compared under the lock. */
  readonly expectedSourceDigest?: string;
};

/**
 * The sources still say what the answer was written from. A caller that named no digest has
 * nothing to defend.
 */
async function quotesTheSameSources(
  tx: GraphTransaction,
  input: RefreshEntityDescriptionInput,
): Promise<boolean> {
  if (input.expectedSourceDigest === undefined) {
    return true;
  }
  const selected = input.sources ?? [];
  const readable = await tx.run(
    FIND_READABLE_MENTION_SOURCES,
    { entityId: input.id, episodeIds: [...selected] },
    toQuotedSource,
  );
  const quoted = quotedMentionSources(selected, readable);
  return quoted !== undefined && mentionSourceDigest(quoted) === input.expectedSourceDigest;
}

/**
 * Everything the decision rests on is read, compared and written inside one transaction holding
 * the entity's own lock.
 *
 * A single statement carrying both the test and the write does not serialize two writers: Neo4j
 * takes no lock for the match, so two of them naming the same expected gloss can both pass it and
 * both write, and the second answer silently replaces the first. Taking the lock first is what
 * makes whichever writer arrives second read what the first committed (`locks.ts`).
 *
 * An id that names no node at all is not an error here. The entity was absorbed or forgotten
 * while its answer was at the remote, which is the same refusal as a gloss that moved.
 */
export async function refreshEntityDescription(
  driver: Driver,
  input: RefreshEntityDescriptionInput,
): Promise<boolean> {
  return inWriteTransaction(driver, async (tx) => {
    try {
      await lockNodeInTransaction(tx, input.id, input.now);
    } catch (err) {
      if (err instanceof GraphNodeNotFoundError) {
        return false;
      }
      throw err;
    }
    if (!(await quotesTheSameSources(tx, input))) {
      return false;
    }
    const rows = await tx.run(
      REFRESH_ENTITY_DESCRIPTION,
      {
        id: input.id,
        text: input.text,
        contentVector: toGraphVector(input.contentVector),
        contentVectorHash: vectorInputHash(input.text),
        mentionCount: toGraphInteger(input.mentionCount),
        now: toGraphDateTime(input.now),
        method: DESCRIPTION_REFRESH_METHOD,
        expectedText: input.expectedText ?? null,
        sources: [...(input.sources ?? [])],
        sourceCount:
          input.sources === undefined ? null : toGraphInteger(new Set(input.sources).size),
      },
      (row: Row) => row.id as string,
    );
    return rows.length > 0;
  });
}
