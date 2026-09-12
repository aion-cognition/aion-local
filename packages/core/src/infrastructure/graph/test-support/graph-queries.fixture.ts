import neo4j, { type Driver } from 'neo4j-driver';

import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
} from '../../../reflection/domain/claim-key.js';
import type { Vector } from '../../providers/types.js';
import { ACCESS_COUNT_PROPERTY } from '../access-tracking.js';
import { CO_OCCURS_TYPE, SIMILAR_TYPE } from '../association-queries.js';
import { BITEMPORAL_PROPERTIES, closeRelationshipFragment } from '../bitemporal.js';
import { readFirst, runRead, runWrite } from '../connection.js';
import { CONTEXT_VECTOR_PROPERTY } from '../context-vector-queries.js';
import { DECAYED_AT_PROPERTY } from '../edge-weights.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_ALIASES_PROPERTY,
  ENTITY_MENTION_TYPE,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_PARTICIPATION_TYPE,
  ENTITY_TYPE_COUNTS_PROPERTY,
} from '../entity-queries.js';
import { MEMORY_PROPERTIES } from '../episodes.js';
import { BASE_NODE_LABEL, ENTITY_LABEL, EXTRACTION_TYPE } from '../labels.js';
import { SUPERSEDES_TYPE } from '../relationships.js';
import { LAST_ACCESSED_PROPERTY } from '../seed-queries.js';
import { fromGraphVector, toGraphDateTime, toGraphVector, type Row } from '../values.js';

/**
 * Read-only assertions for integration tests that live outside this directory. Cypher lives
 * in `graph/` without exception, tests included: a query written next to the code it checks
 * is a query that can quietly encode a filter the adapter does not actually apply, and the
 * whole point of the rule is that there is one place to read for what the substrate does.
 */
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

