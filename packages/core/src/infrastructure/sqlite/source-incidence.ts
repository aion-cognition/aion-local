import type { SqliteHandle } from './database.js';

/**
 * The one way an incidence row is written.
 *
 * A row says a source stands behind a node in a named ROLE, and it is the current projection of
 * an immutable link. A historical question resolves through the link's version chain, and where
 * the projection row is gone the only thing left to answer the role with is the link's own kind.
 * That works exactly as long as the two agree, so agreement is a writer-side invariant here
 * rather than an assumption the reader makes: a write whose link is classified as one thing and
 * whose role says another is refused, not stored for a later reader to guess at.
 */
export type IncidenceRow = {
  readonly sourceId: string;
  readonly nodeId: string;
  /** The role this source plays for this node. It must equal the link's recorded kind. */
  readonly role: string;
  readonly linkId: string;
  readonly linkVersion: number;
  readonly currency: 'open' | 'closed';
  /** The clocks the incidence held, recorded with it so a pinned read can place the row. */
  readonly clocks?: Record<string, unknown>;
};

export class IncidenceRoleMismatch extends Error {
  constructor(linkId: string, role: string, kind: string) {
    super(`incidence on link ${linkId} claims role ${role} where the link is classified ${kind}`);
    this.name = 'IncidenceRoleMismatch';
  }
}

/**
 * Records one incidence against its link, refusing a role the link does not carry.
 *
 * The link has to exist first: an incidence with no link behind it has no version chain, so no
 * historical read of it could ever be proved. A repeated write of the same row moves it forward
 * to the version and currency the caller supplies, which is what makes a replayed publication
 * idempotent.
 */
export function commitSourceIncidence(db: SqliteHandle, row: IncidenceRow): void {
  const link = db.prepare('SELECT kind FROM evidence_links WHERE link_id = ?').get(row.linkId) as
    { kind: string } | undefined;
  if (link === undefined) {
    throw new Error(`incidence names link ${row.linkId}, which no evidence link records`);
  }
  if (link.kind !== row.role) {
    throw new IncidenceRoleMismatch(row.linkId, row.role, link.kind);
  }
  db.prepare(
    `INSERT INTO source_incidence
       (source_id, node_id, role, currency, clocks_json, link_id, link_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, node_id, role) DO UPDATE SET
       currency = excluded.currency,
       clocks_json = COALESCE(excluded.clocks_json, source_incidence.clocks_json),
       link_id = excluded.link_id,
       link_version = excluded.link_version`,
  ).run(
    row.sourceId,
    row.nodeId,
    row.role,
    row.currency,
    row.clocks === undefined ? null : JSON.stringify(row.clocks),
    row.linkId,
    row.linkVersion,
  );
}

/**
 * Closes an incidence without removing it. A retired mention is evidence that the mention was
 * there and is not any more, which a deletion would destroy.
 */
export function closeSourceIncidence(
  db: SqliteHandle,
  key: { readonly sourceId: string; readonly nodeId: string; readonly role: string },
  clocks?: Record<string, unknown>,
): boolean {
  return (
    db
      .prepare(
        `UPDATE source_incidence
         SET currency = 'closed', clocks_json = COALESCE(?, clocks_json)
         WHERE source_id = ? AND node_id = ? AND role = ?`,
      )
      .run(clocks === undefined ? null : JSON.stringify(clocks), key.sourceId, key.nodeId, key.role)
      .changes === 1
  );
}
