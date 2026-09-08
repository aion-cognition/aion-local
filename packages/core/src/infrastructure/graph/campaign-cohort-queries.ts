import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-mention-queries.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { assertPositiveInt } from './errors.js';
import { ENTITY_LABEL, EXTRACTION_TYPE } from './labels.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import { toGraphInteger } from './values.js';

/**
 * Read-only reads that freeze a comparison cohort and take the baselines an operation's own
 * tally can never reconstruct.
 *
 * Every walk here pages on a stable key with an explicit continuation, never on an offset: the
 * substrate keeps taking writes while an export runs, and an offset into a moving population
 * skips members and repeats others. Nothing in this file writes.
 */

/**
 * Either the one member a key names, or the page after a cursor. A recovery asks for a key
 * outright: the cursor has already moved past the row it owes, and no ordering trick reaches
 * one arbitrary string id from another.
 */
function keyOrCursor(column: string): string {
  return [
    `WHERE ($exactKey IS NOT NULL AND ${column} = $exactKey)`,
    `   OR ($exactKey IS NULL AND ($cursor IS NULL OR ${column} > $cursor))`,
  ].join('\n');
}

function keyedParameters(
  limit: number,
  cursor: string | undefined,
  exactKey: string | undefined,
): Record<string, unknown> {
  return {
    limit: toGraphInteger(limit),
    cursor: cursor ?? null,
    exactKey: exactKey ?? null,
  };
}

/** One summarization edge and the state of the narrative it points at. */
export type NarrativeEdgeState = {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  /** The edge itself is still open, which is the only way it can be traversed. */
  readonly open: boolean;
  /** The narrative no longer stands, which is what makes an open edge into it stale. */
  readonly targetClosed: boolean;
};

/**
 * A page of summarization edges by edge id, open and closed alike. The closed ones are what
 * lets a later read tell a repair from a removal: an edge that is simply absent is a different
 * result from one this walk found closed.
 */
export function buildNarrativeEdgeStatePage(
  limit: number,
  cursor?: string,
  exactKey?: string,
): GraphStatement {
  assertPositiveInt('limit', limit);
  const { validUntil } = BITEMPORAL_PROPERTIES;
  const cypher = [
    `MATCH (s)-[r:${SUMMARIZED_BY_TYPE}]->(n:Narrative)`,
    keyOrCursor('r.id'),
    'WITH r, s, n ORDER BY r.id ASC LIMIT $limit',
    'RETURN r.id AS id, s.id AS sourceId, n.id AS targetId,',
    `       r.${validUntil} IS NULL AS open, n.${validUntil} IS NOT NULL AS targetClosed`,
  ].join('\n');

  return { cypher, parameters: keyedParameters(limit, cursor, exactKey) };
}

export async function readNarrativeEdgeStatePage(
  driver: Driver,
  limit: number,
  cursor?: string,
  exactKey?: string,
): Promise<readonly NarrativeEdgeState[]> {
  return runRead(driver, buildNarrativeEdgeStatePage(limit, cursor, exactKey), (row) => ({
    id: (row.id as string | null) ?? '',
    sourceId: (row.sourceId as string | null) ?? '',
    targetId: (row.targetId as string | null) ?? '',
    open: row.open === true,
    targetClosed: row.targetClosed === true,
  }));
}

/** One graph source and the fields a bounded export records for it. */
export type GraphSourceRow = {
  readonly id: string;
  readonly sessionId: string;
  readonly occurredAt?: string;
  readonly turnCount: number;
  /** Characters of stored episode text, which is what a serialized page is priced on. */
  readonly textLength: number;
  readonly enriched: boolean;
};

/**
 * A page of episodes by id. `size()` on the text rather than the text itself: the export
 * measures how large a member is without pulling the payload through the driver, and the
 * payload has its own named export when one member is over a page ceiling.
 */
export function buildGraphSourcePage(
  limit: number,
  cursor?: string,
  exactKey?: string,
): GraphStatement {
  assertPositiveInt('limit', limit);
  const cypher = [
    'MATCH (e:Episode)',
    keyOrCursor('e.id'),
    'WITH e ORDER BY e.id ASC LIMIT $limit',
    `OPTIONAL MATCH (t:Turn)-[:${CONTAINMENT_TYPE}]->(e)`,
    'WITH e, count(t) AS turns',
    'RETURN e.id AS id,',
    `       e.${MEMORY_PROPERTIES.sessionId} AS sessionId,`,
    `       toString(e.${BITEMPORAL_PROPERTIES.occurredAt}) AS occurredAt,`,
    `       turns, size(coalesce(e.${MEMORY_PROPERTIES.text}, "")) AS textLength,`,
    `       EXISTS { MATCH ()-[:${EXTRACTION_TYPE}]->(e) } AS enriched`,
  ].join('\n');

  return { cypher, parameters: keyedParameters(limit, cursor, exactKey) };
}

