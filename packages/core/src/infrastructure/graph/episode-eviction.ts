import type { Driver } from 'neo4j-driver';

import { runRead, type GraphTransaction } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, RAW_CONTAINER_LABELS } from './labels.js';
import { toGraphInteger, type Row } from './values.js';
import type { EvictionNode, IncidentEdge } from '../../reflection/domain/episode-eviction.js';

/**
 * The only place in the workspace that removes a node.
 *
 * Two statements and one refusal. The census enumerates a source's raw projection and every
 * relationship incident on it in both directions, deduplicated by relationship identity and
 * paged with an explicit overflow answer, because a `LIMIT` result that happens to come back
 * short certifies nothing about the set it truncated. The removal deletes the enumerated
 * relationships first and then the enumerated nodes with an ordinary delete, never `DETACH`: an
 * edge nobody classified then fails the transaction instead of disappearing inside it.
 *
 * The refusal is the third thing and it is not decoration. The caller is holding the guard and
 * has rechecked its own manifest, and this still re-reads the labels it is about to remove: an
 * id can be taken by an unrelated node between two attempts, and a delete that trusted the
 * caller's label map would remove a retained interpretation standing on that id.
 */

const RAW_LABELS = RAW_CONTAINER_LABELS.map((label) => `'${label}'`).join(', ');

const READ_REMOVAL_NODES = [
  'UNWIND $ids AS wanted',
  `MATCH (n:${BASE_NODE_LABEL} { id: wanted })`,
  'RETURN n.id AS id, labels(n) AS labels',
  'ORDER BY id',
].join('\n');

/**
 * Every relationship touching the set, whichever way it points. `DISTINCT r` is what makes an
 * edge internal to the set count once: it is matched from both of its ends and is one relation.
 */
const READ_INCIDENT_EDGES = [
  'UNWIND $ids AS wanted',
  `MATCH (n:${BASE_NODE_LABEL} { id: wanted })-[r]-(:${BASE_NODE_LABEL})`,
  'WITH DISTINCT r',
  'RETURN r.id AS relationId, type(r) AS type,',
  '       startNode(r).id AS fromId, endNode(r).id AS toId,',
  '       labels(startNode(r)) AS fromLabels, labels(endNode(r)) AS toLabels,',
  '       properties(r) AS properties',
  'ORDER BY relationId, type',
  'LIMIT $limit',
].join('\n');

const DELETE_INCIDENT_EDGES = [
  `MATCH (n:${BASE_NODE_LABEL})-[r]-()`,
  'WHERE n.id IN $nodeIds AND r.id IN $relationIds',
  'WITH DISTINCT r, r.id AS relationId',
  'DELETE r',
  'RETURN relationId',
].join('\n');

const DELETE_RAW_NODES = [
  'UNWIND $nodeIds AS wanted',
  `MATCH (n:${BASE_NODE_LABEL} { id: wanted })`,
  'WITH n, n.id AS nodeId',
  'DELETE n',
  'RETURN nodeId',
].join('\n');

/** Labels are read back under the guard; an id standing under anything else is not this source's. */
const READ_REMOVAL_LABELS = [
  'UNWIND $ids AS wanted',
  `MATCH (n:${BASE_NODE_LABEL} { id: wanted })`,
  `RETURN n.id AS id, any(l IN labels(n) WHERE l IN [${RAW_LABELS}]) AS raw`,
].join('\n');

export class EvictionRemovalRefused extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`eviction removal refused: ${reason} (${detail})`);
    this.name = 'EvictionRemovalRefused';
    this.reason = reason;
  }
}

