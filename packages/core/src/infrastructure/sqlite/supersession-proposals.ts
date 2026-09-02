import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';
import {
  countOpenProposals,
  findProposalsForNode,
  getProposal,
  listOldestOpenProposals,
  listOpenProposalCreatedAt,
  listProposals,
  reopenProposal,
  resolveProposal,
  type ProposalTableSpec,
} from './proposal-table.js';

/**
 * The record of every affirmative supersession judgment, whichever mode ruled on it. A close
 * resolves its row on the way out. A veto leaves the row open carrying the veto, so
 * `aion proposals ls` shows both what the judge wanted and what stopped it.
 *
 * An open row is a queue a person acts on with `aion proposals apply`. The supersession stage
 * reaches that same apply path itself under `AION_SUPERSEDE_MODE=unanimous` and stamps
 * `supersession_unanimous_auto`, so lineage separates an autonomous close from a reviewed one.
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
  /** Required: the caller owns the clock, so no row can carry a stamp nobody chose. */
  readonly createdAt: string;
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

const PROPOSALS: ProposalTableSpec<SupersessionProposalRow, SupersessionProposal> = {
  table: 'supersession_proposals',
  pairColumns: ['old_id', 'new_id'],
  mapRow: toSupersessionProposal,
};

/**
 * Idempotent on the pair: a second judgment of the same (old, new) refreshes the confidence,
 * rationale, and episode rather than adding a row, so the orchestrator's re-run after a crash
 * before the ledger mark leaves the queue exactly as long as it was. `created_at` and
 * `resolved_at` survive the refresh: a proposal a person already resolved stays resolved.
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
      input.createdAt,
    ) as { id: string };
  return row.id;
}

export function getSupersessionProposal(
  db: SqliteHandle,
  id: string,
): SupersessionProposal | undefined {
  return getProposal(db, PROPOSALS, id);
}

/** Ordered by insertion (rowid), not created_at: same-millisecond bursts would tie on the latter. */
export function listSupersessionProposals(db: SqliteHandle): SupersessionProposal[] {
  return listProposals(db, PROPOSALS);
}

/** Every open row's creation stamp, oldest first, for a caller that reads ages and not rows. */
export function listOpenSupersessionProposalCreatedAt(db: SqliteHandle): string[] {
  return listOpenProposalCreatedAt(db, PROPOSALS);
}

/** The oldest unresolved rows, bounded in SQL for a caller that weighs age. */
export function listOldestOpenSupersessionProposals(
  db: SqliteHandle,
  limit: number,
): SupersessionProposal[] {
  return listOldestOpenProposals(db, PROPOSALS, limit);
}

/** Both directions: `aion why <id>` shows what a node would replace and what would replace it. */
export function findSupersessionProposalsForNode(
  db: SqliteHandle,
  nodeId: string,
): SupersessionProposal[] {
  return findProposalsForNode(db, PROPOSALS, nodeId);
}

/** Returns false when the id is unknown or the proposal was already resolved. */
export function resolveSupersessionProposal(
  db: SqliteHandle,
  id: string,
  resolvedAt: string,
): boolean {
  return resolveProposal(db, PROPOSALS, id, resolvedAt);
}

/** Open proposals only: a resolved row is a decision already made, not a queue for anyone. */
export function countOpenSupersessionProposals(db: SqliteHandle): number {
  return countOpenProposals(db, PROPOSALS);
}

/** Returns false when the id is unknown or the proposal is already open. */
export function reopenSupersessionProposal(db: SqliteHandle, id: string): boolean {
  return reopenProposal(db, PROPOSALS, id);
}
