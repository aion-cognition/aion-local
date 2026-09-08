import type { SqliteHandle } from './database.js';

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

/** Everything the committed view says one source currently touches. */
export function committedIncidenceForSource(
  db: SqliteHandle,
  sourceId: string,
): readonly CommittedIncidence[] {
  const rows = db
    .prepare(`${COMMITTED_INCIDENCE} WHERE s.source_id = ? ORDER BY s.node_id, s.role`)
    .all(sourceId) as IncidenceRowData[];
  return rows.map(toIncidence);
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
): readonly CommittedIncidence[] {
  const roleClause = role === undefined ? '' : 'AND s.role = ?';
  const parameters = role === undefined ? [nodeId] : [nodeId, role];
  const rows = db
    .prepare(
      `${COMMITTED_INCIDENCE} WHERE s.node_id = ? ${roleClause} ORDER BY s.source_id, s.role`,
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

export type CommittedSourceState = {
  readonly sourceId: string;
  readonly version: number;
  readonly stateKind: string;
  readonly operationId: string;
  readonly knownFrom: string;
  readonly observedAt: string;
  readonly detailJson: string | null;
};

type SourceStateRowData = {
  source_id: string;
  version: number;
  state_kind: string;
  operation_id: string;
  known_from: string;
  observed_at: string;
  detail_json: string | null;
};

/**
 * A source's committed forget and suppression history, oldest first. It survives the content
 * it applies to, so a question about a source whose parts are gone still has an answer.
 */
export function committedSourceStates(
  db: SqliteHandle,
  sourceId: string,
): readonly CommittedSourceState[] {
  const rows = db
    .prepare(
      `SELECT s.source_id, s.version, s.state_kind, s.operation_id, s.known_from, s.observed_at,
              s.detail_json
       FROM source_state_versions s
       JOIN publication_intents i ON i.operation_id = s.operation_id AND i.state = 'acknowledged'
       WHERE s.source_id = ? AND s.known_from IS NOT NULL
       ORDER BY s.version`,
    )
    .all(sourceId) as SourceStateRowData[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    version: row.version,
    stateKind: row.state_kind,
    operationId: row.operation_id,
    knownFrom: row.known_from,
    observedAt: row.observed_at,
    detailJson: row.detail_json,
  }));
}
