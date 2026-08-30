import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';
import { proposalTable } from './proposal-table.js';

/**
 * Cross-type near-duplicates found by the dedup stage. Uniqueness is on `(name_norm, type)`,
 * so `Postgres (tool)` and `Postgres (concept)` are two permanently separate identities and no
 * merge can join them without deciding which type was the mistake. That decision is a person's;
 * detection lands here and nothing in the pipeline reads these rows back to apply them.
 */

export type EntityMergeProposal = {
  id: string;
  leftId: string;
  leftName: string;
  leftType: string;
  rightId: string;
  rightName: string;
  rightType: string;
  /** Cosine between the two name vectors at detection time. */
  similarity: number;
  episodeId: string;
  createdAt: string;
  /** Null while the proposal is still open; a timestamp once a person has dealt with it. */
  resolvedAt: string | null;
};

type EntityMergeProposalRow = {
  id: string;
  left_id: string;
  left_name: string;
  left_type: string;
  right_id: string;
  right_name: string;
  right_type: string;
  similarity: number;
  episode_id: string;
  created_at: string;
  resolved_at: string | null;
};

export type EntityMergeProposalSide = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
};

export type EntityMergeProposalInput = {
  readonly subject: EntityMergeProposalSide;
  readonly candidate: EntityMergeProposalSide;
  readonly similarity: number;
  readonly episodeId: string;
  readonly createdAt?: string;
};

function toEntityMergeProposal(row: EntityMergeProposalRow): EntityMergeProposal {
  return {
    id: row.id,
    leftId: row.left_id,
    leftName: row.left_name,
    leftType: row.left_type,
    rightId: row.right_id,
    rightName: row.right_name,
    rightType: row.right_type,
    similarity: row.similarity,
    episodeId: row.episode_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

const proposals = proposalTable<EntityMergeProposalRow, EntityMergeProposal>({
  table: 'entity_merge_proposals',
  pairColumns: ['left_id', 'right_id'],
  mapRow: toEntityMergeProposal,
});

/**
 * Idempotent on the id-sorted pair: the same two entities detected again from either side
 * refresh the row rather than adding one, so a stage re-run after a crash before the ledger
 * mark leaves the queue exactly as long as it was. `created_at` and `resolved_at` survive the
 * refresh: a proposal a person already resolved stays resolved.
 */
export function recordEntityMergeProposal(
  db: SqliteHandle,
  input: EntityMergeProposalInput,
): string {
  const ordered =
    input.subject.id <= input.candidate.id
      ? [input.subject, input.candidate]
      : [input.candidate, input.subject];
  const left = ordered[0];
  const right = ordered[1];
  if (left === undefined || right === undefined) {
    throw new Error('entity merge proposal needs both sides');
  }

  const row = db
    .prepare(
      `INSERT INTO entity_merge_proposals
         (id, left_id, left_name, left_type, right_id, right_name, right_type,
          similarity, episode_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(left_id, right_id) DO UPDATE SET
         left_name = excluded.left_name,
         left_type = excluded.left_type,
         right_name = excluded.right_name,
         right_type = excluded.right_type,
         similarity = excluded.similarity,
         episode_id = excluded.episode_id
       RETURNING id`,
    )
    .get(
      randomUUID(),
      left.id,
      left.name,
      left.type,
      right.id,
      right.name,
      right.type,
      input.similarity,
      input.episodeId,
      input.createdAt ?? new Date().toISOString(),
    ) as { id: string };
  return row.id;
}

export function getEntityMergeProposal(
  db: SqliteHandle,
  id: string,
): EntityMergeProposal | undefined {
  return proposals.get(db, id);
}

/** Ordered by insertion (rowid), not created_at: same-millisecond bursts would tie on the latter. */
export function listEntityMergeProposals(db: SqliteHandle): EntityMergeProposal[] {
  return proposals.list(db);
}

export function findEntityMergeProposalsForNode(
  db: SqliteHandle,
  nodeId: string,
): EntityMergeProposal[] {
  return proposals.findForNode(db, nodeId);
}

/** Returns false when the id is unknown or the proposal was already resolved. */
export function resolveEntityMergeProposal(
  db: SqliteHandle,
  id: string,
  resolvedAt: string = new Date().toISOString(),
): boolean {
  return proposals.resolve(db, id, resolvedAt);
}

/** Open proposals only: a resolved row is a decision already made, not a queue for anyone. */
export function countOpenEntityMergeProposals(db: SqliteHandle): number {
  return proposals.countOpen(db);
}
