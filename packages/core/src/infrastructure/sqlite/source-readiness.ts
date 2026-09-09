import { createHash } from 'node:crypto';

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

/**
 * The durable detail a stage row carries beside its state: what the work was measured against,
 * which capability revision it was handed to, and where it got to. Kept apart from `RecordedWork`
 * because the readiness evaluation judges states and outcomes, and these are what a caller
 * validating a transfer or classifying an effect has to read.
 */
export type StageWorkDetail = {
  readonly stageName: string;
  readonly state: SourceWorkState;
  readonly capabilityRevision: number | null;
  readonly inputRevisionJson: string | null;
  readonly continuationJson: string | null;
};

export function readStageWorkDetail(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
): readonly StageWorkDetail[] {
  const rows = db
    .prepare(
      `SELECT stage_name, state, capability_revision, input_revision_json, continuation_json
       FROM source_work
       WHERE source_id = ? AND processing_generation = ? AND kind = 'stage'
         AND stage_name IS NOT NULL
       ORDER BY stage_name`,
    )
    .all(sourceId, processingGeneration) as {
    stage_name: string;
    state: SourceWorkState;
    capability_revision: number | null;
    input_revision_json: string | null;
    continuation_json: string | null;
  }[];
  return rows.map((row) => ({
    stageName: row.stage_name,
    state: row.state,
    capabilityRevision: row.capability_revision,
    inputRevisionJson: row.input_revision_json,
    continuationJson: row.continuation_json,
  }));
}

/**
 * One comparable value per stage row for what it owes and what that rests on.
 *
 * The state is deliberately absent. A settlement moves it, and a pass that settled its own row
 * has not been invalidated by doing so; what invalidates a recorded pass is the row gaining work
 * or evidence the pass never saw.
 */
export function stageWorkDigests(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const row of readStageWorkDetail(db, sourceId, processingGeneration)) {
    digests[row.stageName] = createHash('sha256')
      .update(JSON.stringify([row.continuationJson, row.inputRevisionJson, row.capabilityRevision]))
      .digest('hex');
  }
  return digests;
}

/** The runners a policy revision allows a transferred obligation to name. */
export function readPolicyTransferCapabilities(
  db: SqliteHandle,
  policyRevision: number,
): readonly string[] | undefined {
  const row = db
    .prepare('SELECT transfer_capabilities_json FROM readiness_policies WHERE policy_revision = ?')
    .get(policyRevision) as { transfer_capabilities_json: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.transfer_capabilities_json) as string[]);
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
  /** A generation names a policy revision this store cannot read, so nothing says what it owes. */
  | 'unreadable_policy'
  /** A generation has no row for a stage its policy requires, so its inventory is incomplete. */
  | 'incomplete_inventory'
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
 * How many of the policy's required stages this generation has no row for.
 *
 * By NAME, one required identity at a time. A count of stage rows compared with the length of the
 * policy's list says nothing about whether the rows are the required ones: an extra or obsolete
 * row fills the missing slot arithmetically and the source reads as accounted while the pass it
 * owes has no row at all.
 */
const MISSING_REQUIRED_STAGES = `(SELECT count(*) FROM json_each(p.stages_json) req
   WHERE NOT EXISTS (SELECT 1 FROM source_work sw
     WHERE sw.source_id = g.source_id AND sw.processing_generation = g.processing_generation
       AND sw.kind = 'stage' AND sw.stage_name = req.value))`;

/**
 * What one session's sources still owe, in one indexed read.
 *
 * Distinct sources, counted once however many obligations each holds and however many archive
 * rows alias to it. Evicted sources are in the population, because the records outlive the
 * projection and a count that dropped them would report a session getting smaller as it aged.
 *
 * A session holding a source with no active generation, one whose policy revision this store
 * cannot read, one whose inventory has no row for a stage that policy requires, or one that owes
 * an inventory because it was accepted before any policy existed, gets no number at all. That
 * census is missing rather than empty, and returning zero for it is how an unprocessed session
 * reads as a finished one.
 *
 * A forgotten source is not filtered out here. Its generative rows carry a typed
 * `source_forgotten` outcome once the settlement records one, and until they do the work is
 * genuinely outstanding: hiding it behind a predicate would report the disposition before
 * anything made it.
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
         count(DISTINCT CASE WHEN g.source_id IS NOT NULL AND p.policy_revision IS NULL
                             THEN r.source_id END) AS unreadable,
         count(DISTINCT CASE WHEN p.policy_revision IS NOT NULL
                              AND ${MISSING_REQUIRED_STAGES} > 0
                             THEN r.source_id END) AS incomplete,
         count(DISTINCT CASE WHEN w.kind = 'inventory'
                              AND w.state IN ${OUTSTANDING_STATES}
                             THEN r.source_id END) AS unaccounted,
         count(DISTINCT CASE WHEN w.state IN ${OUTSTANDING_STATES} AND w.kind != 'judgment'
                             THEN r.source_id END) AS owing,
         count(DISTINCT CASE WHEN w.kind = 'judgment' AND w.state IN ${OUTSTANDING_STATES}
                             THEN w.work_id END) AS judgments
       FROM source_records r
       LEFT JOIN source_processing_generations g
         ON g.source_id = r.source_id AND g.state = 'active'
       LEFT JOIN readiness_policies p ON p.policy_revision = g.policy_revision
       LEFT JOIN source_work w
         ON w.source_id = g.source_id AND w.processing_generation = g.processing_generation
       WHERE r.session_id = ?`,
    )
    .get(sessionId) as {
    sources: number;
    ungenerated: number;
    unreadable: number;
    incomplete: number;
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
  // The inventory obligation answers first: a source accepted before any policy existed names no
  // readable revision on purpose, and its own row says so more precisely than the policy read
  // below could.
  if (row.unaccounted > 0) {
    return {
      status: 'unavailable',
      reason: 'inventory_obligation',
      detail: `${String(row.unaccounted)} of ${String(row.sources)} sources still owe an inventory`,
    };
  }
  // Then the policy, then the inventory it requires. In that order because with no readable
  // policy there is no required stage list, and comparing a row count against a NULL length is
  // the comparison that answers NULL and drops the source out of every CASE around it.
  if (row.unreadable > 0) {
    return {
      status: 'unavailable',
      reason: 'unreadable_policy',
      detail: `${String(row.unreadable)} of ${String(row.sources)} sources name a policy revision this store cannot read`,
    };
  }
  if (row.incomplete > 0) {
    return {
      status: 'unavailable',
      reason: 'incomplete_inventory',
      detail: `${String(row.incomplete)} of ${String(row.sources)} sources have no row for a stage their policy requires`,
    };
  }
  return {
    status: 'measured',
    sources: row.sources,
    sourcesOwingWork: row.owing,
    pendingJudgments: row.judgments,
  };
}
