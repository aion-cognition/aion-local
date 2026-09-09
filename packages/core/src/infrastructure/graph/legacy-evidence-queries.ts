import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { CONFIRMATION_PROPERTIES } from './claim-provenance-queries.js';
import { runRead, type GraphTransaction } from './connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL } from './labels.js';
import { fromGraphDateTime, toGraphInteger } from './values.js';

/**
 * The read half of the guarded legacy materialization: what the graph still holds about one
 * legacy source, and every relationship that touches it.
 *
 * A legacy source's only record of a mention or an extraction is the edge itself, so this walk
 * is the evidence the durable records are built from. Nothing here writes, and nothing here
 * decides what an edge means: it reports the type, the direction, the endpoints and the clocks
 * exactly as recorded, and the classification is a pure decision taken over the result.
 *
 * The bound is charged before the rows are read. A page that filled its limit says so, and a
 * caller may not establish a census over an enumeration that ran out of room: an incomplete
 * walk and an empty scope look identical once the rows are discarded.
 */

export type LegacyTurn = {
  readonly turnId: string;
  readonly ordinal: number;
  readonly role?: string;
  readonly contentHash?: string;
  readonly occurredAt?: string;
};

export type LegacyRawNodes = {
  readonly sourceId: string;
  /** The session the episode is owned by, as the graph records it. Absent when it has none. */
  readonly sessionId?: string;
  readonly contentHash?: string;
  /**
   * When the source was forgotten, where it was. A suppression is a statement about the source
   * that outlives its content, and a migration that read only the content would carry the bytes
   * across and leave the statement behind — which is a forgotten memory answering again.
   */
  readonly forgottenAt?: string;
  /** The original turns, in the order their recorded sequence puts them. */
  readonly turns: readonly LegacyTurn[];
};

const RAW_NODES = [
  `MATCH (e:Episode { id: $sourceId })`,
  `OPTIONAL MATCH (e)-[:${CONTAINMENT_TYPE}]->(s:Session)`,
  `OPTIONAL MATCH (t:Turn)-[:${CONTAINMENT_TYPE}]->(e)`,
  `WITH e, s, t ORDER BY t.${MEMORY_PROPERTIES.sequence}, t.id`,
  `RETURN e.id AS episode_id, s.id AS session_id,`,
  `       e.${MEMORY_PROPERTIES.contentHash} AS content_hash,`,
  `       e.${BITEMPORAL_PROPERTIES.forgottenAt} AS forgotten_at,`,
  '       [x IN collect({',
  '         id: t.id,',
  `         role: t.${MEMORY_PROPERTIES.role},`,
  `         content_hash: t.${MEMORY_PROPERTIES.contentHash},`,
  `         occurred_at: t.${BITEMPORAL_PROPERTIES.occurredAt}`,
  '       }) WHERE x.id IS NOT NULL] AS turns',
].join('\n');

/**
 * The raw projection of one legacy source, or nothing when the graph no longer holds it.
 *
 * A source with no episode is not an error here. It is the answer the pin needs: there is
 * nothing to enumerate, so nothing about it can be proved, and inventing a materialization for
 * it would record evidence nobody observed.
 */
export async function readLegacyRawNodes(
  tx: GraphTransaction,
  sourceId: string,
): Promise<LegacyRawNodes | undefined> {
  const rows = await tx.run(RAW_NODES, { sourceId }, toRawNodes);
  return rows[0];
}

type TurnRowData = {
  id: string;
  role: string | null;
  content_hash: string | null;
  occurred_at: unknown;
};

function toRawNodes(row: Record<string, unknown>): LegacyRawNodes {
  const sessionId = (row.session_id as string | null) ?? undefined;
  const contentHash = (row.content_hash as string | null) ?? undefined;
  const forgottenAt = stamp(row.forgotten_at);
  return {
    sourceId: row.episode_id as string,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(forgottenAt === undefined ? {} : { forgottenAt }),
    turns: (row.turns as TurnRowData[]).map((turn, ordinal) => ({
      turnId: turn.id,
      ordinal,
      ...(turn.role === null ? {} : { role: turn.role }),
      ...(turn.content_hash === null ? {} : { contentHash: turn.content_hash }),
      ...(stamp(turn.occurred_at) === undefined ? {} : { occurredAt: stamp(turn.occurred_at) }),
    })),
  };
}

/** The same read outside a publication, for the walk that decides what a source is before it publishes. */
export async function findLegacyRawNodes(
  driver: Driver,
  sourceId: string,
): Promise<LegacyRawNodes | undefined> {
  const rows = await runRead(driver, RAW_NODES, { sourceId }, toRawNodes);
  return rows[0];
}

/**
 * A page of every episode the graph holds, by id, forgotten ones included.
 *
 * A freeze needs the members, not the healthy ones. A forgotten legacy source is still a source
 * the cohort has to account for, and an episode that never reached the archive exists here and
 * nowhere else — leaving either out would put a member in no cohort at all.
 */
export async function pageLegacyEpisodeCensus(
  driver: Driver,
  after: string,
  limit: number,
): Promise<readonly string[]> {
  return runRead(
    driver,
    ['MATCH (e:Episode) WHERE e.id > $after', 'RETURN e.id AS id ORDER BY e.id LIMIT $limit'].join(
      '\n',
    ),
    { after, limit: toGraphInteger(limit) },
    (row) => row.id as string,
  );
}