/** Every property of every node, serialized: what a "the raw secret is nowhere" assertion scans. */
export async function everyStoredProperty(driver: Driver): Promise<string> {
  const rows = await runRead(
    driver,
    'MATCH (n) RETURN properties(n) AS props',
    {},
    (row) => row.props,
  );
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

/**
 * Edges of one type into a node that are still open, which is what a reader with no vantage sees.
 * A superseded narrative keeps its rows and they stop being current, so a count that ignored
 * `valid_until` could not tell a closed version from one still summarizing its session.
 */
export async function countOpenEdgesInto(
  driver: Driver,
  type: string,
  targetId: string,
): Promise<number> {
  return count(
    driver,
    `MATCH ()-[r:${type}]->({ id: $targetId })
     WHERE r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL
     RETURN count(r) AS c`,
    { targetId },
  );
}

/**
 * Moves one node's id, which is how a test produces the state a records-say-resident source with
 * no projection is in without removing anything. Reversible by moving it back, and there is no
 * deletion in the workspace to reach for: closing and forgetting are what retire a node.
 */
export async function renameNodeId(driver: Driver, from: string, to: string): Promise<void> {
  await runWrite(driver, `MATCH (n { id: $from }) SET n.id = $to`, { from, to }, () => undefined);
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

/**
 * Every narrative a session holds, whatever family wrote it.
 *
 * `findSessionNarratives` selects the legacy session overview by predicate, so a test asking
 * only whether a close narrated at all reads nothing once the session is on the chunk family.
 * The session is matched the way the family reader matches it: by the property or by the edge,
 * because the two families do not agree on which one they write.
 */
export async function narrativeIdsInSession(driver: Driver, sessionId: string): Promise<string[]> {
  return runRead(
    driver,
    `MATCH (n:Narrative)
     WHERE (n.session_id = $sessionId OR EXISTS { (n)-[:DERIVES_FROM]->(:Session { id: $sessionId }) })
       AND n.forgotten_at IS NULL
     RETURN n.id AS id`,
    { sessionId },
    (row) => row.id as string,
  );
}

/** An episode's turns in sequence order, whole, so a test asserts over stored shape rather than a projection. */
export async function turnsOfEpisode(
  driver: Driver,
  episodeId: string,
): Promise<Record<string, unknown>[]> {
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
    (mapped) => ({
      ...(mapped.lastAccessed instanceof Date ? { lastAccessed: mapped.lastAccessed } : {}),
      ...(typeof mapped.accessCount === 'number' ? { accessCount: mapped.accessCount } : {}),
    }),
  );
  return row ?? {};
}

/**
 * Access stamps back to absent, which is the state a node carries before any recall has
 * surfaced it. A graph rebuilt from the experience archive has every fact and none of these,
 * so this is the half a usage replay has to put back.
 */
export async function clearAccessMetadata(driver: Driver, ids: readonly string[]): Promise<void> {
  await runWrite(
    driver,
    [
      'UNWIND $ids AS nodeId',
      `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })`,
      `SET n.${LAST_ACCESSED_PROPERTY} = null, n.${ACCESS_COUNT_PROPERTY} = null`,
    ].join('\n'),
    { ids: [...ids] },
    () => undefined,
  );
}

/**
 * One edge's weight back to a named value with no record of a sweep having visited it, the
 * same rebuild state for the other half of what plasticity writes. Keyed by id and type rather
 * than by name, since a replay names node ids.
 */
export async function resetEdgePlasticity(
  driver: Driver,
  type: string,
  sourceId: string,
  targetId: string,
  strength: number,
): Promise<void> {
  await runWrite(
    driver,
    [
      `MATCH ({ id: $sourceId })-[r:${type}]-({ id: $targetId })`,
      `SET r.strength = $strength, r.${DECAYED_AT_PROPERTY} = null`,
    ].join('\n'),
    { sourceId, targetId, strength },
    () => undefined,
  );
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
 * Everything below serves the stage integration tests. Their assertions read enrichment the
 * pipeline wrote (entities, mentions, associations, typed edges, context vectors), and each
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
  readonly aliasesNorm: readonly string[];
  readonly nameSquash: string | null;
  readonly typeCounts: string | null;
};

const STORED_ENTITY_PROJECTION = [
  'RETURN n.id AS id, n.name AS name, n.name_norm AS name_norm, n.type AS type,',
  '       labels(n) AS labels, n.text AS text,',
  '       size(coalesce(n.name_vec, [])) AS name_vec_length,',
  '       size(coalesce(n.content_vec, [])) AS content_vec_length,',
  '       coalesce(n.access_count, 0) AS access_count,',
  '       coalesce(n.is_structural, false) AS is_structural,',
  '       n.valid_until AS valid_until,',
  `       coalesce(n.${ENTITY_ALIASES_PROPERTY}, []) AS aliases,`,
  `       coalesce(n.${ENTITY_ALIASES_NORM_PROPERTY}, []) AS aliases_norm,`,
  `       n.${ENTITY_NAME_SQUASH_PROPERTY} AS name_squash,`,
  `       n.${ENTITY_TYPE_COUNTS_PROPERTY} AS type_counts`,
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
    aliasesNorm: row.aliases_norm as string[],
    nameSquash: (row.name_squash ?? null) as string | null,
    typeCounts: (row.type_counts ?? null) as string | null,
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

export type SupersessionEdge = {
  readonly sourceId: string;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
};

/** The `SUPERSEDES` edge into a closed node, with the signals and provenance a close stamps on it. */
export async function supersessionEdge(
  driver: Driver,
  supersededId: string,
): Promise<SupersessionEdge | undefined> {
  return readFirst(
    driver,
    [
      `MATCH (n)-[r:${SUPERSEDES_TYPE}]->({ id: $supersededId })`,
      'RETURN n.id AS sourceId, r.signals AS signals, r.provenance AS provenance',
    ].join('\n'),
    { supersededId },
    (row) => ({
      sourceId: row.sourceId as string,
      signals: (row.signals as string[] | null) ?? [],
      provenance: (row.provenance as string[] | null) ?? [],
    }),
  );
}

export type NamedPair = {
  readonly a: string;
  readonly b: string;
  readonly count: number;
  readonly strength: number;
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
      'RETURN a.name AS a, b.name AS b, r.count AS count, r.strength AS strength',
      'ORDER BY a.name, b.name',
    ].join('\n'),
    {},
    (row) => ({
      a: row.a as string,
      b: row.b as string,
      count: row.count as number,
      strength: row.strength as number,
    }),
  );
}

