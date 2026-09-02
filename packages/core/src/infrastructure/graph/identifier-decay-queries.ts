import neo4j, { type Driver } from 'neo4j-driver';

import { CO_OCCURS_TYPE } from './association-queries.js';
import { BITEMPORAL_PROPERTIES, CLOSURE_PROVENANCE_PROPERTY, closeFragment } from './bitemporal.js';
import { runRead, runWrite, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE, ENTITY_TYPE_PROPERTY } from './entity-queries.js';
import { GraphWriteError } from './errors.js';
import { ENTITY_LABEL } from './labels.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * The graph half of `identifier_decay`: finding candidate identifier-shaped entities and
 * closing the ones eligibility settles on. Shape classification itself is pure TypeScript
 * (`introspection/domain/identifier-shape.ts`); this module only reads what the classifier and
 * the protection rules need and writes the close.
 *
 * Closing reuses the same two primitives every other close in this file uses:
 * `BITEMPORAL_PROPERTIES` and `closeFragment` from `bitemporal.ts`. There is no single
 * `closeNode` call every close path shares (`forgetNarrative` and `edge-prune-queries.ts`'s
 * `buildEdgePruneClose` each compose their own statement from those two primitives), so this
 * does the same rather than inventing a third shape of close: the entity's own bitemporal close
 * is `forgetNarrative`'s pattern (`forgotten_at` plus `closeFragment`, the "full extent" of a
 * node's own timeline, as opposed to `forgetNode`'s `forgotten_at`-only suppression), and its
 * incident `MENTIONS`/`CO_OCCURS` edges close the same way `edge-prune-queries.ts` closes an
 * association edge. It also stamps `CLOSURE_PROVENANCE_PROPERTY` (`bitemporal.ts`), which
 * `forgetNarrative` does not: this close is a bet on silence, not a verdict, and the marker is
 * what lets `entity-queries.ts`'s `buildEntityMerge` reopen the node on the next real mention
 * instead of leaving it closed under a live edge nothing can see.
 */

/** The value `CLOSURE_PROVENANCE_PROPERTY` is stamped with, naming this operation as the closer. */
const CLOSED_BY_IDENTIFIER_DECAY = 'identifier_decay';

/** A typed knowledge claim on an entity, the exemption's other half of "load-bearing". `DERIVES_FROM`
 * in practice only ever runs `(Narrative)-[:DERIVES_FROM]->(Session)` (`narrative-queries.ts`), so
 * it never touches an Entity today, and the check costs nothing to keep. `CAUSES`/`ENABLES`/
 * `PRECEDES` are the semantic-relationship catalog's own directed claims about an entity.
 * `CONTRADICTS`/`SIMILAR`/`RELATED_TO`/`ANALOGOUS_TO` are deliberately excluded: they are
 * association-shaped (the first two already governed by `edge_prune`), and an entity picks one up
 * just by being vector-similar to something, which would exempt most of the graph. */
const TYPED_KNOWLEDGE_TYPES = ['CAUSES', 'ENABLES', 'PRECEDES', 'DERIVES_FROM'];

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GraphWriteError(`${name} must be a positive integer, received ${value}`);
  }
}

export type IdentifierDecayCandidate = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Distinct episodes with a current `MENTIONS` edge to this entity. */
  readonly episodeMentions: number;
  /** Latest `MENTIONS.updated_at` among this entity's current mention edges. */
  readonly lastMentionAt?: Date;
  /** An outgoing `SUPERSEDES` edge: this entity absorbed a duplicate and other surface forms
   * still resolve to it through `entity-queries.ts`'s merge chain walk. */
  readonly isMergeCanonicalTarget: boolean;
  readonly hasTypedKnowledgeEdge: boolean;
};

/**
 * "Last mention" reads the `MENTIONS` edge stamp (`updated_at`, the property every edge write
 * sets, `edges.ts`), not entity access tracking (`access_count`/`last_accessed`). The edge scan
 * is already the one this query has to do to close `MENTIONS` edges later, where access
 * tracking would be a second read of a property recall also bumps
 * (`entity-dedup-queries.ts`'s own note on `mentionCount`), so it answers a question the mention
 * edges do not: whether the graph was ever asked about this entity, not whether the reflection
 * pipeline last wrote it.
 */
