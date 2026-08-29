import type { Driver } from 'neo4j-driver';
import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { ENTITY_TYPE_PROPERTY } from './entity-queries.js';
import {
  readCurrencyAnnotation,
  readModeFragment,
  withCurrency,
  type CurrencyAnnotation,
  type ReadMode,
} from './read-modes.js';
import { ENTITY_NAME_PROPERTY, LAST_ACCESSED_PROPERTY } from './seed-queries.js';
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
  /** `extraction_method` on a Turn or Episode; absent on the nine cognitive types, whose provenance is their `EXTRACTED_FROM` edge. */
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

function mapProvenance(row: Row): NodeProvenance {
  return {
    id: row.id as string,
    labels: (row.labels as string[] | null) ?? [],
    content: typeof row.content === 'string' ? row.content : '',
    ...(optionalString(row.extraction_method) === undefined
      ? {}
      : { extractionMethod: optionalString(row.extraction_method) }),
    ...(optionalString(row.source_episode_id) === undefined
      ? {}
      : { sourceEpisodeId: optionalString(row.source_episode_id) }),
    ...(optionalString(row.rationale) === undefined ? {} : { rationale: optionalString(row.rationale) }),
    ...(optionalNumber(row.confidence) === undefined ? {} : { confidence: optionalNumber(row.confidence) }),
    ...(optionalNumber(row.access_count) === undefined ? {} : { accessCount: optionalNumber(row.access_count) }),
    ...(optionalDate(row.last_accessed) === undefined ? {} : { lastAccessed: optionalDate(row.last_accessed) }),
    ...(optionalString(row.name) === undefined ? {} : { name: optionalString(row.name) }),
    ...(optionalString(row.entity_type) === undefined ? {} : { entityType: optionalString(row.entity_type) }),
    ...(optionalDate(row.occurred_at) === undefined ? {} : { occurredAt: optionalDate(row.occurred_at) }),
    ...(optionalDate(row.valid_from) === undefined ? {} : { validFrom: optionalDate(row.valid_from) }),
    ...(optionalDate(row.valid_until) === undefined ? {} : { validUntil: optionalDate(row.valid_until) }),
    ...(optionalDate(row.tx_from) === undefined ? {} : { txFrom: optionalDate(row.tx_from) }),
    ...(optionalDate(row.tx_until) === undefined ? {} : { txUntil: optionalDate(row.tx_until) }),
    ...(optionalDate(row.forgotten_at) === undefined ? {} : { forgottenAt: optionalDate(row.forgotten_at) }),
    ...readCurrencyAnnotation(row),
  };
}

/** `undefined` when the id is unknown, or forgotten and `mode` is not a time-travel read. */
export async function fetchNodeProvenance(
  driver: Driver,
  id: string,
  mode: ReadMode = withCurrency(),
): Promise<NodeProvenance | undefined> {
  const statement = provenanceStatement(id, mode);
  const rows = await runRead(driver, statement.cypher, statement.parameters, mapProvenance);
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
  readonly createdAt?: Date;
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
    '       r.created_at AS created_at',
    'ORDER BY type(r), other_id',
  ].join('\n');
  return { cypher, parameters: { ...fragment.parameters, id } };
}

function mapEdge(row: Row): NodeEdge {
  const createdAt = row.created_at;
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
    ...(createdAt instanceof Date ? { createdAt } : {}),
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
  const statement = edgesStatement(id, mode);
  return runRead(driver, statement.cypher, statement.parameters, mapEdge);
}
