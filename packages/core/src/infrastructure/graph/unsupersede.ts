import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { inWriteTransaction, runRead } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { GraphNodeNotFoundError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { ENTITY_NAME_PROPERTY } from './seed-queries.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * Reopening a claim something closed. The inverse of `supersede`, and the repair for a close
 * nobody can undo any other way: a wrong contradiction judgment, a family cut too wide, an
 * autonomous close a person disagrees with.
 *
 * Nothing is deleted, here least of all. The `SUPERSEDES` edge stays and is closed on both
 * timelines instead, so the substrate still knows it once believed the replacement and when it
 * stopped: `aion why` reads that back as closed-then-reopened, and a `knew_at` read before the
 * reopen still returns the supersession the substrate held at that moment. What the node gets
 * back is its currency, by dropping the two stamps the close wrote.
 *
 * Mode-blind by construction. It matches on the edge and the stamps, which every close writes
 * whatever put it there, so a manual apply, a unanimous auto-close, and the legacy confidence
 * gate all reopen the same way.
 */

/** When the lineage edge stopped being held, alongside `tx_until`, so a reopen reads as an act. */
export const EDGE_REOPENED_AT_PROPERTY = 'reopened_at';

export type ReopenedLineage = {
  /** The node that had superseded this one. */
  readonly supersededBy: string;
  readonly provenance: readonly string[];
};

export type UnsupersedeResult = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly content: string;
  /** The lineage this call closed. Empty when the node was already open. */
  readonly reopenedFrom: readonly ReopenedLineage[];
  /** False when the node was already current, which makes a repeated call a no-op. */
  readonly justReopened: boolean;
  readonly reopenedAt: Date;
};

/**
 * What a reopen would take, read before anything is written so a caller can show it. Reports
 * an open node as an empty lineage rather than as a miss: already current is an answer.
 */
const SUPERSESSION_PREVIEW = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
  `OPTIONAL MATCH (next)-[r:${SUPERSEDES_TYPE}]->(n)`,
  `WHERE r.${BITEMPORAL_PROPERTIES.txUntil} IS NULL`,
  'WITH n, next, r ORDER BY next.id',
  `RETURN n.id AS id, labels(n) AS labels,`,
  `       coalesce(n.${MEMORY_PROPERTIES.summary}, n.${MEMORY_PROPERTIES.text},`,
  `                n.${ENTITY_NAME_PROPERTY}, '') AS content,`,
  `       n.${BITEMPORAL_PROPERTIES.validUntil} AS valid_until,`,
  `       n.${BITEMPORAL_PROPERTIES.forgottenAt} AS forgotten_at,`,
  // The successor and its provenance are collected as one map. Collected apart, an unmatched
  // OPTIONAL MATCH drops the null id and keeps the coalesced empty provenance list, so the two
  // sides come back at different lengths.
  '       collect(CASE WHEN next IS NULL THEN null',
  '                    ELSE { id: next.id, provenance: coalesce(r.provenance, []) } END)',
  '         AS lineage',
].join('\n');

export type SupersessionPreview = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly content: string;
  readonly closed: boolean;
  readonly forgotten: boolean;
  readonly lineage: readonly ReopenedLineage[];
};

type LineageRow = { id: string; provenance: string[] | null };

function mapPreview(row: Row): SupersessionPreview {
  const lineage = (row.lineage as LineageRow[] | null) ?? [];
  return {
    id: row.id as string,
    labels: (row.labels as string[] | null) ?? [],
    content: typeof row.content === 'string' ? row.content : '',
    closed: row.valid_until instanceof Date,
    forgotten: row.forgotten_at instanceof Date,
    lineage: lineage.map((entry) => ({
      supersededBy: entry.id,
      provenance: entry.provenance ?? [],
    })),
  };
}

/** `undefined` when the id names no node at all. */
export async function previewSupersession(
  driver: Driver,
  id: string,
): Promise<SupersessionPreview | undefined> {
  const rows = await runRead(
    driver,
    { cypher: SUPERSESSION_PREVIEW, parameters: { id } },
    mapPreview,
  );
  return rows[0];
}

/**
 * A second reopen matches no row: the `tx_until IS NULL` predicate is what an already-closed
 * edge fails, so the first call's stamps stand without a `coalesce` guarding them.
 *
 * Both timelines close, not system time alone. `edges.ts` reopens a matched edge on
 * `valid_until IS NOT NULL` and clears `tx_until` under that same condition, so an edge closed
 * in system time alone can never come back: a later supersession of the same pair would re-close
 * the node while its lineage edge stayed stamped, leaving a closed node whose lineage the
 * default read drops.
 */
const CLOSE_LINEAGE_EDGES = [
  `MATCH (next)-[r:${SUPERSEDES_TYPE}]->(n:${BASE_NODE_LABEL} { id: $id })`,
  `WHERE r.${BITEMPORAL_PROPERTIES.txUntil} IS NULL`,
  `SET r.${BITEMPORAL_PROPERTIES.txUntil} = $now,`,
  `    r.${BITEMPORAL_PROPERTIES.validUntil} = $now,`,
  `    r.${EDGE_REOPENED_AT_PROPERTY} = $now`,
  'RETURN next.id AS superseded_by, coalesce(r.provenance, []) AS provenance',
  'ORDER BY superseded_by',
].join('\n');

/**
 * Removing the two stamps rather than writing a later interval: world time and system time
 * both say the claim is current again, which is what makes recall serve it. `forgotten_at` is
 * untouched, because a forget is a separate act and reopening a supersession is not consent to
 * undo one.
 */
const RESTORE_CURRENCY = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
  `WITH n, (n.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`,
  `         OR n.${BITEMPORAL_PROPERTIES.txUntil} IS NOT NULL) AS was_closed`,
  `REMOVE n.${BITEMPORAL_PROPERTIES.validUntil}, n.${BITEMPORAL_PROPERTIES.txUntil}`,
  `RETURN n.id AS id, labels(n) AS labels, was_closed,`,
  `       coalesce(n.${MEMORY_PROPERTIES.summary}, n.${MEMORY_PROPERTIES.text},`,
  `                n.${ENTITY_NAME_PROPERTY}, '') AS content`,
].join('\n');

export type UnsupersedeInput = {
  readonly id: string;
  readonly now?: Date;
};

/**
 * Closes the lineage and restores the currency in one transaction: a node current again while
 * an open `SUPERSEDES` edge still points at it would read as superseded to every lineage
 * projection, and the two halves have to land together or neither.
 */
export async function unsupersedeNode(
  driver: Driver,
  input: UnsupersedeInput,
): Promise<UnsupersedeResult> {
  const now = input.now ?? new Date();
  return inWriteTransaction(driver, async (tx) => {
    const reopenedFrom = await tx.run(
      CLOSE_LINEAGE_EDGES,
      { id: input.id, now: toGraphDateTime(now) },
      (row) => ({
        supersededBy: row.superseded_by as string,
        provenance: (row.provenance as string[] | null) ?? [],
      }),
    );
    const restored = await tx.run(RESTORE_CURRENCY, { id: input.id }, (row) => ({
      id: row.id as string,
      labels: (row.labels as string[] | null) ?? [],
      content: typeof row.content === 'string' ? row.content : '',
      wasClosed: row.was_closed === true,
    }));
    const node = restored[0];
    if (node === undefined) {
      throw new GraphNodeNotFoundError([input.id], 'unsupersede');
    }
    return {
      id: node.id,
      labels: node.labels,
      content: node.content,
      reopenedFrom,
      justReopened: node.wasClosed || reopenedFrom.length > 0,
      reopenedAt: now,
    };
  });
}
