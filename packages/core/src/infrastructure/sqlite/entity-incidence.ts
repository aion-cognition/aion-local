import { COMMITTED_INCIDENCE } from './committed-evidence.js';
import type { SqliteHandle } from './database.js';

/**
 * Bounded reads of the sources the committed view records against an entity.
 *
 * An entity's history only grows, so nothing here counts it or returns it whole. Each read asks
 * for at most the rows its caller has already charged for, newest first, and SQLite does the
 * ordering over the node's own rows before any of them reach the caller.
 */

export type IncidentSource = {
  readonly sourceId: string;
  /** `open` when any of the source's rows in these roles is still current. */
  readonly currency: 'open' | 'closed';
};

type IncidentRow = { source_id: string; currency: 'open' | 'closed' };

/**
 * Committed rows for one node in the given roles, one per source. A source recorded under two of
 * the roles is one source, and it counts as current if either row is.
 */
const INCIDENT = `SELECT c.source_id, MAX(c.currency) AS currency
  FROM (${COMMITTED_INCIDENCE}) c
  WHERE c.node_id = @nodeId AND c.role IN (SELECT value FROM json_each(@roles))
    AND c.source_id NOT IN (SELECT value FROM json_each(@exclude))
    AND (@alsoIncidentTo IS NULL OR EXISTS (
      SELECT 1 FROM (${COMMITTED_INCIDENCE}) o
      WHERE o.source_id = c.source_id AND o.node_id = @alsoIncidentTo
        AND o.role IN (SELECT value FROM json_each(@roles))))
  GROUP BY c.source_id`;

/**
 * The newest sources first, with distinct contexts ahead of repeats.
 *
 * Captures with the same verified content are one capture shown once, the newest standing for
 * the rest. Then each session's newest capture comes before any session's second, so a burst of
 * captures from one exchange does not fill every seat. Both use fields the source records
 * already hold. A source with no world clock sorts after every source that has one.
 */
const NEWEST = `WITH incident AS (${INCIDENT}),
  placed AS (
    SELECT n.source_id, n.currency, r.occurred_at, r.session_id,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(r.verified_content_digest, n.source_id)
        ORDER BY r.occurred_at IS NULL, r.occurred_at DESC, n.source_id DESC) AS copy
    FROM incident n LEFT JOIN source_records r ON r.source_id = n.source_id
  ),
  spread AS (
    SELECT source_id, currency, occurred_at,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(session_id, source_id)
        ORDER BY occurred_at IS NULL, occurred_at DESC, source_id DESC) AS turn
    FROM placed WHERE copy = 1
  )
  SELECT source_id, currency FROM spread
  ORDER BY turn, occurred_at IS NULL, occurred_at DESC, source_id DESC
  LIMIT @limit`;

/**
 * Up to `limit` sources recorded against one node in the given roles, newest first. With
 * `alsoIncidentTo` only the sources recorded against both nodes are read, which is how a pair's
 * shared captures are found without reading either side's whole history.
 */
export function newestIncidentSources(
  db: SqliteHandle,
  input: {
    readonly nodeId: string;
    readonly roles: readonly string[];
    readonly alsoIncidentTo?: string;
    readonly exclude: readonly string[];
    readonly limit: number;
  },
): readonly IncidentSource[] {
  if (input.limit <= 0) {
    return [];
  }
  const rows = db.prepare(NEWEST).all({
    nodeId: input.nodeId,
    roles: JSON.stringify(input.roles),
    alsoIncidentTo: input.alsoIncidentTo ?? null,
    exclude: JSON.stringify(input.exclude),
    limit: Math.trunc(input.limit),
  }) as IncidentRow[];
  return rows.map((row) => ({ sourceId: row.source_id, currency: row.currency }));
}

export type SourceIncidence = {
  readonly nodeId: string;
  readonly role: string;
  readonly currency: 'open' | 'closed';
};

/**
 * Which of the given nodes one source is recorded against, in the given roles. A primary-key
 * lookup, so its cost is the handful of rows it can return and never the node's history.
 */
export function incidenceOfSource(
  db: SqliteHandle,
  input: {
    readonly sourceId: string;
    readonly nodeIds: readonly string[];
    readonly roles: readonly string[];
    readonly limit: number;
  },
): readonly SourceIncidence[] {
  const rows = db
    .prepare(
      `SELECT c.node_id, c.role, c.currency FROM (${COMMITTED_INCIDENCE}) c
       WHERE c.source_id = @sourceId AND c.node_id IN (SELECT value FROM json_each(@nodeIds))
         AND c.role IN (SELECT value FROM json_each(@roles))
       ORDER BY c.node_id, c.role LIMIT @limit`,
    )
    .all({
      sourceId: input.sourceId,
      nodeIds: JSON.stringify(input.nodeIds),
      roles: JSON.stringify(input.roles),
      limit: Math.max(0, Math.trunc(input.limit)),
    }) as { node_id: string; role: string; currency: 'open' | 'closed' }[];
  return rows.map((row) => ({ nodeId: row.node_id, role: row.role, currency: row.currency }));
}
