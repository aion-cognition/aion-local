import neo4j, { type Driver } from 'neo4j-driver';
import type { Vector } from '../../providers/types.js';
import { ACCESS_COUNT_PROPERTY } from '../access-tracking.js';
import { CO_OCCURS_TYPE, SIMILAR_TYPE } from '../association-queries.js';
import { runRead } from '../connection.js';
import { CONTEXT_VECTOR_PROPERTY } from '../context-vector-queries.js';
import { ENTITY_ALIASES_PROPERTY } from '../entity-dedup-queries.js';
import { ENTITY_MENTION_TYPE, ENTITY_PARTICIPATION_TYPE } from '../entity-queries.js';
import { BASE_NODE_LABEL } from '../labels.js';
import { SUPERSEDES_TYPE } from '../relationships.js';
import { LAST_ACCESSED_PROPERTY } from '../seed-queries.js';
import { fromGraphVector, toGraphVector, type Row } from '../values.js';

/**
 * Read-only assertions for integration tests that live outside this directory. Cypher lives
 * in `graph/` without exception, tests included: a query written next to the code it checks
 * is a query that can quietly encode a filter the adapter does not actually apply, and the
 * whole point of the rule is that there is one place to read for what the substrate does.
 */
async function readFirst<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: (row: Row) => T,
): Promise<T | undefined> {
  const rows = await runRead(driver, cypher, parameters, map);
  return rows[0];
}

async function count(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown> = {},
): Promise<number> {
  return (await readFirst(driver, cypher, parameters, (row) => row.c as number)) ?? 0;
}

export async function nodeProperties(driver: Driver, id: string): Promise<Record<string, unknown>> {
  const props = await readFirst(
    driver,
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) RETURN properties(n) AS props`,
    { id },
    (row) => row.props as Record<string, unknown>,
  );
  return props ?? {};
}

export async function nodeLabels(driver: Driver, id: string): Promise<string[]> {
  const labels = await readFirst(
    driver,
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) RETURN labels(n) AS labels`,
    { id },
    (row) => row.labels as string[],
  );
  return [...(labels ?? [])].sort();
}

/** Every property of every node, serialized — what a "the raw secret is nowhere" assertion scans. */
export async function everyStoredProperty(driver: Driver): Promise<string> {
  const rows = await runRead(driver, 'MATCH (n) RETURN properties(n) AS props', {}, (row) => row.props);
  return JSON.stringify(rows);
}

export async function countNodes(driver: Driver): Promise<number> {
  return count(driver, 'MATCH (n) RETURN count(n) AS c');
}

export async function countRelationships(driver: Driver): Promise<number> {
  return count(driver, 'MATCH ()-[r]->() RETURN count(r) AS c');
}

export async function countNodesWithId(driver: Driver, label: string, id: string): Promise<number> {
  return count(driver, `MATCH (n:${label} { id: $id }) RETURN count(n) AS c`, { id });
}

export async function countEdges(
  driver: Driver,
  type: string,
  sourceId: string,
  targetId: string,
): Promise<number> {
  return count(
    driver,
    `MATCH ({ id: $sourceId })-[r:${type}]->({ id: $targetId }) RETURN count(r) AS c`,
    { sourceId, targetId },
  );
}

export async function countOutgoingEdges(
  driver: Driver,
  type: string,
  sourceId: string,
): Promise<number> {
  return count(driver, `MATCH ({ id: $sourceId })-[r:${type}]->() RETURN count(r) AS c`, {
    sourceId,
  });
}

/** The id on the far end of one outgoing edge, for the backbone links a session writes once. */
export async function edgeTargetId(
  driver: Driver,
  type: string,
  sourceId: string,
): Promise<string | undefined> {
  return readFirst(
    driver,
    `MATCH ({ id: $sourceId })-[:${type}]->(target) RETURN target.id AS id`,
    { sourceId },
    (row) => row.id as string,
  );
}

export async function countNodesInSession(
  driver: Driver,
  label: 'Episode' | 'Turn',
  sessionId: string,
): Promise<number> {
  return count(driver, `MATCH (n:${label} { session_id: $sessionId }) RETURN count(n) AS c`, {
    sessionId,
  });
}

export async function episodeIdsInSession(driver: Driver, sessionId: string): Promise<string[]> {
  return runRead(
    driver,
    'MATCH (e:Episode { session_id: $sessionId }) RETURN e.id AS id',
    { sessionId },
    (row) => row.id as string,
  );
}

