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

export type ProposalTableQueries<TProposal> = {
  get: (db: SqliteHandle, id: string) => TProposal | undefined;
  list: (db: SqliteHandle) => TProposal[];
  findForNode: (db: SqliteHandle, nodeId: string) => TProposal[];
  resolve: (db: SqliteHandle, id: string, resolvedAt: string) => boolean;
  /** The undo for `resolve`: flips a resolved row back open. A no-op on a row still open. */
  reopen: (db: SqliteHandle, id: string) => boolean;
  countOpen: (db: SqliteHandle) => number;
};

export function proposalTable<TRow, TProposal>(
  spec: ProposalTableSpec<TRow, TProposal>,
): ProposalTableQueries<TProposal> {
  const { table, mapRow } = spec;
  const [leftColumn, rightColumn] = spec.pairColumns;

  return {
    get(db, id) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as TRow | undefined;
      return row === undefined ? undefined : mapRow(row);
    },

    list(db) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all() as TRow[];
      return rows.map(mapRow);
    },

    findForNode(db, nodeId) {
      const rows = db
        .prepare(
          `SELECT * FROM ${table}
           WHERE ${leftColumn} = ? OR ${rightColumn} = ?
           ORDER BY rowid ASC`,
        )
        .all(nodeId, nodeId) as TRow[];
      return rows.map(mapRow);
    },

    /** The `resolved_at IS NULL` guard is what makes a second resolve report false, not true. */
    resolve(db, id, resolvedAt) {
      const result = db
        .prepare(`UPDATE ${table} SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`)
        .run(resolvedAt, id);
      return result.changes > 0;
    },

    /** The mirror guard: only a currently resolved row has anything to reopen. */
    reopen(db, id) {
      const result = db
        .prepare(`UPDATE ${table} SET resolved_at = NULL WHERE id = ? AND resolved_at IS NOT NULL`)
        .run(id);
      return result.changes > 0;
    },

    countOpen(db) {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE resolved_at IS NULL`)
        .get() as { count: number };
      return row.count;
    },
  };
}