export type LegacyRelation = {
  /**
   * The relationship identity the graph minted, so a rebuild produces the same link rather
   * than a second one that looks like it. Edges written before the id property existed fall
   * back to the server's own element identity, which is recorded as what it is.
   */
  readonly relationId: string;
  readonly type: string;
  readonly fromId: string;
  readonly toId: string;
  readonly fromLabels: readonly string[];
  readonly toLabels: readonly string[];
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly txFrom?: string;
  readonly txUntil?: string;
  /**
   * The edge's own last-written clock. Identifier decay ages a mention by it, so it travels with
   * the record: recomputing it from the backfill's clock would age every legacy mention to the
   * day the migration ran.
   */
  readonly updatedAt?: string;
  /**
   * The values the relationship itself carries beyond its clocks: who confirmed it and on what.
   * A record holding the type and a few timestamps is not the statement somebody made. Absent
   * where the relationship states nothing beyond its type.
   */
  readonly recorded?: Readonly<Record<string, string>>;
};

export type LegacyRelationPage = {
  readonly relations: readonly LegacyRelation[];
  /**
   * False when the bound cut the walk. A census over an incomplete enumeration would state
   * that a scope was counted when part of it was never read.
   */
  readonly complete: boolean;
};

const INCIDENT_RELATIONS = [
  `MATCH (raw:${BASE_NODE_LABEL})-[r]-(other:${BASE_NODE_LABEL})`,
  'WHERE raw.id IN $rawIds',
  'WITH DISTINCT r, startNode(r) AS s, endNode(r) AS e',
  'RETURN coalesce(r.id, elementId(r)) AS relation_id, type(r) AS type,',
  '       s.id AS from_id, e.id AS to_id, labels(s) AS from_labels, labels(e) AS to_labels,',
  `       r.${BITEMPORAL_PROPERTIES.validFrom} AS valid_from,`,
  `       r.${BITEMPORAL_PROPERTIES.validUntil} AS valid_until,`,
  `       r.${BITEMPORAL_PROPERTIES.txFrom} AS tx_from,`,
  `       r.${BITEMPORAL_PROPERTIES.txUntil} AS tx_until,`,
  '       r.updated_at AS updated_at,',
  `       r.${CONFIRMATION_PROPERTIES.by} AS confirmed_by,`,
  `       r.${CONFIRMATION_PROPERTIES.at} AS confirmed_at,`,
  `       r.${CONFIRMATION_PROPERTIES.evidence} AS confirmation_evidence,`,
  '       r.rationale AS rationale,',
  '       r.created_at AS created_at',
  'ORDER BY relation_id',
  'LIMIT $limit',
].join('\n');

function stamp(value: unknown): string | undefined {
  return fromGraphDateTime(value)?.toISOString();
}

/** One recorded text value under the name the graph stores it as, or nothing when it is absent. */
function text(row: Record<string, unknown>, column: string, key: string): Record<string, string> {
  const value = row[column];
  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}

/** The same for a recorded clock, in the ISO form every durable record carries. */
function clock(row: Record<string, unknown>, column: string, key: string): Record<string, string> {
  const value = stamp(row[column]);
  return value === undefined ? {} : { [key]: value };
}

/**
 * Every relationship touching one source's raw nodes, in both directions, counted once.
 *
 * An edge between two of the source's own nodes is one relationship however many ends of it
 * this walk reaches, so the enumeration is distinct on the relationship rather than on the
 * pairing. Closed edges come back too: an edge that was closed is evidence that it was there,
 * and a walk that returned only the open ones would materialize a corpus that never had a
 * retired mention in it.
 */
export async function readLegacyIncidentRelations(
  tx: GraphTransaction,
  rawIds: readonly string[],
  limit: number,
): Promise<LegacyRelationPage> {
  if (rawIds.length === 0 || limit <= 0) {
    return { relations: [], complete: rawIds.length === 0 };
  }
  // One more than the caller charged for, so a full page is distinguishable from a page that
  // happened to end exactly on the bound.
  const rows = await tx.run(
    INCIDENT_RELATIONS,
    { rawIds: [...rawIds], limit: toGraphInteger(limit + 1) },
    (row): LegacyRelation => ({
      relationId: row.relation_id as string,
      type: row.type as string,
      fromId: row.from_id as string,
      toId: row.to_id as string,
      fromLabels: row.from_labels as string[],
      toLabels: row.to_labels as string[],
      ...(stamp(row.valid_from) === undefined ? {} : { validFrom: stamp(row.valid_from) }),
      ...(stamp(row.valid_until) === undefined ? {} : { validUntil: stamp(row.valid_until) }),
      ...(stamp(row.tx_from) === undefined ? {} : { txFrom: stamp(row.tx_from) }),
      ...(stamp(row.tx_until) === undefined ? {} : { txUntil: stamp(row.tx_until) }),
      ...(stamp(row.updated_at) === undefined ? {} : { updatedAt: stamp(row.updated_at) }),
      recorded: {
        ...text(row, 'confirmed_by', CONFIRMATION_PROPERTIES.by),
        ...text(row, 'confirmation_evidence', CONFIRMATION_PROPERTIES.evidence),
        ...text(row, 'rationale', 'rationale'),
        ...clock(row, 'confirmed_at', CONFIRMATION_PROPERTIES.at),
        ...clock(row, 'created_at', 'created_at'),
      },
    }),
  );
  return { relations: rows.slice(0, limit), complete: rows.length <= limit };
}
