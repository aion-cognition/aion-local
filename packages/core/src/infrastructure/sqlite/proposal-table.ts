import type { SqliteHandle } from './database.js';

/**
 * Both proposal queues (supersession, entity merge) are the same table shape wearing different
 * column names: an `id`, two node columns naming the pair the proposal is about, and a
 * `resolved_at` that is null while a person still owes the row a decision. Reading one, listing
 * them, finding the ones that touch a node, resolving one, and counting what is left are
 * therefore one set of queries over three facts, written once here.
 *
 * The `record*` inserts stay in their own modules. Their column lists differ, their inputs
 * differ (flat versus a pair of sides), and entity merge normalizes the pair by id before
 * inserting, so a shared insert would be a switch statement wearing a factory's clothes.
 *
 * List order is insertion (rowid), not `created_at`: a burst detected inside one millisecond
 * would tie on the latter and come back in an order SQLite is free to change between runs.
 */

export type ProposalTableSpec<TRow, TProposal> = {
  /** Interpolated into SQL, so it takes a literal from this package and never caller input. */
  readonly table: string;
  /** The two node columns naming the pair, in insert order. Either side matches a node lookup. */
  readonly pairColumns: readonly [string, string];
  readonly mapRow: (row: TRow) => TProposal;
};

export function getProposal<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
  id: string,
): TProposal | undefined {
  const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id) as TRow | undefined;
  return row === undefined ? undefined : spec.mapRow(row);
}

export function listProposals<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
): TProposal[] {
  const rows = db.prepare(`SELECT * FROM ${spec.table} ORDER BY rowid ASC`).all() as TRow[];
  return rows.map(spec.mapRow);
}

export type OpenProposalPage<TProposal> = {
  readonly proposals: readonly TProposal[];
  /** Rowid of the last row on this page, which is where the next page starts. */
  readonly lastRowid?: number;
};

/**
 * One page of open rows in insertion order, for a caller that must walk the whole open queue
 * across runs. Resolved rows are never deleted, so a caller that read every row and filtered in
 * memory would grow with the table forever; and a caller that always took the first page would
 * never see an open row behind a page of rows it cannot act on.
 */
export function listOpenProposalsAfter<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
  options: { readonly limit: number; readonly afterRowid?: number },
): OpenProposalPage<TProposal> {
  const rows = db
    .prepare(
      `SELECT rowid AS proposal_rowid, * FROM ${spec.table}
       WHERE resolved_at IS NULL AND rowid > ?
       ORDER BY rowid ASC LIMIT ?`,
    )
    .all(options.afterRowid ?? 0, options.limit) as (TRow & { proposal_rowid: number })[];
  const last = rows.at(-1);
  return {
    proposals: rows.map(spec.mapRow),
    ...(last === undefined ? {} : { lastRowid: last.proposal_rowid }),
  };
}

/**
 * The oldest open rows, bounded in SQL. Age is what hygiene weighs, so the ceiling has to be
 * applied to the oldest rows rather than to whichever ones were inserted first.
 */
export function listOldestOpenProposals<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
  limit: number,
): TProposal[] {
  const rows = db
    .prepare(
      `SELECT * FROM ${spec.table}
       WHERE resolved_at IS NULL
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(limit) as TRow[];
  return rows.map(spec.mapRow);
}

export function findProposalsForNode<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
  nodeId: string,
): TProposal[] {
  const [leftColumn, rightColumn] = spec.pairColumns;
  const rows = db
    .prepare(
      `SELECT * FROM ${spec.table}
       WHERE ${leftColumn} = ? OR ${rightColumn} = ?
       ORDER BY rowid ASC`,
    )
    .all(nodeId, nodeId) as TRow[];
  return rows.map(spec.mapRow);
}

/** The `resolved_at IS NULL` guard is what makes a second resolve report false, not true. */
export function resolveProposal<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
  id: string,
  resolvedAt: string,
): boolean {
  const result = db
    .prepare(`UPDATE ${spec.table} SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`)
    .run(resolvedAt, id);
  return result.changes > 0;
}

/** The mirror guard: only a currently resolved row has anything to reopen. */
export function reopenProposal<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
  id: string,
): boolean {
  const result = db
    .prepare(`UPDATE ${spec.table} SET resolved_at = NULL WHERE id = ? AND resolved_at IS NOT NULL`)
    .run(id);
  return result.changes > 0;
}

/**
 * Every open row's `created_at`, oldest first, and nothing else. The health tick reads ages
 * rather than rows, and reading whole rows made it grow with an archive of resolved proposals
 * it does not look at.
 */
export function listOpenProposalCreatedAt<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
): string[] {
  const rows = db
    .prepare(
      `SELECT created_at FROM ${spec.table}
       WHERE resolved_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all() as { created_at: string }[];
  return rows.map((row) => row.created_at);
}

export function countOpenProposals<TRow, TProposal>(
  db: SqliteHandle,
  spec: ProposalTableSpec<TRow, TProposal>,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE resolved_at IS NULL`)
    .get() as { count: number };
  return row.count;
}
