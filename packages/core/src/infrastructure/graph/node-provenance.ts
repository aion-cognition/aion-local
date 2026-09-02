import type { Driver } from 'neo4j-driver';

import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_TYPE_PROPERTY } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL } from './labels.js';
import {
  readCurrencyAnnotation,
  readModeFragment,
  withCurrency,
  type CurrencyAnnotation,
  type ReadMode,
} from './read-modes.js';
import { ENTITY_NAME_PROPERTY, LAST_ACCESSED_PROPERTY } from './seed-queries.js';
import { EDGE_REOPENED_AT_PROPERTY } from './unsupersede.js';
import type { Row } from './values.js';

/**
 * `aion why`'s two reads: one node's own record and everything it touches. Both are
 * currency-aware like every other read path (`read-modes.ts`), so a superseded node still
 * answers and comes back annotated rather than looking like a miss.
 */

export type NodeProvenance = CurrencyAnnotation & {
  readonly id: string;
  readonly labels: readonly string[];
  readonly content: string;
  /**
   * `extraction_method` on every node a named pipeline stage wrote: intake's Turn and Episode,
   * entity resolution's Entity, and the Narrative a session compression, a rollup or a claim
   * consolidation produced. Absent on the nine cognitive types, whose provenance is their
   * `EXTRACTED_FROM` edge.
   */
  readonly extractionMethod?: string;
  readonly sourceEpisodeId?: string;
  /** The node's own stated reason (a Decision's `rationale` property today). */
  readonly rationale?: string;
  /** Written once, by whichever run created an Entity. */
  readonly confidence?: number;
  /** Mention salience: how many times recall or a mention has touched this node. */
  readonly accessCount?: number;
  readonly lastAccessed?: Date;
  readonly name?: string;
  readonly entityType?: string;
  readonly occurredAt?: Date;
  readonly validFrom?: Date;
  readonly validUntil?: Date;
  readonly txFrom?: Date;
  readonly txUntil?: Date;
  readonly forgottenAt?: Date;
};

