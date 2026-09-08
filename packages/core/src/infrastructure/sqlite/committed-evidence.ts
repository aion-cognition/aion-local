import type { SqliteHandle } from './database.js';
import { STATED_LINK_KINDS } from './evidence-links.js';

/**
 * Reads over the committed evidence view.
 *
 * A semantic row belongs to the committed view when the operation that owns it is
 * acknowledged. A prepared operation's rows are durable and invisible at the same time, which
 * is what lets a publication be prepared before the graph is touched without the substrate
 * claiming the write landed. A deferred or rejected operation removes nothing: the last
 * acknowledged row stands exactly as it was.
 *
 * The incidence table is a current projection, so a question about some past moment reads the
 * link's version chain instead. Both shapes are here, and the difference between them is the
 * difference between "who owns this now" and "who owned it then".
 */
export type CommittedLinkVersion = {
  readonly linkId: string;
  readonly version: number;
  readonly state: string;
  readonly recordedValuesJson: string;
  readonly temporalProofJson: string;
  readonly observedAt: string;
  readonly operationId: string;
  readonly knownFrom: string;
};

type LinkVersionRowData = {
  link_id: string;
  version: number;
  state: string;
  recorded_values_json: string;
  temporal_proof_json: string;
  observed_at: string;
  operation_id: string;
  known_from: string;
};

/**
 * A version joins the view only through its own acknowledged operation, and `known_from` is
 * assigned at that acknowledgment, so a row with either missing is not committed yet.
 */
const COMMITTED_LINK_VERSIONS = `SELECT v.link_id, v.version, v.state, v.recorded_values_json,
    v.temporal_proof_json, v.observed_at, v.operation_id, v.known_from
  FROM evidence_link_versions v
  JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
  WHERE v.known_from IS NOT NULL`;

function toLinkVersion(row: LinkVersionRowData): CommittedLinkVersion {
  return {
    linkId: row.link_id,
    version: row.version,
    state: row.state,
    recordedValuesJson: row.recorded_values_json,
    temporalProofJson: row.temporal_proof_json,
    observedAt: row.observed_at,
    operationId: row.operation_id,
    knownFrom: row.known_from,
  };
}

/** One link's committed chain, oldest first. */
export function committedLinkVersions(
  db: SqliteHandle,
  linkId: string,
): readonly CommittedLinkVersion[] {
  const rows = db
    .prepare(`${COMMITTED_LINK_VERSIONS} AND v.link_id = ? ORDER BY v.version`)
    .all(linkId) as LinkVersionRowData[];
  return rows.map(toLinkVersion);
}

/**
 * What the link said at a past moment: the newest committed version that was visible by then.
 * A version prepared before that moment but acknowledged after it is not an answer, because
 * nobody could have read it then.
 */
export function committedLinkVersionAt(
  db: SqliteHandle,
  linkId: string,
  at: Date,
): CommittedLinkVersion | undefined {
  const row = db
    .prepare(
      `${COMMITTED_LINK_VERSIONS} AND v.link_id = ? AND v.known_from <= ?
       ORDER BY v.known_from DESC, v.version DESC LIMIT 1`,
    )
    .get(linkId, at.toISOString()) as LinkVersionRowData | undefined;
  return row === undefined ? undefined : toLinkVersion(row);
}

export type CommittedIncidence = {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly role: string;
  readonly currency: 'open' | 'closed';
  readonly linkId: string;
  readonly linkVersion: number;
  /**
   * The interval the selected version recorded for itself, on a historical read. Each bound is
   * present only where the version stated one: a reader asking about a past moment needs both
   * ends of a link's own interval on both clocks, and the current projection supplies none of
   * them once a newer version exists. A bound that is absent here was never recorded, which is a
   * different answer from one that is open, and only the reader's evaluator may decide which.
   */
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly txFrom?: string;
  readonly txUntil?: string;
};

type IncidenceRowData = {
  source_id: string;
  node_id: string;
  role: string;
  currency: 'open' | 'closed';
  link_id: string;
  link_version: number;
};

