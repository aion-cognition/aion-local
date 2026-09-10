import type { SqliteHandle } from './database.js';
import type { EvidenceRevision } from '../publication/preconditions.js';

/**
 * What the published narrative revisions cite, in both directions, selected at the vantage the
 * question was asked from. Split out of the revision lifecycle so a reader of the citation
 * records never has to reason about allocation, retry or head bookkeeping.
 */

export type CitedBy = {
  readonly narrativeNodeId: string;
  readonly targetKind: string;
};

/**
 * Every revision of both families that ever published, with the interval it was the family's
 * answer: from the moment it entered the view until a successor closed it.
 *
 * Publication is immutable evidence; being the current head is a selection over it. A revision
 * that published at ten and was closed at eleven was the answer at half ten, and a reader that
 * kept only rows whose state is still `published` would report a citation set that was never
 * retracted as one that never existed.
 */
const EVER_PUBLISHED = `SELECT node_id, known_from, closed_at, state FROM chunk_revisions
    WHERE known_from IS NOT NULL AND state IN ('published', 'closed')
  UNION ALL
  SELECT node_id, known_from, closed_at, state FROM overview_revisions
    WHERE known_from IS NOT NULL AND state IN ('published', 'closed')`;

type Selection = { readonly clause: string; readonly parameters: readonly string[] };

/**
 * Which revision the family was serving. A question about a past vantage selects the revision
 * that held the interval containing it; a question about now selects the current head, because a
 * closed revision is no longer what the family serves.
 *
 * This is representation selection, and it belongs to the reader that asks which revision speaks
 * for a family now, or spoke for it then.
 */
function headSelection(at: Date | undefined): Selection {
  if (at === undefined) {
    return { clause: "AND p.state = 'published'", parameters: [] };
  }
  const moment = at.toISOString();
  return {
    clause: 'AND p.known_from <= ? AND (p.closed_at IS NULL OR p.closed_at > ?)',
    parameters: [moment, moment],
  };
}

/**
 * Whether a named revision published at all, and had published by the vantage asked about.
 *
 * A caller following a recorded parent is not asking which revision the family serves. It named
 * this one, and what that revision cited is a fact about it: a successor taking over the family
 * changes which revision is current and changes nothing about what its predecessor rested on. So
 * retirement never withdraws it, and the only bound is that it had published by K.
 */
function publicationSelection(at: Date | undefined): Selection {
  return at === undefined
    ? { clause: '', parameters: [] }
    : { clause: 'AND p.known_from <= ?', parameters: [at.toISOString()] };
}

/**
 * The published revisions that cite one target, read from the citation records themselves. A
 * part is cited under its own address, so two parts of one source stay two citations.
 *
 * This is the binding question, so it selects the revision the family serves: without a vantage,
 * what is published now; with one, whichever revision held that moment.
 */
export function readCitationsOf(db: SqliteHandle, targetId: string, at?: Date): readonly CitedBy[] {
  const selection = headSelection(at);
  const rows = db
    .prepare(
      `SELECT c.narrative_node_id, c.target_kind FROM revision_citations c
       JOIN (${EVER_PUBLISHED}) p ON p.node_id = c.narrative_node_id
       WHERE c.target_id = ? ${selection.clause}
       ORDER BY c.narrative_node_id`,
    )
    .all(targetId, ...selection.parameters) as {
    narrative_node_id: string;
    target_kind: string;
  }[];
  return rows.map((row) => ({
    narrativeNodeId: row.narrative_node_id,
    targetKind: row.target_kind,
  }));
}

/** What one revision cites, which is the outbound half a lineage walk crosses. */
export type Citation = {
  readonly targetId: string;
  readonly targetKind: string;
};

/**
 * The targets one narrative revision cites at a vantage, selected by publication rather than by
 * headship. A revision is a witness's own step in a chain: what it rests on is what it named, and
 * the walk crosses it the way it crosses a source, whether or not a successor has taken the
 * family since.
 */