export async function readRemovalNodes(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<readonly EvictionNode[]> {
  if (ids.length === 0) {
    return [];
  }
  return tx.run(READ_REMOVAL_NODES, { ids: [...new Set(ids)] }, (row: Row) => ({
    id: row.id as string,
    labels: (row.labels as string[] | null) ?? [],
  }));
}

export type IncidentCensus = {
  readonly edges: readonly IncidentEdge[];
  /** The page filled its bound, so the enumeration is a sample and certifies nothing. */
  readonly overflowed: boolean;
};

/**
 * The incident set, with the removal-set endpoints named on each row so the classifier never
 * has to re-derive which end is being taken away.
 */
export async function readIncidentEdges(
  tx: GraphTransaction,
  ids: readonly string[],
  limit: number,
): Promise<IncidentCensus> {
  const inside = new Set(ids);
  if (inside.size === 0 || limit <= 0) {
    return { edges: [], overflowed: false };
  }
  const rows = await tx.run(
    READ_INCIDENT_EDGES,
    { ids: [...inside], limit: toGraphInteger(limit + 1) },
    (row: Row) => {
      const fromId = row.fromId as string;
      const toId = row.toId as string;
      const insideIds = [fromId, toId].filter((id) => inside.has(id));
      const outsideId = [fromId, toId].find((id) => !inside.has(id));
      const properties = (row.properties as Record<string, unknown> | null) ?? {};
      const outsideLabels =
        outsideId === undefined
          ? []
          : (((outsideId === fromId ? row.fromLabels : row.toLabels) as string[] | null) ?? []);
      return {
        relationId: typeof row.relationId === 'string' ? row.relationId : '',
        type: row.type as string,
        fromId,
        toId,
        insideIds,
        ...(outsideId === undefined ? {} : { outsideId }),
        outsideLabels,
        provenance: (properties.provenance as string[] | undefined) ?? [],
        properties,
      } satisfies IncidentEdge;
    },
  );
  return { edges: rows.slice(0, limit), overflowed: rows.length > limit };
}

/**
 * Every Turn the graph says belongs to this Episode, whatever the part records say.
 *
 * The two lists have to agree exactly. A Turn the records do not know about is a projection
 * nobody captured the identity or order of, and removing the Episode it hangs off would leave it
 * pointing at nothing; leaving it behind would leave a raw part of an evicted source resident.
 * Either way the source is pinned until somebody explains the extra node.
 */
const READ_PROJECTED_TURNS = [
  `MATCH (t:Turn:${BASE_NODE_LABEL})`,
  `WHERE t.${MEMORY_PROPERTIES.sourceEpisodeId} = $sourceId`,
  'RETURN t.id AS id',
  'ORDER BY id',
  'LIMIT $limit',
].join('\n');

export async function readProjectedTurnIds(
  tx: GraphTransaction,
  sourceId: string,
  limit: number,
): Promise<readonly string[]> {
  return tx.run(
    READ_PROJECTED_TURNS,
    { sourceId, limit: toGraphInteger(limit) },
    (row: Row) => row.id as string,
  );
}

/**
 * A retained neighbour's physical neighbourhood, as one comparable value.
 *
 * Degree and the newest edge stamp together move whenever an edge is added, reopened, closed or
 * reweighted, which is exactly when a recomputation bound to the old reading would be answering
 * about a neighbourhood that is no longer there. It is a revision, not a measurement: nothing
 * reads a meaning off the number beyond whether it is the same one.
 */
const READ_NEIGHBORHOOD_REVISIONS = [
  'UNWIND $ids AS wanted',
  `MATCH (n:${BASE_NODE_LABEL} { id: wanted })`,
  `OPTIONAL MATCH (n)-[r]-(:${BASE_NODE_LABEL})`,
  'WITH n, count(r) AS degree,',
  '     max(coalesce(r.updated_at, r.created_at)) AS moved',
  'RETURN n.id AS id, degree AS degree, toString(moved) AS moved',
].join('\n');

function toRevision(row: Row): { id: string; revision: string } {
  const degree = typeof row.degree === 'number' ? row.degree : 0;
  const moved = typeof row.moved === 'string' ? row.moved : '';
  return { id: row.id as string, revision: `${String(degree)}:${moved}` };
}

export async function readNeighborhoodRevisions(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await tx.run(READ_NEIGHBORHOOD_REVISIONS, { ids: unique }, toRevision);
  return new Map(rows.map((row) => [row.id, row.revision] as const));
}

/** The same revision read outside a transaction, for the repair pass that holds no guard. */
export async function readNeighborhoodRevisionsOf(
  driver: Driver,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await runRead(driver, READ_NEIGHBORHOOD_REVISIONS, { ids: unique }, toRevision);
  return new Map(rows.map((row) => [row.id, row.revision] as const));
}

export type RemovalRequest = {
  readonly nodeIds: readonly string[];
  readonly relationIds: readonly string[];
};

export type RemovalOutcome = {
  readonly relationships: readonly string[];
  readonly nodes: readonly string[];
};

/**
 * Removes exactly the enumerated relationships and then exactly the enumerated nodes.
 *
 * Both halves verify their own outcome against the set they were handed, so a partial match is a
 * raised refusal inside the caller's transaction rather than a smaller number nobody compared.
 * The node delete is ordinary rather than detaching, which is what makes an unaccounted edge the
 * transaction's failure: `DETACH` would remove it silently and the classification that never
 * happened would never be missed.
 */
export async function removeRawProjection(
  tx: GraphTransaction,
  request: RemovalRequest,
): Promise<RemovalOutcome> {
  const nodeIds = [...new Set(request.nodeIds)];
  const relationIds = [...new Set(request.relationIds)];
  if (nodeIds.length === 0) {
    throw new EvictionRemovalRefused('empty_removal_set', 'no raw node was named');
  }
  const held = await tx.run(READ_REMOVAL_LABELS, { ids: nodeIds }, (row: Row) => ({
    id: row.id as string,
    raw: row.raw === true,
  }));
  if (held.length !== nodeIds.length) {
    throw new EvictionRemovalRefused(
      'removal_node_missing',
      `${String(held.length)} of ${String(nodeIds.length)} still present`,
    );
  }
  const retained = held.filter((node) => !node.raw).map((node) => node.id);
  if (retained.length > 0) {
    throw new EvictionRemovalRefused('retained_label_in_removal_set', retained.join(', '));
  }
  const relationships =
    relationIds.length === 0
      ? []
      : await tx.run(
          DELETE_INCIDENT_EDGES,
          { nodeIds, relationIds },
          (row: Row) => row.relationId as string,
        );
  if (new Set(relationships).size !== relationIds.length) {
    throw new EvictionRemovalRefused(
      'relationship_set_changed',
      `${String(new Set(relationships).size)} of ${String(relationIds.length)} removed`,
    );
  }
  const nodes = await tx.run(DELETE_RAW_NODES, { nodeIds }, (row: Row) => row.nodeId as string);
  if (new Set(nodes).size !== nodeIds.length) {
    throw new EvictionRemovalRefused(
      'node_set_changed',
      `${String(new Set(nodes).size)} of ${String(nodeIds.length)} removed`,
    );
  }
  return { relationships: [...relationships].sort(), nodes: [...nodes].sort() };
}