const COMMITTED_INCIDENCE = `SELECT s.source_id, s.node_id, s.role, s.currency, s.link_id, s.link_version
  FROM source_incidence s
  JOIN evidence_link_versions v ON v.link_id = s.link_id AND v.version = s.link_version
  JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'`;

/**
 * The bound a caller has already charged for, spliced into the read itself. A number that arrives
 * after the rows do has bounded nothing, so every population this module returns can be asked for
 * no more than its reader was admitted to carry.
 */
function limitClause(limit: number | undefined): string {
  return limit === undefined ? '' : `LIMIT ${String(Math.max(0, Math.trunc(limit)))}`;
}

function toIncidence(row: IncidenceRowData): CommittedIncidence {
  return {
    sourceId: row.source_id,
    nodeId: row.node_id,
    role: row.role,
    currency: row.currency,
    linkId: row.link_id,
    linkVersion: row.link_version,
  };
}

/**
 * Everything the committed view says one source currently touches, narrowed to one role and to
 * the rows the caller has already charged for. The role belongs in the query rather than in a
 * filter after it: a reader bounded on relation rows must not materialize the rows it is about
 * to discard.
 */
export function committedIncidenceForSource(
  db: SqliteHandle,
  sourceId: string,
  options: { readonly role?: string; readonly limit?: number } = {},
): readonly CommittedIncidence[] {
  const roleClause = options.role === undefined ? '' : 'AND s.role = ?';
  const rows = db
    .prepare(
      `${COMMITTED_INCIDENCE} WHERE s.source_id = ? ${roleClause}
       ORDER BY s.node_id, s.role ${limitClause(options.limit)}`,
    )
    .all(sourceId, ...(options.role === undefined ? [] : [options.role])) as IncidenceRowData[];
  return rows.map(toIncidence);
}