export function readCitationsFrom(
  db: SqliteHandle,
  narrativeNodeId: string,
  at?: Date,
): readonly Citation[] {
  const selection = publicationSelection(at);
  const rows = db
    .prepare(
      `SELECT c.target_id, c.target_kind FROM revision_citations c
       JOIN (${EVER_PUBLISHED}) p ON p.node_id = c.narrative_node_id
       WHERE c.narrative_node_id = ? ${selection.clause}
       ORDER BY c.target_kind, c.target_id`,
    )
    .all(narrativeNodeId, ...selection.parameters) as {
    target_id: string;
    target_kind: string;
  }[];
  return rows.map((row) => ({ targetId: row.target_id, targetKind: row.target_kind }));
}

/** How many targets a revision cites, charged before the rows are read, on the same selection. */
export function countCitationsFrom(db: SqliteHandle, narrativeNodeId: string, at?: Date): number {
  const selection = publicationSelection(at);
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM revision_citations c
       JOIN (${EVER_PUBLISHED}) p ON p.node_id = c.narrative_node_id
       WHERE c.narrative_node_id = ? ${selection.clause}`,
    )
    .get(narrativeNodeId, ...selection.parameters) as { n: number };
  return row.n;
}

/**
 * Whether an id names a revision that had published by the vantage, which decides whether it has
 * citations to cross. It agrees with the outbound count and read: a walk that could follow the
 * citations must be able to recognize the revision holding them.
 */
export function isNarrativeRevisionNode(db: SqliteHandle, nodeId: string, at?: Date): boolean {
  const selection = publicationSelection(at);
  return (
    db
      .prepare(
        `SELECT 1 AS found FROM (${EVER_PUBLISHED}) p
         WHERE p.node_id = ? ${selection.clause} LIMIT 1`,
      )
      .get(nodeId, ...selection.parameters) !== undefined
  );
}

/**
 * The reverse index from an endpoint to the narrative revisions that rested on it.
 *
 * The authoritative dependency set is the revision's own stored `EvidenceRevision`, which carries
 * the record kind as well; these rows exist so a writer that changed one endpoint can find the
 * revisions to re-check without reading every revision's JSON. The scope name determines the
 * store and the record class on its own, so nothing is lost by keying on it.
 */
export function recordRevisionDependencies(
  db: SqliteHandle,
  narrativeNodeId: string,
  revision: EvidenceRevision,
): void {
  const statement = db.prepare(
    `INSERT INTO revision_dependencies (endpoint_id, relation_class, narrative_node_id, version_token)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint_id, relation_class, narrative_node_id)
       DO UPDATE SET version_token = excluded.version_token`,
  );
  for (const dependency of revision.dependencies) {
    statement.run(dependency.id, dependency.scope, narrativeNodeId, dependency.version);
  }
}

export type RevisionDependencyRow = {
  readonly endpointId: string;
  readonly relationClass: string;
  readonly narrativeNodeId: string;
  readonly versionToken: string;
};

/** Which revisions rested on this endpoint, which is what an invalidation sweep nominates from. */
export function revisionsDependingOn(
  db: SqliteHandle,
  endpointId: string,
): readonly RevisionDependencyRow[] {
  const rows = db
    .prepare(
      `SELECT endpoint_id, relation_class, narrative_node_id, version_token
       FROM revision_dependencies WHERE endpoint_id = ?
       ORDER BY relation_class, narrative_node_id`,
    )
    .all(endpointId) as {
    endpoint_id: string;
    relation_class: string;
    narrative_node_id: string;
    version_token: string;
  }[];
  return rows.map((row) => ({
    endpointId: row.endpoint_id,
    relationClass: row.relation_class,
    narrativeNodeId: row.narrative_node_id,
    versionToken: row.version_token,
  }));
}

export type RevisionCitation = {
  readonly targetId: string;
  readonly targetKind: string;
};

/** What the published revision cited. Written in the transaction that acknowledges it. */
export function recordRevisionCitations(
  db: SqliteHandle,
  narrativeNodeId: string,
  citations: readonly RevisionCitation[],
): void {
  const statement = db.prepare(
    `INSERT OR IGNORE INTO revision_citations (narrative_node_id, target_id, target_kind)
     VALUES (?, ?, ?)`,
  );
  for (const citation of citations) {
    statement.run(narrativeNodeId, citation.targetId, citation.targetKind);
  }
}
