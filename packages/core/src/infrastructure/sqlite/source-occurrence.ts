import type { SqliteHandle } from './database.js';
import { sourceResidencyState } from './source-lifecycle.js';
import { hasPendingSourceState, isSourceForgotten } from './source-state-versions.js';

/**
 * Which source an accepted payload belongs to, decided from the durable records rather than
 * from the graph.
 *
 * The graph answered this before, by looking for an episode with the same content hash in the
 * same session. That answer disappears the moment the raw projection does, and it cannot tell a
 * source that was forgotten from one that was evicted: both are absent, and only one of them
 * should mint a new occurrence. These records can tell them apart, so identity comes from here
 * and the graph is not consulted.
 *
 * A forgotten source's replacement is a new occurrence with its own ids, clocks and reference
 * history. The forget stamp on the old one is never touched, which is what makes the statement
 * survive its replacement.
 */
export type OccurrenceKey = {
  /** sha256 over identity, content hash and archive schema version: the archive's own key. */
  readonly identityHash: string;
  readonly sessionId: string;
};

export type OccurrenceResolution =
  /** Nothing has been accepted under this key. A new source. */
  | { readonly kind: 'absent' }
  /**
   * One live occurrence holds the key. Its id is returned unchanged, whatever its storage:
   * an evicted duplicate answers with the original id and rebuilds no projection.
   */
  | {
      readonly kind: 'held';
      readonly sourceId: string;
      readonly residency: 'resident' | 'retiring' | 'evicted';
    }
  /** Every occurrence under this key was forgotten, so the push is a new occurrence. */
  | { readonly kind: 'forgotten'; readonly priorSourceIds: readonly string[] }
  /**
   * A statement about one of these occurrences is prepared and not yet acknowledged, so the
   * answer is about to move. Disclosed rather than guessed: treating a pending forget as
   * committed would mint a replacement for a source that is still there.
   */
  | { readonly kind: 'uncertain'; readonly sourceIds: readonly string[] }
  /** More than one live occurrence claims the key. Pinned; nothing is minted or selected. */
  | { readonly kind: 'ambiguous'; readonly sourceIds: readonly string[] };

type CandidateRow = {
  source_id: string;
  created_at: string;
};

/**
 * Every source whose archive proof carries this key, oldest first. An alias row belongs to the
 * occurrence that owns it and is not a candidate of its own, which is why the canonical archive
 * id is not what this reads: two occurrences of one payload have different canonical rows and
 * the same key.
 */
export function occurrenceCandidates(db: SqliteHandle, key: OccurrenceKey): readonly string[] {
  const rows = db
    .prepare(
      `SELECT source_id, created_at FROM source_records
       WHERE identity_hash = ? AND session_id = ?
       ORDER BY created_at, source_id`,
    )
    .all(key.identityHash, key.sessionId) as CandidateRow[];
  return rows.map((row) => row.source_id);
}

/**
 * The authoritative selection, taken under whatever lock the caller holds. It is a read, so
 * running it outside one is a hint and nothing more: a forget landing between the hint and the
 * write is exactly the race the guarded recheck exists for.
 */
export function resolveSourceOccurrence(
  db: SqliteHandle,
  key: OccurrenceKey,
): OccurrenceResolution {
  const candidates = occurrenceCandidates(db, key);
  if (candidates.length === 0) {
    return { kind: 'absent' };
  }
  const pending = candidates.filter((sourceId) => hasPendingSourceState(db, sourceId));
  if (pending.length > 0) {
    return { kind: 'uncertain', sourceIds: pending };
  }
  const live = candidates.filter((sourceId) => !isSourceForgotten(db, sourceId));
  if (live.length === 0) {
    return { kind: 'forgotten', priorSourceIds: candidates };
  }
  if (live.length > 1) {
    return { kind: 'ambiguous', sourceIds: live };
  }
  const sourceId = live[0] ?? '';
  return { kind: 'held', sourceId, residency: sourceResidencyState(db, sourceId) };
}

/**
 * One logical occurrence in the live ingest order, with the raw row its bytes live in.
 *
 * A consumer walking sources reads this rather than the archive: a replacement occurrence shares
 * its forgotten predecessor's canonical row, so enumerating archive rows visits the predecessor
 * and never the source that is actually here.
 */
export type SourceOccurrence = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly ingestPosition: number;
  readonly canonicalArchiveId: string | null;
  /** The occurrence's own world time, which a replacement does not share with its predecessor. */
  readonly occurredAt: string;
};

export type OccurrenceFilter = {
  readonly sourceId?: string;
  readonly sessionId?: string;
  /** Selects occurrences whose raw row was written under some other pipeline version. */
  readonly excludePipelineVersion?: string;
};

/**
 * A page of occurrences after `position`, oldest first by ingest order.
 *
 * The ingest position is the cursor because it is handed out once and never reused, so a page
 * boundary cannot be crossed twice and a backdated arrival cannot slip behind a mark an earlier
 * pass already passed. World time cannot do that: an experience from 2020 accepted today sorts
 * before rows a previous pass has already walked.
 */
export function listSourceOccurrencesAfter(
  db: SqliteHandle,
  position: number,
  limit: number,
  filter: OccurrenceFilter = {},
): readonly SourceOccurrence[] {
  const clauses: string[] = [];
  const parameters: unknown[] = [position];
  if (filter.sourceId !== undefined) {
    clauses.push('AND r.source_id = ?');
    parameters.push(filter.sourceId);
  }
  if (filter.sessionId !== undefined) {
    clauses.push('AND r.session_id = ?');
    parameters.push(filter.sessionId);
  }
  if (filter.excludePipelineVersion !== undefined) {
    clauses.push('AND (a.pipeline_version IS NULL OR a.pipeline_version <> ?)');
    parameters.push(filter.excludePipelineVersion);
  }
  const rows = db
    .prepare(
      `SELECT r.source_id, r.session_id, i.id AS ingest_position, r.canonical_archive_id,
              r.occurred_at
       FROM source_records r
       JOIN ingest_log i ON i.source_id = r.source_id
       LEFT JOIN experience_archive a ON a.id = r.canonical_archive_id
       WHERE i.id > ? ${clauses.join(' ')}
       ORDER BY i.id
       LIMIT ?`,
    )
    .all(...parameters, limit) as {
    source_id: string;
    session_id: string;
    ingest_position: number;
    canonical_archive_id: string | null;
    occurred_at: string;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    sessionId: row.session_id,
    ingestPosition: row.ingest_position,
    canonicalArchiveId: row.canonical_archive_id,
    occurredAt: row.occurred_at,
  }));
}

/** Whether any archive row still has no occurrence record, which is what the fallback is for. */
export function unrecordedArchiveRows(db: SqliteHandle): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM experience_archive a
       WHERE NOT EXISTS (SELECT 1 FROM source_records r WHERE r.source_id = a.episode_id)`,
    )
    .get() as { n: number };
  return row.n;
}