/** How many rows that read would return, asked before it is paid for. */
export function countCommittedIncidenceForSource(
  db: SqliteHandle,
  sourceId: string,
  role: string,
): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM source_incidence s
       JOIN evidence_link_versions v ON v.link_id = s.link_id AND v.version = s.link_version
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
       WHERE s.source_id = ? AND s.role = ?`,
    )
    .get(sourceId, role) as { n: number };
  return row.n;
}

/**
 * The other direction: which sources currently carry this node, optionally in one role. This
 * is what an ownership read materializes from and what a count is derived from; neither reads
 * a stored number.
 */
export function committedIncidenceForNode(
  db: SqliteHandle,
  nodeId: string,
  role?: string,
  limit?: number,
): readonly CommittedIncidence[] {
  const roleClause = role === undefined ? '' : 'AND s.role = ?';
  const parameters = role === undefined ? [nodeId] : [nodeId, role];
  const rows = db
    .prepare(
      `${COMMITTED_INCIDENCE} WHERE s.node_id = ? ${roleClause}
       ORDER BY s.source_id, s.role ${limitClause(limit)}`,
    )
    .all(...parameters) as IncidenceRowData[];
  return rows.map(toIncidence);
}

/**
 * The same question for a batch of nodes. A serving read asks it once for every candidate it
 * holds rather than once per candidate, so the cost of the answer follows the batch rather than
 * the fan-out.
 */
export function committedIncidenceForNodes(
  db: SqliteHandle,
  nodeIds: readonly string[],
  role?: string,
): readonly CommittedIncidence[] {
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) {
    return [];
  }
  const placeholders = unique.map(() => '?').join(', ');
  const roleClause = role === undefined ? '' : 'AND s.role = ?';
  const parameters = role === undefined ? unique : [...unique, role];
  const rows = db
    .prepare(
      `${COMMITTED_INCIDENCE} WHERE s.node_id IN (${placeholders}) ${roleClause}
       ORDER BY s.node_id, s.source_id, s.role`,
    )
    .all(...parameters) as IncidenceRowData[];
  return rows.map(toIncidence);
}

/**
 * The links whose newest version acknowledged by a moment is the one that stood then. The
 * enumeration is the immutable chain, and the projection row rides along where it still exists.
 */
const HISTORICAL_INCIDENCE = `SELECT l.from_id AS source_id, l.to_id AS node_id,
    COALESCE(s.role, l.kind) AS role, COALESCE(s.currency, 'open') AS currency,
    l.link_id, v.version AS link_version, v.recorded_values_json
  FROM evidence_links l
  JOIN evidence_link_versions v ON v.link_id = l.link_id
  JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
  LEFT JOIN source_incidence s
    ON s.link_id = l.link_id AND s.source_id = l.from_id AND s.node_id = l.to_id`;

/**
 * Which acknowledged version of each link the read selects.
 *
 * A knowledge vantage takes the newest version that had entered the view by then. Without one the
 * read still goes through the chain and takes the newest acknowledged version there is, because a
 * question pinned only in world time is asked with everything the substrate knows now and needs
 * the recorded intervals that the current projection does not carry.
 */
function knownBy(at: Date | undefined): {
  readonly clause: string;
  readonly parameters: readonly string[];
} {
  const bound = at === undefined ? '' : 'AND h.known_from <= ?';
  const newest = `AND v.version = (
           SELECT MAX(h.version) FROM evidence_link_versions h
           JOIN publication_intents hi
             ON hi.operation_id = h.operation_id AND hi.state = 'acknowledged'
           WHERE h.link_id = l.link_id AND h.known_from IS NOT NULL ${bound}
         )`;
  if (at === undefined) {
    return { clause: `AND v.known_from IS NOT NULL ${newest}`, parameters: [] };
  }
  const moment = at.toISOString();
  return {
    clause: `AND v.known_from IS NOT NULL AND v.known_from <= ? ${newest}`,
    parameters: [moment, moment],
  };
}

/**
 * The same batch as it stood at a past moment.
 *
 * Incidence is a current projection: its `link_version` pointer says which version is in force
 * now, and its row can be gone entirely while the link that recorded it is not. The version
 * chain is what holds the past, so the walk starts from the links and their recorded values,
 * takes the newest version acknowledged by that moment, and reads the projection only for the
 * two fields it alone names: the role it was recorded under and the currency it carries now.
 * With that row gone, the link's own kind is the recorded classification and the values on the
 * version supply the rest. Enumerating the rows instead would report a retired projection as a
 * link that was never stated.
 *
 * Stated references are the one thing excluded: they are relations between endpoints rather
 * than incidence, and only their own projection row names the role they are held under.
 */
export function committedIncidenceForNodesAt(
  db: SqliteHandle,
  nodeIds: readonly string[],
  at: Date | undefined,
  role?: string,
  limit?: number,
): readonly CommittedIncidence[] {
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) {
    return [];
  }
  const placeholders = unique.map(() => '?').join(', ');
  const kinds = STATED_LINK_KINDS.map(() => '?').join(', ');
  const roleClause = role === undefined ? '' : 'AND COALESCE(s.role, l.kind) = ?';
  const known = knownBy(at);
  const rows = db
    .prepare(
      `${HISTORICAL_INCIDENCE}
       WHERE l.to_id IN (${placeholders})
         AND (s.role IS NOT NULL OR l.kind NOT IN (${kinds})) ${roleClause}
         ${known.clause}
       ORDER BY node_id, source_id, role ${limitClause(limit)}`,
    )
    .all(
      ...unique,
      ...STATED_LINK_KINDS,
      ...(role === undefined ? [] : [role]),
      ...known.parameters,
    ) as (IncidenceRowData & {
    recorded_values_json: string;
  })[];
  return rows.map(toHistoricalIncidence);
}

/**
 * How many rows one node's role held at a past moment, charged before the chain is materialized.
 *
 * The present projection cannot answer it. A retired projection leaves a count of zero over a
 * chain that still holds three origins, so a reader charging the current count and then reading
 * the history has bounded nothing at all: count and read the same population at the same vantage.
 */
export function countCommittedIncidenceForNodeAt(
  db: SqliteHandle,
  nodeId: string,
  at: Date | undefined,
  role: string,
): number {
  const kinds = STATED_LINK_KINDS.map(() => '?').join(', ');
  const known = knownBy(at);
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM (${HISTORICAL_INCIDENCE}
       WHERE l.to_id = ?
         AND (s.role IS NOT NULL OR l.kind NOT IN (${kinds}))
         AND COALESCE(s.role, l.kind) = ?
         ${known.clause})`,
    )
    .get(nodeId, ...STATED_LINK_KINDS, role, ...known.parameters) as { n: number };
  return row.n;
}

