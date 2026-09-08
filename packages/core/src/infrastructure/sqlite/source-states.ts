import type { SqliteHandle } from './database.js';

/**
 * What has been stated about a source itself: its forgets, its suppressions, and their reversals.
 *
 * Kept apart from the incidence reads because it is a different record with a different lifetime.
 * A state statement has no second endpoint to hang a link version on, and it outlives the content
 * it applies to, so a question about a source whose parts are gone still has an answer here.
 */

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