/** Forces one `CO_OCCURS` edge's strength directly, so a decay test does not have to wait out real time. */
export async function setCoOccursStrength(
  driver: Driver,
  aName: string,
  bName: string,
  strength: number,
): Promise<void> {
  await runWrite(
    driver,
    `MATCH (a:Entity { name: $aName })-[r:${CO_OCCURS_TYPE}]-(b:Entity { name: $bName }) SET r.strength = $strength`,
    { aName, bName, strength },
    () => undefined,
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

/**
 * The weight on the edge of one type between two nodes, whichever way it points, which is
 * what the plasticity operations move. Undirected for the reason reinforcement is: the
 * signal says two memories fired together and nothing about endpoint order.
 */
export async function edgeStrength(
  driver: Driver,
  type: string,
  sourceId: string,
  targetId: string,
): Promise<number | undefined> {
  return readFirst(
    driver,
    `MATCH ({ id: $sourceId })-[r:${type}]-({ id: $targetId }) RETURN r.strength AS strength`,
    { sourceId, targetId },
    (row) => row.strength as number,
  );
}

/**
 * The world time one edge stopped holding, undefined while it is still open. Directed, unlike
 * `edgeStrength`: a bitemporal close is about the relationship the writer stated, so the
 * assertion reads it the way the writer wrote it.
 */
export async function edgeValidUntil(
  driver: Driver,
  type: string,
  sourceId: string,
  targetId: string,
): Promise<Date | undefined> {
  return readFirst(
    driver,
    [
      `MATCH ({ id: $sourceId })-[r:${type}]->({ id: $targetId })`,
      `RETURN r.${BITEMPORAL_PROPERTIES.validUntil} AS validUntil`,
    ].join('\n'),
    { sourceId, targetId },
    // An absent property reads back as null, and an open interval is an absent property.
    (row) => (row.validUntil instanceof Date ? row.validUntil : undefined),
  );
}

/**
 * Closes one edge outright, so a traversal test can start from a substrate that already holds
 * a closed relationship without replaying the operation that closed it.
 */
export async function closeEdge(
  driver: Driver,
  type: string,
  sourceId: string,
  targetId: string,
  at: Date,
): Promise<void> {
  // Through the production close fragment, so a fixture's closed edge carries the lifecycle
  // counter a real close writes; a fixture that only stamped it would be proving less than the
  // substrate holds.
  await runWrite(
    driver,
    [
      `MATCH ({ id: $sourceId })-[r:${type}]->({ id: $targetId })`,
      `SET ${closeRelationshipFragment('r')}`,
    ].join('\n'),
    { sourceId, targetId, validUntil: toGraphDateTime(at), txUntil: toGraphDateTime(at) },
    () => undefined,
  );
}

/**
 * Nodes carrying their own stated reason, the property a pack renders as `why`. What it
 * separates: a battery whose packs print no reasons because selection dropped them, and one
 * whose packs print none because extraction stored none to print.
 */
export async function countStatedReasons(driver: Driver): Promise<number> {
  return count(
    driver,
    [
      `MATCH (n:${BASE_NODE_LABEL})`,
      "WHERE n.rationale IS NOT NULL AND trim(n.rationale) <> ''",
      'RETURN count(n) AS c',
    ].join('\n'),
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

/**
 * A bare current entity, the way a lived-in graph holds one: enough properties to stand in
 * recall reads and to occupy the `entity_name_unique` constraint. Exists for tests that model
 * a graph where a name the backbone wants is already taken.
 */
export async function seedBareEntity(
  driver: Driver,
  input: { readonly id: string; readonly name: string; readonly now: Date },
): Promise<void> {
  const iso = input.now.toISOString();
  await runWrite(
    driver,
    {
      cypher: [
        'MERGE (e:AionNode:Entity:Memory {id: $id})',
        'ON CREATE SET e.name = $name, e.name_norm = $nameNorm, e.text = $name,',
        '  e.type = $type, e.occurred_at = datetime($iso), e.valid_from = datetime($iso),',
        '  e.tx_from = datetime($iso)',
      ].join('\n'),
      parameters: {
        id: input.id,
        name: input.name,
        nameNorm: input.name.trim().toLowerCase(),
        type: 'project',
        iso,
      },
    },
    () => undefined,
  );
}

/**
 * A retained claim carrying the source id its extraction recorded, without the source projection
 * having to exist. This is the shape a graph holds after an eviction: the interpretation stays,
 * the raw capture behind it does not.
 */
export async function seedRetainedClaim(
  driver: Driver,
  input: { readonly id: string; readonly sourceId: string },
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: 'CREATE (n:AionNode:Memory:Claim {id: $id, source_episode_id: $sourceId})',
      parameters: { id: input.id, sourceId: input.sourceId },
    },
    () => undefined,
  );
}

/**
 * Takes a raw projection out of the graph the way an eviction does, reversibly: the node keeps
 * its row under a retired id so a test can put it back, and no reader can reach it meanwhile.
 */
export async function retireEpisodeProjection(driver: Driver, episodeId: string): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: [
        'MATCH (n:Episode {id: $id})',
        'SET n.id = "retired:" + n.id',
        'REMOVE n:AionNode:Memory:Episode',
      ].join('\n'),
      parameters: { id: episodeId },
    },
    () => undefined,
  );
}

/**
 * Puts an episode's vector hash where a test needs it, reversibly.
 *
 * A null hash is what a re-enqueue leaves: the floats stay and nothing can show they were taken
 * over the text the node holds now, which is the reading the drain and the parity count share.
 */