/**
 * The other direction at a past moment: everything one source carried then, read from the same
 * chain. A subject join that fell back to the records needs it, because the present rows say
 * what the source carries now and nothing about what it carried at the vantage asked for.
 */
export function committedIncidenceForSourceAt(
  db: SqliteHandle,
  sourceId: string,
  at: Date | undefined,
  options: { readonly role?: string; readonly limit?: number } = {},
): readonly CommittedIncidence[] {
  const kinds = STATED_LINK_KINDS.map(() => '?').join(', ');
  const known = knownBy(at);
  const roleClause = options.role === undefined ? '' : 'AND COALESCE(s.role, l.kind) = ?';
  const rows = db
    .prepare(
      `${HISTORICAL_INCIDENCE}
       WHERE l.from_id = ?
         AND (s.role IS NOT NULL OR l.kind NOT IN (${kinds})) ${roleClause}
         ${known.clause}
       ORDER BY node_id, role ${limitClause(options.limit)}`,
    )
    .all(
      sourceId,
      ...STATED_LINK_KINDS,
      ...(options.role === undefined ? [] : [options.role]),
      ...known.parameters,
    ) as (IncidenceRowData & {
    recorded_values_json: string;
  })[];
  return rows.map(toHistoricalIncidence);
}

/** The same population's size at the same vantage, asked before any of it is materialized. */
export function countCommittedIncidenceForSourceAt(
  db: SqliteHandle,
  sourceId: string,
  at: Date | undefined,
  role: string,
): number {
  const kinds = STATED_LINK_KINDS.map(() => '?').join(', ');
  const known = knownBy(at);
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM (${HISTORICAL_INCIDENCE}
       WHERE l.from_id = ?
         AND (s.role IS NOT NULL OR l.kind NOT IN (${kinds}))
         AND COALESCE(s.role, l.kind) = ?
         ${known.clause})`,
    )
    .get(sourceId, ...STATED_LINK_KINDS, role, ...known.parameters) as { n: number };
  return row.n;
}

function statedStamp(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/**
 * The state the selected version recorded, and nothing the present row says about now.
 *
 * The projection's currency describes the link today. Borrowing it for a past vantage would
 * report a link that was open then as closed because it is closed now, so a version that stated
 * no currency is read as open and the row's own value is left where it belongs.
 */
function toHistoricalIncidence(
  row: IncidenceRowData & { recorded_values_json: string },
): CommittedIncidence {
  const stated = JSON.parse(row.recorded_values_json) as {
    currency?: unknown;
    valid_from?: unknown;
    valid_until?: unknown;
    tx_from?: unknown;
    tx_until?: unknown;
  };
  const bounds = {
    validFrom: statedStamp(stated.valid_from),
    validUntil: statedStamp(stated.valid_until),
    txFrom: statedStamp(stated.tx_from),
    txUntil: statedStamp(stated.tx_until),
  };
  return {
    ...toIncidence(row),
    currency: stated.currency === 'closed' ? 'closed' : 'open',
    ...Object.fromEntries(Object.entries(bounds).filter(([, value]) => value !== undefined)),
  };
}

/**
 * How many committed rows one node's role holds, without materializing them. A reader with a
 * bound charges what a read will cost before it pays it, which a count can answer and a page of
 * rows cannot.
 */
export function countCommittedIncidenceForNode(
  db: SqliteHandle,
  nodeId: string,
  role: string,
): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM source_incidence s
       JOIN evidence_link_versions v ON v.link_id = s.link_id AND v.version = s.link_version
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
       WHERE s.node_id = ? AND s.role = ?`,
    )
    .get(nodeId, role) as { n: number };
  return row.n;
}
