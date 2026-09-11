import type { Driver } from 'neo4j-driver';

import type { Vector } from '../../providers/types.js';
import { readFirst, runWrite } from '../connection.js';
import { CONTEXT_VECTOR_PROPERTY } from '../context-vector-queries.js';
import { MEMORY_PROPERTIES } from '../episodes.js';
import { BASE_NODE_LABEL } from '../labels.js';
import { fromGraphVector, toGraphDateTime, toGraphVector } from '../values.js';

/**
 * Graph reads and seeds the eviction battery needs, kept here because every Cypher statement in
 * the workspace lives under `graph/` including a test's. Everything a case asserts about the
 * substrate after a removal is asked through these rather than through a query written beside
 * the assertion, where a filter could quietly disagree with the adapter it is checking.
 */

/**
 * A retained neighbour carrying both vectors, so a recomputation has something to average and a
 * clearing has something to clear. The two are separate assertions: an eviction that removed the
 * last vectored neighbour must drop the context and leave the content exactly where it was.
 */
export async function seedVectoredEntity(
  driver: Driver,
  input: {
    readonly id: string;
    readonly name: string;
    readonly vector: Vector;
    readonly contextVector?: Vector;
    readonly now: Date;
  },
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: [
        `MERGE (e:${BASE_NODE_LABEL}:Entity:Memory { id: $id })`,
        'ON CREATE SET e.name = $name, e.name_norm = $nameNorm, e.text = $name, e.type = $type,',
        '  e.occurred_at = $now, e.valid_from = $now, e.tx_from = $now',
        `SET e.${MEMORY_PROPERTIES.contentVector} = $vector,`,
        `    e.${CONTEXT_VECTOR_PROPERTY} = $context`,
      ].join('\n'),
      parameters: {
        id: input.id,
        name: input.name,
        nameNorm: input.name.trim().toLowerCase(),
        type: 'project',
        now: toGraphDateTime(input.now),
        vector: toGraphVector(input.vector),
        context: toGraphVector(input.contextVector ?? input.vector),
      },
    },
    () => undefined,
  );
}

export async function nodeExists(driver: Driver, id: string): Promise<boolean> {
  const found = await readFirst(
    driver,
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) RETURN n.id AS id`,
    { id },
    (row) => row.id as string,
  );
  return found !== undefined;
}

export async function relationshipExists(driver: Driver, relationId: string): Promise<boolean> {
  const found = await readFirst(
    driver,
    'MATCH ()-[r]-() WHERE r.id = $relationId RETURN r.id AS id LIMIT 1',
    { relationId },
    (row) => row.id as string,
  );
  return found !== undefined;
}

export async function storedVectors(
  driver: Driver,
  id: string,
): Promise<{ readonly content: Vector | undefined; readonly context: Vector | undefined }> {
  const row = await readFirst(
    driver,
    [
      `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
      `RETURN n.${MEMORY_PROPERTIES.contentVector} AS content, n.${CONTEXT_VECTOR_PROPERTY} AS context`,
    ].join('\n'),
    { id },
    (result) => ({
      content: fromGraphVector(result.content),
      context: fromGraphVector(result.context),
    }),
  );
  return row ?? { content: undefined, context: undefined };
}

/** A relationship the classifier has no entry for, written the way an unreviewed writer would. */
export async function seedUnknownEdge(
  driver: Driver,
  input: { readonly fromId: string; readonly toId: string; readonly relationId: string },
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: [
        `MATCH (a:${BASE_NODE_LABEL} { id: $fromId })`,
        `MATCH (b:${BASE_NODE_LABEL} { id: $toId })`,
        'CREATE (a)-[r:INVENTED_BY { id: $relationId }]->(b)',
        'RETURN r.id AS id',
      ].join('\n'),
      parameters: input,
    },
    () => undefined,
  );
}

/** A Turn node claiming an Episode the part records never captured. */
export async function seedStrayTurn(
  driver: Driver,
  input: { readonly id: string; readonly sourceId: string; readonly now: Date },
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: [
        `CREATE (t:${BASE_NODE_LABEL}:Turn:Memory { id: $id })`,
        `SET t.${MEMORY_PROPERTIES.sourceEpisodeId} = $sourceId, t.tx_from = $now`,
      ].join('\n'),
      parameters: { id: input.id, sourceId: input.sourceId, now: toGraphDateTime(input.now) },
    },
    () => undefined,
  );
}

/** Moves one edge's weight, which is a preserved field and must invalidate a prepared manifest. */
export async function moveEdgeStrength(
  driver: Driver,
  relationId: string,
  strength: number,
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: 'MATCH ()-[r]-() WHERE r.id = $relationId SET r.strength = $strength',
      parameters: { relationId, strength },
    },
    () => undefined,
  );
}

/**
 * An edge from a raw node to something the node registry does not name. The endpoint carries no
 * base label, which is what an administrative node looks like from the census's side.
 */
export async function seedForeignEndpointEdge(
  driver: Driver,
  input: { readonly fromId: string; readonly relationId: string; readonly foreignId: string },
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: [
        `MATCH (a:${BASE_NODE_LABEL} { id: $fromId })`,
        'MERGE (b:AdminProbe { probe_id: $foreignId })',
        'CREATE (a)-[r:MENTIONS { id: $relationId }]->(b)',
        'RETURN r.id AS id',
      ].join('\n'),
      parameters: input,
    },
    () => undefined,
  );
}

/** Adds or removes one label, for the mixed-semantic-label refusal. A label is not a node. */
export async function setNodeLabel(
  driver: Driver,
  input: { readonly id: string; readonly label: string; readonly present: boolean },
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: [
        `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
        input.present ? `SET n:${input.label}` : `REMOVE n:${input.label}`,
        'RETURN n.id AS id',
      ].join('\n'),
      parameters: { id: input.id },
    },
    () => undefined,
  );
}

/** The current weight of one edge, so a case can put back exactly what it moved. */
export async function edgeStrengthOf(
  driver: Driver,
  relationId: string,
): Promise<number | undefined> {
  return readFirst(
    driver,
    'MATCH ()-[r]-() WHERE r.id = $relationId RETURN r.strength AS strength LIMIT 1',
    { relationId },
    (row) => row.strength as number,
  );
}

/**
 * A registered node that carries no `Memory` label, and so no context vector of any kind. It is
 * a legitimate survivor of a disposable association and nothing the vector path can write.
 */
export async function seedUnvectoredNeighbour(
  driver: Driver,
  input: { readonly id: string; readonly now: Date },
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher: [
        `MERGE (n:${BASE_NODE_LABEL}:Entity { id: $id })`,
        'ON CREATE SET n.name = $id, n.name_norm = $id, n.tx_from = $now',
        'RETURN n.id AS id',
      ].join('\n'),
      parameters: { id: input.id, now: toGraphDateTime(input.now) },
    },
    () => undefined,
  );
}