export async function setEpisodeVectorHash(
  driver: Driver,
  episodeId: string,
  hash: string | null,
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: `MATCH (n:Episode { id: $id }) SET n.${MEMORY_PROPERTIES.contentVectorHash} = $hash`,
      parameters: { id: episodeId, hash },
    },
    () => undefined,
  );
}

/**
 * Closes an entity's validity the way a merge, a decay or a forget would, and reopens it.
 *
 * The pair is what makes a currency test reversible: an in-place description rewrite carries its
 * own currency check and has no close to undo, so the test has to supply the close itself.
 */
export async function closeEntityValidity(
  driver: Driver,
  entityId: string,
  at: Date,
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: `MATCH (e:${ENTITY_LABEL} { id: $id }) SET e.${BITEMPORAL_PROPERTIES.validUntil} = datetime($at)`,
      parameters: { id: entityId, at: at.toISOString() },
    },
    () => undefined,
  );
}

export async function reopenEntityValidity(driver: Driver, entityId: string): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: `MATCH (e:${ENTITY_LABEL} { id: $id }) REMOVE e.${BITEMPORAL_PROPERTIES.validUntil}`,
      parameters: { id: entityId },
    },
    () => undefined,
  );
}

/** The three clocks a node carries, read together so a test can say which of them agree. */
export type NodeStamps = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly occurredAt: Date | null;
  readonly validFrom: Date | null;
  readonly txFrom: Date | null;
};

/** Every node of one label with its clocks, ordered, for a test comparing axes across a write. */
export async function stampsOfLabel(driver: Driver, label: string): Promise<NodeStamps[]> {
  return runRead(
    driver,
    [
      `MATCH (n:${label})`,
      'RETURN n.id AS id, labels(n) AS labels,',
      `       n.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at,`,
      `       n.${BITEMPORAL_PROPERTIES.validFrom} AS valid_from,`,
      `       n.${BITEMPORAL_PROPERTIES.txFrom} AS tx_from`,
      'ORDER BY n.id',
    ].join('\n'),
    {},
    (row) => ({
      id: row.id as string,
      labels: row.labels as string[],
      occurredAt: (row.occurred_at ?? null) as Date | null,
      validFrom: (row.valid_from ?? null) as Date | null,
      txFrom: (row.tx_from ?? null) as Date | null,
    }),
  );
}

/** A claim the keying mechanism had something to match on: both key properties present. */
export type KeyedClaimRow = {
  readonly id: string;
  readonly episodeId: string;
  readonly subject: string;
  readonly aspect: string;
};

export async function keyedClaims(driver: Driver): Promise<KeyedClaimRow[]> {
  return runRead(
    driver,
    [
      `MATCH (n:Memory)-[:${EXTRACTION_TYPE}]->(e:Episode)`,
      `WHERE n.${CLAIM_SUBJECT_PROPERTY} IS NOT NULL AND n.${CLAIM_ASPECT_PROPERTY} IS NOT NULL`,
      'RETURN n.id AS id, e.id AS episode_id,',
      `       n.${CLAIM_SUBJECT_PROPERTY} AS subject, n.${CLAIM_ASPECT_PROPERTY} AS aspect`,
      'ORDER BY episode_id, id',
    ].join('\n'),
    {},
    (row) => ({
      id: row.id as string,
      episodeId: row.episode_id as string,
      subject: row.subject as string,
      aspect: row.aspect as string,
    }),
  );
}

/** One close, with the episodes both ends were extracted from. */
export type CloseByMethodRow = {
  readonly newId: string;
  readonly oldId: string;
  readonly newEpisodeId: string;
  readonly oldEpisodeId: string;
};

/**
 * Every close one named method made, read off the lineage edge's own provenance rather than off
 * a counter. A counter says how many; the provenance says which, which is what a precision
 * question needs.
 */
export async function closesByMethod(driver: Driver, method: string): Promise<CloseByMethodRow[]> {
  return runRead(
    driver,
    [
      `MATCH (newClaim)-[r:${SUPERSEDES_TYPE}]->(old)`,
      'WHERE $method IN r.provenance',
      `MATCH (newClaim)-[:${EXTRACTION_TYPE}]->(newEpisode:Episode)`,
      `MATCH (old)-[:${EXTRACTION_TYPE}]->(oldEpisode:Episode)`,
      'RETURN newClaim.id AS new_id, old.id AS old_id,',
      '       newEpisode.id AS new_episode_id, oldEpisode.id AS old_episode_id',
      'ORDER BY old_id, new_id',
    ].join('\n'),
    { method },
    (row) => ({
      newId: row.new_id as string,
      oldId: row.old_id as string,
      newEpisodeId: row.new_episode_id as string,
      oldEpisodeId: row.old_episode_id as string,
    }),
  );
}