export function buildCandidatesStatement(batchSize: number): GraphStatement {
  assertPositiveInt('batchSize', batchSize);
  const cypher = [
    `MATCH (n:${ENTITY_LABEL})`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
    `OPTIONAL MATCH (e:Episode)-[m:${ENTITY_MENTION_TYPE}]->(n)`,
    `WHERE m.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    'WITH n, count(DISTINCT e) AS episode_mentions, max(m.updated_at) AS last_mention_at',
    `RETURN n.id AS id, n.name AS name, n.${ENTITY_TYPE_PROPERTY} AS type,`,
    '       episode_mentions, last_mention_at,',
    `       EXISTS { (n)-[:${SUPERSEDES_TYPE}]->(:${ENTITY_LABEL}) } AS is_canonical_target,`,
    '       EXISTS { MATCH (n)-[r]-() WHERE type(r) IN $typedKnowledgeTypes } AS has_typed_knowledge',
    'ORDER BY n.id',
    'LIMIT $batchSize',
  ].join('\n');
  return {
    cypher,
    parameters: {
      typedKnowledgeTypes: TYPED_KNOWLEDGE_TYPES,
      batchSize: neo4j.int(batchSize),
    },
  };
}

function mapCandidate(row: Row): IdentifierDecayCandidate {
  const lastMentionAt = row.last_mention_at;
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? '',
    type: (row.type as string | null) ?? '',
    episodeMentions: (row.episode_mentions as number | null) ?? 0,
    ...(lastMentionAt instanceof Date ? { lastMentionAt } : {}),
    isMergeCanonicalTarget: row.is_canonical_target === true,
    hasTypedKnowledgeEdge: row.has_typed_knowledge === true,
  };
}

/** Current entities up to `batchSize`, oldest id first, with what the eligibility check needs. */
export async function findIdentifierDecayCandidates(
  driver: Driver,
  batchSize: number,
): Promise<IdentifierDecayCandidate[]> {
  const statement = buildCandidatesStatement(batchSize);
  return runRead(driver, statement.cypher, statement.parameters, mapCandidate);
}

export type EntityNaming = {
  readonly name: string;
  readonly type: string;
};

/**
 * Every current entity's name and type, for the health snapshot's identifier-shaped count.
 * Shape classification is pure TypeScript (`introspection/domain/identifier-shape.ts`) and the
 * patterns live there alone, so the count reads names out and classifies them above rather than
 * growing a second copy of the patterns in Cypher. Bounded by `limit`, which makes the count a
 * floor on a substrate larger than the scan.
 */
export function buildEntityNamingStatement(limit: number): GraphStatement {
  assertPositiveInt('limit', limit);
  const cypher = [
    `MATCH (n:${ENTITY_LABEL})`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
    `RETURN n.name AS name, n.${ENTITY_TYPE_PROPERTY} AS type`,
    'ORDER BY n.id',
    'LIMIT $limit',
  ].join('\n');
  return { cypher, parameters: { limit: neo4j.int(limit) } };
}

export async function readCurrentEntityNamings(
  driver: Driver,
  limit: number,
): Promise<EntityNaming[]> {
  const statement = buildEntityNamingStatement(limit);
  return runRead(driver, statement.cypher, statement.parameters, (row: Row) => ({
    name: (row.name as string | null) ?? '',
    type: (row.type as string | null) ?? '',
  }));
}

export type ClosedIdentifierEntity = {
  readonly id: string;
  readonly mentionsClosed: number;
  readonly coOccursClosed: number;
};

/**
 * Closes each named entity to the full extent of its own bitemporal timeline (`forgotten_at`
 * plus `valid_until`/`tx_until`, `forgetNarrative`'s pattern), stamps `closed_by` so the close
 * reads as this operation's rather than a forget, and closes every current `MENTIONS` or
 * `CO_OCCURS` edge touching it, in one write per batch. Node and edges close together for the
 * same reason `redirectAndAbsorb` redirects and closes inside one transaction
 * (`entity-dedup-queries.ts`): a node stripped of its edges but still reading as an open
 * timeline, or the reverse, is a state the substrate should never show.
 *
 * `$now IS NULL` guards are implicit in `closeFragment`'s own `coalesce`, so a row this call
 * has already closed (a retried batch, an id repeated by a caller error) is a no-op rather than
 * a timestamp bump.
 */
export function buildCloseStatement(ids: readonly string[], now: Date): GraphStatement {
  if (ids.length === 0) {
    throw new GraphWriteError('identifier decay close needs at least one entity id');
  }
  const cypher = [
    'UNWIND $ids AS id',
    `MATCH (n:${ENTITY_LABEL} { id: id })`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
    `SET n.${BITEMPORAL_PROPERTIES.forgottenAt} = coalesce(n.${BITEMPORAL_PROPERTIES.forgottenAt}, $now),`,
    `    n.${CLOSURE_PROVENANCE_PROPERTY} = coalesce(n.${CLOSURE_PROVENANCE_PROPERTY}, $closedBy),`,
    `    ${closeFragment('n')}`,
    'WITH n',
    `OPTIONAL MATCH (:Episode)-[m:${ENTITY_MENTION_TYPE}]->(n)`,
    `WHERE m.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `SET ${closeFragment('m')}`,
    'WITH n, count(m) AS mentions_closed',
    `OPTIONAL MATCH (n)-[c:${CO_OCCURS_TYPE}]-(:${ENTITY_LABEL})`,
    `WHERE c.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `SET ${closeFragment('c')}`,
    'RETURN n.id AS id, mentions_closed, count(c) AS co_occurs_closed',
  ].join('\n');
  return {
    cypher,
    parameters: {
      ids: [...ids],
      now: toGraphDateTime(now),
      // A decay close is a bet on silence taken at the sweep, so both timelines end there.
      validUntil: toGraphDateTime(now),
      txUntil: toGraphDateTime(now),
      closedBy: CLOSED_BY_IDENTIFIER_DECAY,
    },
  };
}

function mapClosedEntity(row: Row): ClosedIdentifierEntity {
  return {
    id: row.id as string,
    mentionsClosed: row.mentions_closed as number,
    coOccursClosed: row.co_occurs_closed as number,
  };
}

export async function closeIdentifierEntities(
  driver: Driver,
  ids: readonly string[],
  now: Date,
): Promise<ClosedIdentifierEntity[]> {
  const statement = buildCloseStatement(ids, now);
  return runWrite(driver, statement.cypher, statement.parameters, mapClosedEntity);
}
