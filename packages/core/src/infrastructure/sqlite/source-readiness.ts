import type { SqliteHandle } from './database.js';
import type {
  RecordedOutcome,
  RecordedWork,
  SourceWorkState,
} from '../../reflection/domain/readiness.js';

/**
 * The readiness records, read.
 *
 * Two questions live here. One source's obligations, which a readiness evaluation turns into a
 * disposition, and one session's, which recall reports as what the session still owes. Both are
 * asked of the durable records rather than of the graph, so an evicted source answers exactly as
 * a resident one and a session's count does not move when a projection goes.
 */

type WorkRowData = {
  work_id: string;
  kind: string;
  stage_name: string | null;
  work_key: string;
  state: SourceWorkState;
  reason: string | null;
  outcome_json: string | null;
};

function toRecordedWork(row: WorkRowData): RecordedWork {
  return {
    workId: row.work_id,
    kind: row.kind,
    stageName: row.stage_name,
    workKey: row.work_key,
    state: row.state,
    reason: row.reason,
    outcome:
      row.outcome_json === null ? undefined : (JSON.parse(row.outcome_json) as RecordedOutcome),
  };
}

/** Every obligation one generation holds, whatever its state. */
export function readGenerationWork(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
): readonly RecordedWork[] {
  const rows = db
    .prepare(
      `SELECT work_id, kind, stage_name, work_key, state, reason, outcome_json
       FROM source_work
       WHERE source_id = ? AND processing_generation = ?
       ORDER BY kind, work_key`,
    )
    .all(sourceId, processingGeneration) as WorkRowData[];
  return rows.map(toRecordedWork);
}

/** The stage set a policy revision required, or nothing when that revision was never published. */
export function readPolicyStages(
  db: SqliteHandle,
  policyRevision: number,
): readonly string[] | undefined {
  const row = db
    .prepare('SELECT stages_json FROM readiness_policies WHERE policy_revision = ?')
    .get(policyRevision) as { stages_json: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.stages_json) as string[]);
}

/** Why a session's obligation count cannot be given, when it cannot. */
export type SessionCensusGap =
  /** The session holds archived experiences the identity records do not yet account for. */
  | 'unbackfilled'
  /** A source in the session has no active generation, so its obligations are unaccounted. */
  | 'missing_generation'
  /** A source was accepted before any readiness policy existed and owes an inventory. */
  | 'inventory_obligation';

export type SessionObligationCensus =
  | {
      readonly status: 'measured';
      /** Distinct sources the session holds, counted once each whatever they owe. */
      readonly sources: number;
      /** Distinct sources with at least one outstanding obligation. */
      readonly sourcesOwingWork: number;
      /** Optional judgment work, which is a separate population from required processing. */
      readonly pendingJudgments: number;
    }
  | { readonly status: 'unavailable'; readonly reason: SessionCensusGap; readonly detail: string };

const OUTSTANDING_STATES = `('pending','retryable','transferred','pinned','dead_letter')`;

/**
 * The latest acknowledged forget statement on a source, as a scalar. Suppression removes the
 * source-dependent generative obligations from the count and leaves settlement and indexing
 * where they are: those are owed whatever became of the content.
 */
const LATEST_FORGET = `(SELECT sv.state_kind FROM source_state_versions sv
   WHERE sv.source_id = r.source_id
     AND sv.state_kind IN ('forgotten','unforgotten')
     AND sv.known_from IS NOT NULL
   ORDER BY sv.version DESC LIMIT 1)`;

/**
 * What one session's sources still owe, in one indexed read.
 *
 * Distinct sources, counted once however many obligations each holds and however many archive
 * rows alias to it. Evicted sources are in the population, because the records outlive the
 * projection and a count that dropped them would report a session getting smaller as it aged.
 *
 * A session holding a source with no active generation, or one that owes an inventory because it
 * was accepted before any policy existed, gets no number at all. That census is missing rather
 * than empty, and returning zero for it is how an unprocessed session reads as a finished one.
 */
export function sessionObligationCensus(
  db: SqliteHandle,
  sessionId: string,
): SessionObligationCensus {
  // Before anything is counted: an archived experience this session holds that no source record
  // accounts for means the identity census has not reached this session. Every count below is
  // over the records, so an unbackfilled session would otherwise measure as a session that owes
  // nothing at all.
  const unbackfilled = db
    .prepare(
      `SELECT count(*) AS n FROM experience_archive e
       LEFT JOIN source_records r ON r.source_id = e.episode_id
       WHERE e.session_id = ? AND r.source_id IS NULL`,
    )
    .get(sessionId) as { n: number };
  if (unbackfilled.n > 0) {
    return {
      status: 'unavailable',
      reason: 'unbackfilled',
      detail: `${String(unbackfilled.n)} archived experiences in this session have no source record`,
    };
  }
  const row = db
    .prepare(
      `SELECT
         count(DISTINCT r.source_id) AS sources,
         count(DISTINCT CASE WHEN g.source_id IS NULL THEN r.source_id END) AS ungenerated,
         count(DISTINCT CASE WHEN w.kind = 'inventory'
                              AND w.state IN ${OUTSTANDING_STATES}
                             THEN r.source_id END) AS unaccounted,
         count(DISTINCT CASE WHEN w.state IN ${OUTSTANDING_STATES}
                              AND w.kind != 'judgment'
                              AND (w.kind != 'stage'
                                   OR COALESCE(${LATEST_FORGET}, '') != 'forgotten')
                             THEN r.source_id END) AS owing,
         count(DISTINCT CASE WHEN w.kind = 'judgment' AND w.state IN ${OUTSTANDING_STATES}
                             THEN w.work_id END) AS judgments
       FROM source_records r
       LEFT JOIN source_processing_generations g
         ON g.source_id = r.source_id AND g.state = 'active'
       LEFT JOIN source_work w
         ON w.source_id = g.source_id AND w.processing_generation = g.processing_generation
       WHERE r.session_id = ?`,
    )
    .get(sessionId) as {
    sources: number;
    ungenerated: number;
    unaccounted: number;
    owing: number;
    judgments: number;
  };
  if (row.ungenerated > 0) {
    return {
      status: 'unavailable',
      reason: 'missing_generation',
      detail: `${String(row.ungenerated)} of ${String(row.sources)} sources have no active processing generation`,
    };
  }
  if (row.unaccounted > 0) {
    return {
      status: 'unavailable',
      reason: 'inventory_obligation',
      detail: `${String(row.unaccounted)} of ${String(row.sources)} sources still owe an inventory`,
    };
  }
  return {
    status: 'measured',
    sources: row.sources,
    sourcesOwingWork: row.owing,
    pendingJudgments: row.judgments,
  };
}