/** An episode's turns in sequence order, whole, so a test asserts over stored shape rather than a projection. */
export async function turnsOfEpisode(
  driver: Driver,
  episodeId: string,
): Promise<Array<Record<string, unknown>>> {
  return runRead(
    driver,
    [
      'MATCH (t:Turn)-[:PARTICIPATES_IN]->(:Episode { id: $episodeId })',
      'RETURN properties(t) AS props ORDER BY t.sequence',
    ].join('\n'),
    { episodeId },
    (row) => row.props as Record<string, unknown>,
  );
}

export type AccessMetadata = {
  readonly lastAccessed?: Date;
  readonly accessCount?: number;
};

/** Both properties are absent until recall's access-tracking write lands, so both are optional. */
export async function accessMetadata(driver: Driver, id: string): Promise<AccessMetadata> {
  const row = await readFirst(
    driver,
    [
      `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
      `RETURN n.${LAST_ACCESSED_PROPERTY} AS lastAccessed, n.${ACCESS_COUNT_PROPERTY} AS accessCount`,
    ].join('\n'),
    { id },
    (row) => ({
      ...(row.lastAccessed instanceof Date ? { lastAccessed: row.lastAccessed } : {}),
      ...(typeof row.accessCount === 'number' ? { accessCount: row.accessCount } : {}),
    }),
  );
  return row ?? {};
}

export async function countChainedTurns(driver: Driver, episodeId: string): Promise<number> {
  return count(
    driver,
    [
      'MATCH (later:Turn)-[r:FOLLOWS]->(earlier:Turn)',
      'WHERE later.source_episode_id = $episodeId AND earlier.source_episode_id = $episodeId',
      'RETURN count(r) AS c',
    ].join('\n'),
    { episodeId },
  );
}

/**
 * Everything below serves P3's stage integration tests. Their assertions read enrichment the
 * pipeline wrote — entities, mentions, associations, typed edges, context vectors — and each
 * one is a place a test could otherwise encode a filter the adapter does not apply.
 */

export type StoredEntity = {
  readonly id: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly type: string;
  readonly labels: readonly string[];
  readonly text: string | null;
  readonly nameVectorLength: number;
  readonly contentVectorLength: number;
  readonly accessCount: number;
  readonly structural: boolean;
  readonly validUntil: Date | null;
  readonly aliases: readonly string[];
};

const STORED_ENTITY_PROJECTION = [
  'RETURN n.id AS id, n.name AS name, n.name_norm AS name_norm, n.type AS type,',
  '       labels(n) AS labels, n.text AS text,',
  '       size(coalesce(n.name_vec, [])) AS name_vec_length,',
  '       size(coalesce(n.content_vec, [])) AS content_vec_length,',
  '       coalesce(n.access_count, 0) AS access_count,',
  '       coalesce(n.is_structural, false) AS is_structural,',
  '       n.valid_until AS valid_until,',
  `       coalesce(n.${ENTITY_ALIASES_PROPERTY}, []) AS aliases`,
].join('\n');

function mapStoredEntity(row: Row): StoredEntity {
  return {
    id: row.id as string,
    name: row.name as string,
    nameNorm: row.name_norm as string,
    type: row.type as string,
    labels: row.labels as string[],
    text: (row.text ?? null) as string | null,
    nameVectorLength: row.name_vec_length as number,
    contentVectorLength: row.content_vec_length as number,
    accessCount: row.access_count as number,
    structural: row.is_structural === true,
    validUntil: (row.valid_until ?? null) as Date | null,
    aliases: row.aliases as string[],
  };
}

/** Every Entity in the graph, superseded ones included, so a test can assert on both sides of a merge. */
export async function storedEntities(driver: Driver): Promise<StoredEntity[]> {
  return runRead(
    driver,
    ['MATCH (n:Entity)', STORED_ENTITY_PROJECTION, 'ORDER BY n.name_norm, n.type'].join('\n'),
    {},
    mapStoredEntity,
  );
}

export async function storedEntity(driver: Driver, id: string): Promise<StoredEntity | undefined> {
  return readFirst(
    driver,
    ['MATCH (n:Entity { id: $id })', STORED_ENTITY_PROJECTION].join('\n'),
    { id },
    mapStoredEntity,
  );
}

export type MentionCount = {
  readonly id: string;
  readonly count: number;
};

/** One row per entity the episode's `MENTIONS` edges reach, closed ones included. */
export async function mentionCounts(driver: Driver, episodeId: string): Promise<MentionCount[]> {
  return runRead(
    driver,
    [
      `MATCH (:Episode { id: $episodeId })-[r:${ENTITY_MENTION_TYPE}]->(n:Entity)`,
      'RETURN n.id AS id, r.count AS count ORDER BY n.name_norm, n.id',
    ].join('\n'),
    { episodeId },
    (row) => ({ id: row.id as string, count: row.count as number }),
  );
}

export async function participationCount(driver: Driver, episodeId: string): Promise<number> {
  return count(
    driver,
    [
      `MATCH (n:Entity)-[:${ENTITY_PARTICIPATION_TYPE}]->(:Episode { id: $episodeId })`,
      'RETURN count(n) AS c',
    ].join('\n'),
    { episodeId },
  );
}

/** The episodes one entity participates in, which is what a merge redirects onto the canonical. */
export async function participatingEpisodeIds(driver: Driver, entityId: string): Promise<string[]> {
  return runRead(
    driver,
    [
      `MATCH (:Entity { id: $entityId })-[:${ENTITY_PARTICIPATION_TYPE}]->(e:Episode)`,
      'RETURN e.id AS id ORDER BY e.id',
    ].join('\n'),
    { entityId },
    (row) => row.id as string,
  );
}

/** The replacements pointing at a closed node: one id per `SUPERSEDES` edge, so a repeat shows up. */
export async function supersedingNodeIds(driver: Driver, supersededId: string): Promise<string[]> {
  return runRead(
    driver,
    `MATCH (n)-[:${SUPERSEDES_TYPE}]->({ id: $supersededId }) RETURN n.id AS id ORDER BY n.id`,
    { supersededId },
    (row) => row.id as string,
  );
}

export type NamedPair = {
  readonly a: string;
  readonly b: string;
  readonly count: number;
};

/**
 * Matched undirected and ordered by name, not by stored direction: `CO_OCCURS` is one of the
 * undirected types, so the edge upsert normalizes its endpoints by id and entity ids are
 * random per run. The `a.name < b.name` filter keeps the undirected match to one row.
 */
export async function coOccurrencePairs(driver: Driver): Promise<NamedPair[]> {
  return runRead(
    driver,
    [
      `MATCH (a:Entity)-[r:${CO_OCCURS_TYPE}]-(b:Entity)`,
      'WHERE a.name < b.name',
      'RETURN a.name AS a, b.name AS b, r.count AS count ORDER BY a.name, b.name',
    ].join('\n'),
    {},
    (row) => ({ a: row.a as string, b: row.b as string, count: row.count as number }),
  );
}

export type SimilarPair = {
  readonly a: string;
  readonly b: string;
  readonly strength: number;
};

/** Scoped to `names`, since one graph is shared across a file's tests and `SIMILAR` accumulates. */
export async function similarPairsAmong(
  driver: Driver,
  names: readonly string[],
): Promise<SimilarPair[]> {
  return runRead(
    driver,
    [
      `MATCH (a:Entity)-[r:${SIMILAR_TYPE}]->(b:Entity)`,
      'WHERE a.name IN $names AND b.name IN $names',
      'RETURN a.name AS a, b.name AS b, r.strength AS strength ORDER BY a.name, b.name',
    ].join('\n'),
    { names: [...names] },
    (row) => ({ a: row.a as string, b: row.b as string, strength: row.strength as number }),
  );
}

export async function contextVector(driver: Driver, id: string): Promise<Vector | undefined> {
  const raw = await readFirst(
    driver,
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) RETURN n.${CONTEXT_VECTOR_PROPERTY} AS vec`,
    { id },
    (row) => row.vec,
  );
  return fromGraphVector(raw);
}

export type VectorNeighbor = {
  readonly id: string;
  readonly score: number;
};

/** Proves a write actually landed in the named vector index rather than only on the node. */
export async function vectorIndexNeighbors(
  driver: Driver,
  index: string,
  limit: number,
  vector: Vector,
): Promise<VectorNeighbor[]> {
  return runRead(
    driver,
    'CALL db.index.vector.queryNodes($index, $limit, $vector) YIELD node, score RETURN node.id AS id, score',
    { index, limit: neo4j.int(limit), vector: toGraphVector(vector) },
    (row) => ({ id: row.id as string, score: row.score as number }),
  );
}

export type WrittenRelationship = {
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly rationale?: string;
};

/** Every edge one pipeline path wrote, found by the provenance it stamps. */
export async function relationshipsByProvenance(
  driver: Driver,
  method: string,
): Promise<WrittenRelationship[]> {
  return runRead(
    driver,
    [
      'MATCH (a)-[r]->(b)',
      'WHERE $method IN r.provenance',
      'RETURN type(r) AS type, a.id AS sourceId, b.id AS targetId, r.rationale AS rationale',
    ].join('\n'),
    { method },
    (row) => ({
      type: row.type as string,
      sourceId: row.sourceId as string,
      targetId: row.targetId as string,
      ...(typeof row.rationale === 'string' ? { rationale: row.rationale } : {}),
    }),
  );
}