export async function readGraphSourcePage(
  driver: Driver,
  limit: number,
  cursor?: string,
  exactKey?: string,
): Promise<readonly GraphSourceRow[]> {
  return runRead(driver, buildGraphSourcePage(limit, cursor, exactKey), (row) => {
    const { occurredAt } = row;
    return {
      id: (row.id as string | null) ?? '',
      sessionId: (row.sessionId as string | null) ?? '',
      ...(typeof occurredAt === 'string' ? { occurredAt } : {}),
      turnCount: (row.turns as number | null) ?? 0,
      textLength: (row.textLength as number | null) ?? 0,
      enriched: row.enriched === true,
    };
  });
}

/** How many current entities carry each open mention count. */
export type MentionBucket = {
  readonly mentions: number;
  readonly entities: number;
};

/**
 * The mention-count distribution over current entities, bounded by the same kind of scan
 * ceiling the health counts use so one large substrate cannot turn this into an unbounded
 * walk. A caller reports the ceiling beside the numbers: a distribution taken over a prefix
 * describes the prefix.
 */
export function buildEntityMentionDistribution(limit: number): GraphStatement {
  assertPositiveInt('limit', limit);
  const cypher = [
    `MATCH (e:${ENTITY_LABEL})`,
    `WHERE ${currentOnly('e')}`,
    'WITH e LIMIT $limit',
    `OPTIONAL MATCH (:Episode)-[m:${ENTITY_MENTION_TYPE}]->(e)`,
    `WHERE m.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    'WITH e, count(m) AS mentions',
    'RETURN mentions, count(e) AS entities ORDER BY mentions ASC',
  ].join('\n');

  return { cypher, parameters: { limit: toGraphInteger(limit) } };
}

export async function readEntityMentionDistribution(
  driver: Driver,
  limit: number,
): Promise<readonly MentionBucket[]> {
  return runRead(driver, buildEntityMentionDistribution(limit), (row) => ({
    mentions: (row.mentions as number | null) ?? 0,
    entities: (row.entities as number | null) ?? 0,
  }));
}

export type RelationshipTypeCount = {
  readonly type: string;
  readonly open: number;
  readonly closed: number;
};

/**
 * Every relationship type with its open and closed halves. The split is the point: a closed
 * edge is still stored mass and still costs a restore, and a report that counts only open
 * edges reads a bitemporal close as a removal.
 */
export function buildRelationshipTypeCounts(): GraphStatement {
  const { validUntil } = BITEMPORAL_PROPERTIES;
  const cypher = [
    'MATCH ()-[r]->()',
    'WITH type(r) AS type,',
    `     count(CASE WHEN r.${validUntil} IS NULL THEN 1 END) AS open,`,
    `     count(CASE WHEN r.${validUntil} IS NOT NULL THEN 1 END) AS closed`,
    'RETURN type, open, closed ORDER BY type ASC',
  ].join('\n');

  return { cypher, parameters: {} };
}

export async function readRelationshipTypeCounts(
  driver: Driver,
): Promise<readonly RelationshipTypeCount[]> {
  return runRead(driver, buildRelationshipTypeCounts(), (row) => ({
    type: (row.type as string | null) ?? '',
    open: (row.open as number | null) ?? 0,
    closed: (row.closed as number | null) ?? 0,
  }));
}

export type NarrativeRow = {
  readonly id: string;
  readonly sessionId: string;
  readonly open: boolean;
  readonly validUntil?: string;
};

/**
 * A page of Narrative nodes by id, standing and closed alike.
 *
 * Enumerated from the label rather than from the endpoints of summarization edges. A narrative
 * whose source edges are gone still occupies the substrate, still has to be accounted for by
 * cleanup and by any eviction comparison, and reading membership off the edges is exactly how
 * such a record goes missing from the census that is supposed to find it.
 */
export function buildNarrativePage(
  limit: number,
  cursor?: string,
  exactKey?: string,
): GraphStatement {
  assertPositiveInt('limit', limit);
  const { validUntil } = BITEMPORAL_PROPERTIES;
  const cypher = [
    'MATCH (n:Narrative)',
    keyOrCursor('n.id'),
    'WITH n ORDER BY n.id ASC LIMIT $limit',
    `RETURN n.id AS id, n.${MEMORY_PROPERTIES.sessionId} AS sessionId,`,
    `       n.${validUntil} IS NULL AS open, toString(n.${validUntil}) AS validUntil`,
  ].join('\n');

  return { cypher, parameters: keyedParameters(limit, cursor, exactKey) };
}

export async function readNarrativePage(
  driver: Driver,
  limit: number,
  cursor?: string,
  exactKey?: string,
): Promise<readonly NarrativeRow[]> {
  return runRead(driver, buildNarrativePage(limit, cursor, exactKey), (row) => {
    const { validUntil } = row;
    return {
      id: (row.id as string | null) ?? '',
      sessionId: (row.sessionId as string | null) ?? '',
      open: row.open === true,
      ...(typeof validUntil === 'string' ? { validUntil } : {}),
    };
  });
}
