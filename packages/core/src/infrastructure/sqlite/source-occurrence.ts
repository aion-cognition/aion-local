import type { SqliteHandle } from './database.js';
import { isSourceForgotten, sourceResidencyState } from './source-lifecycle.js';

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

/** Whether a resolution names a source to reuse rather than one to mint. */
export function heldSourceId(resolution: OccurrenceResolution): string | undefined {
  return resolution.kind === 'held' ? resolution.sourceId : undefined;
}
