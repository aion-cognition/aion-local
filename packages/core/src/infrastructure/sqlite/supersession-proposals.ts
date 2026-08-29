import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from './database.js';

/**
 * The pinned supersession policy's low-confidence half. A contradiction judgment the
 * reflection model is not sure enough about never touches the graph; it lands here and is
 * surfaced by `aion why` (P5) for a person to act on. Nothing in the pipeline reads these
 * rows back to apply them — that is the whole point of the split.
 */

export type SupersessionProposal = {
  id: string;
  /** The current node the judgment would close. */
  oldId: string;
  /** The node this episode minted, which would replace it. */
  newId: string;
  confidence: number;
  rationale: string | null;
  episodeId: string;
  createdAt: string;
  /** Null while the proposal is still open; a timestamp once a person has dealt with it. */
  resolvedAt: string | null;
};

type SupersessionProposalRow = {
  id: string;
  old_id: string;
  new_id: string;
  confidence: number;
  rationale: string | null;
  episode_id: string;
  created_at: string;
  resolved_at: string | null;
};

export type SupersessionProposalInput = {
  readonly oldId: string;
  readonly newId: string;
  readonly confidence: number;
  readonly rationale?: string;
  readonly episodeId: string;
  readonly createdAt?: string;
};

function toSupersessionProposal(row: SupersessionProposalRow): SupersessionProposal {
  return {
    id: row.id,
    oldId: row.old_id,
    newId: row.new_id,
    confidence: row.confidence,
    rationale: row.rationale,
    episodeId: row.episode_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Idempotent on the pair: a second judgment of the same (old, new) refreshes the confidence,
 * rationale, and episode rather than adding a row, so the orchestrator's re-run after a crash
 * before the ledger mark leaves the queue exactly as long as it was. `created_at` and
 * `resolved_at` survive the refresh — a proposal a person already resolved stays resolved.
 */
export function recordSupersessionProposal(
  db: SqliteHandle,
  input: SupersessionProposalInput,
): string {
  const row = db
    .prepare(
      `INSERT INTO supersession_proposals
         (id, old_id, new_id, confidence, rationale, episode_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(old_id, new_id) DO UPDATE SET
         confidence = excluded.confidence,
         rationale = excluded.rationale,
         episode_id = excluded.episode_id
       RETURNING id`,
    )
    .get(
      randomUUID(),
      input.oldId,
      input.newId,
      input.confidence,
      input.rationale ?? null,
      input.episodeId,
      input.createdAt ?? new Date().toISOString(),
    ) as { id: string };
  return row.id;
}

export function getSupersessionProposal(
  db: SqliteHandle,
  id: string,
): SupersessionProposal | undefined {
  const row = db.prepare('SELECT * FROM supersession_proposals WHERE id = ?').get(id) as
    | SupersessionProposalRow
    | undefined;
  return row === undefined ? undefined : toSupersessionProposal(row);
}

/** Ordered by insertion (rowid), not created_at: same-millisecond bursts would tie on the latter. */
export function listSupersessionProposals(db: SqliteHandle): SupersessionProposal[] {
  const rows = db
    .prepare('SELECT * FROM supersession_proposals ORDER BY rowid ASC')
    .all() as SupersessionProposalRow[];
  return rows.map(toSupersessionProposal);
}

/** Both directions: `aion why <id>` shows what a node would replace and what would replace it. */
export function findSupersessionProposalsForNode(
  db: SqliteHandle,
  nodeId: string,
): SupersessionProposal[] {
  const rows = db
    .prepare(
      `SELECT * FROM supersession_proposals
       WHERE old_id = ? OR new_id = ?
       ORDER BY rowid ASC`,
    )
    .all(nodeId, nodeId) as SupersessionProposalRow[];
  return rows.map(toSupersessionProposal);
}

/** Returns false when the id is unknown or the proposal was already resolved. */
export function resolveSupersessionProposal(
  db: SqliteHandle,
  id: string,
  resolvedAt: string = new Date().toISOString(),
): boolean {
  const result = db
    .prepare('UPDATE supersession_proposals SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
    .run(resolvedAt, id);
  return result.changes > 0;
}

/** Open proposals only: a resolved row is a decision already made, not a queue for anyone. */
export function countOpenSupersessionProposals(db: SqliteHandle): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM supersession_proposals WHERE resolved_at IS NULL')
    .get() as { count: number };
  return row.count;
}