function provenanceStatement(id: string, mode: ReadMode): GraphStatement {
  const fragment = readModeFragment(mode, 'n');
  const cypher = [
    `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
    `WHERE ${fragment.where}`,
    'RETURN n.id AS id,',
    '       labels(n) AS labels,',
    `       coalesce(n.${MEMORY_PROPERTIES.summary}, n.${MEMORY_PROPERTIES.text}, n.${ENTITY_NAME_PROPERTY}, '') AS content,`,
    `       n.${MEMORY_PROPERTIES.extractionMethod} AS extraction_method,`,
    `       n.${MEMORY_PROPERTIES.sourceEpisodeId} AS source_episode_id,`,
    '       n.rationale AS rationale,',
    '       n.confidence AS confidence,',
    `       n.${ACCESS_COUNT_PROPERTY} AS access_count,`,
    `       n.${LAST_ACCESSED_PROPERTY} AS last_accessed,`,
    `       n.${ENTITY_NAME_PROPERTY} AS name,`,
    `       n.${ENTITY_TYPE_PROPERTY} AS entity_type,`,
    `       n.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at,`,
    `       n.${BITEMPORAL_PROPERTIES.validFrom} AS valid_from,`,
    `       n.${BITEMPORAL_PROPERTIES.validUntil} AS valid_until,`,
    `       n.${BITEMPORAL_PROPERTIES.txFrom} AS tx_from,`,
    `       n.${BITEMPORAL_PROPERTIES.txUntil} AS tx_until,`,
    `       n.${BITEMPORAL_PROPERTIES.forgottenAt} AS forgotten_at,`,
    `       ${fragment.projection}`,
  ].join('\n');
  return { cypher, parameters: { ...fragment.parameters, id } };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

/** One optional field, read once: `exactOptionalPropertyTypes` needs the key absent rather than set to `undefined`. */
function optionalField<K extends string, T>(
  key: K,
  value: T | undefined,
): Readonly<Partial<Record<K, T>>> {
  return value === undefined
    ? ({} as Readonly<Partial<Record<K, T>>>)
    : ({ [key]: value } as Readonly<Partial<Record<K, T>>>);
}

function mapProvenance(row: Row): NodeProvenance {
  return {
    id: row.id as string,
    labels: (row.labels as string[] | null) ?? [],
    content: typeof row.content === 'string' ? row.content : '',
    ...optionalField('extractionMethod', optionalString(row.extraction_method)),
    ...optionalField('sourceEpisodeId', optionalString(row.source_episode_id)),
    ...optionalField('rationale', optionalString(row.rationale)),
    ...optionalField('confidence', optionalNumber(row.confidence)),
    ...optionalField('accessCount', optionalNumber(row.access_count)),
    ...optionalField('lastAccessed', optionalDate(row.last_accessed)),
    ...optionalField('name', optionalString(row.name)),
    ...optionalField('entityType', optionalString(row.entity_type)),
    ...optionalField('occurredAt', optionalDate(row.occurred_at)),
    ...optionalField('validFrom', optionalDate(row.valid_from)),
    ...optionalField('validUntil', optionalDate(row.valid_until)),
    ...optionalField('txFrom', optionalDate(row.tx_from)),
    ...optionalField('txUntil', optionalDate(row.tx_until)),
    ...optionalField('forgottenAt', optionalDate(row.forgotten_at)),
    ...readCurrencyAnnotation(row),
  };
}

/** `undefined` when the id is unknown, or forgotten and `mode` is not a time-travel read. */
export async function fetchNodeProvenance(
  driver: Driver,
  id: string,
  mode: ReadMode = withCurrency(),
): Promise<NodeProvenance | undefined> {
  const rows = await runRead(driver, provenanceStatement(id, mode), mapProvenance);
  return rows[0];
}

export type NodeEdge = {
  readonly type: string;
  /** `true` when the queried node is the edge's source, so `why` can render a direction arrow. */
  readonly outgoing: boolean;
  readonly otherId: string;
  readonly otherLabels: readonly string[];
  readonly otherContent: string;
  readonly strength: number;
  readonly confidence: number;
  /** Summed observation count; 0 for a structural edge that carries no tally. */
  readonly count: number;
  readonly provenance: readonly string[];
  readonly signals: readonly string[];
  /** Why the edge exists, when whatever wrote it said so. A repair and a bridge both do. */
  readonly rationale?: string;
  readonly createdAt?: Date;
  /**
   * When `aion unsupersede` closed this lineage. Present only on a `SUPERSEDES` edge someone
   * reopened, which is the one case where an edge the graph still holds is one the substrate
   * no longer believes.
   */
  readonly reopenedAt?: Date;
};

function edgesStatement(id: string, mode: ReadMode): GraphStatement {
  const fragment = readModeFragment(mode, 'm');
  const cypher = [
    `MATCH (n:${BASE_NODE_LABEL} { id: $id })-[r]-(m:${BASE_NODE_LABEL})`,
    `WHERE m.id <> $id AND ${fragment.where}`,
    'RETURN type(r) AS type,',
    '       startNode(r).id = $id AS outgoing,',
    '       m.id AS other_id,',
    '       labels(m) AS other_labels,',
    `       coalesce(m.${MEMORY_PROPERTIES.summary}, m.${MEMORY_PROPERTIES.text}, m.${ENTITY_NAME_PROPERTY}, '') AS other_content,`,
    '       coalesce(r.strength, 1.0) AS strength,',
    '       coalesce(r.confidence, 1.0) AS confidence,',
    '       coalesce(r.count, 0) AS count,',
    '       coalesce(r.provenance, []) AS provenance,',
    '       coalesce(r.signals, []) AS signals,',
    '       r.rationale AS rationale,',
    '       r.created_at AS created_at,',
    `       r.${EDGE_REOPENED_AT_PROPERTY} AS reopened_at`,
    'ORDER BY type(r), other_id',
  ].join('\n');
  return { cypher, parameters: { ...fragment.parameters, id } };
}

function mapEdge(row: Row): NodeEdge {
  const createdAt = row.created_at;
  const reopenedAt = row.reopened_at;
  return {
    type: row.type as string,
    outgoing: row.outgoing === true,
    otherId: row.other_id as string,
    otherLabels: (row.other_labels as string[] | null) ?? [],
    otherContent: typeof row.other_content === 'string' ? row.other_content : '',
    strength: row.strength as number,
    confidence: row.confidence as number,
    count: row.count as number,
    provenance: (row.provenance as string[] | null) ?? [],
    signals: (row.signals as string[] | null) ?? [],
    ...(typeof row.rationale === 'string' && row.rationale.trim().length > 0
      ? { rationale: row.rationale }
      : {}),
    ...(createdAt instanceof Date ? { createdAt } : {}),
    ...(reopenedAt instanceof Date ? { reopenedAt } : {}),
  };
}

/**
 * Every edge touching one node, both directions, undirected types included: what
 * `aion why` groups by type for its edge summary, and where it finds the `EXTRACTED_FROM`
 * edge (extraction method lives in its `provenance`, not on the node) and both ends of a
 * `SUPERSEDES` chain.
 */
export async function fetchNodeEdges(
  driver: Driver,
  id: string,
  mode: ReadMode = withCurrency(),
): Promise<readonly NodeEdge[]> {
  return runRead(driver, edgesStatement(id, mode), mapEdge);
}
