import type { WithheldWork } from '../../evidence/application/judgment.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  markInventoryComplete,
  reopenSourceWork,
} from '../../infrastructure/sqlite/generation-lifecycle.js';
import {
  completeSourceWork,
  readActiveGeneration,
  stageWorkId,
} from '../../infrastructure/sqlite/processing-generations.js';
import {
  committedForget,
  hasPendingSourceState,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  readGenerationWork,
  readPolicyStages,
} from '../../infrastructure/sqlite/source-readiness.js';
import { evaluateProcessingReadiness } from '../domain/readiness.js';
import {
  stageSettlementOf,
  STAGE_ALREADY_APPLIED_SUMMARY,
  type ReflectionSummary,
  type StageSettlement,
} from '../domain/stage.js';

/**
 * What a completed run says about the obligations its source held.
 *
 * A stage that settled says so with a typed disposition and the evidence behind it; that row is
 * closed with the disposition it declared. A stage that produced nothing and declared nothing is
 * still owed, and all this records is why, because prose is not proof and reading a settlement
 * out of it is how an unprocessed source passes for a finished one.
 *
 * Every write here is synchronous, so the caller runs it inside the same transaction that
 * completes the job. A run whose queue completion rolls back leaves its obligations exactly as
 * they were.
 */

export type StageSettlementReport = {
  /** Rows this run closed with a typed outcome. */
  readonly settled: readonly string[];
  /** Required stages still owed, with the reason recorded against each row. */
  readonly owed: readonly string[];
  /** Required stages with no row at all, which leaves the inventory unaccountable. */
  readonly unrecorded: readonly string[];
  /** Whether the generation's inventory now accounts for everything its policy required. */
  readonly inventoryComplete: boolean;
};

const EMPTY: StageSettlementReport = {
  settled: [],
  owed: [],
  unrecorded: [],
  inventoryComplete: false,
};

/**
 * Applies a run's stage dispositions to the source's active generation.
 *
 * A source with no active generation records nothing: there is no inventory to settle against,
 * and inventing one here would credit a pass to a generation nobody allocated.
 */
export function recordStageSettlements(
  db: SqliteHandle,
  sourceId: string,
  summary: ReflectionSummary,
  now: Date,
): StageSettlementReport {
  const generation = readActiveGeneration(db, sourceId);
  if (generation === undefined) {
    return EMPTY;
  }
  const held = new Map(
    readGenerationWork(db, sourceId, generation.processingGeneration)
      .filter((row) => row.kind === 'stage' && row.stageName !== null)
      .map((row) => [row.stageName ?? '', row]),
  );

  const requiredStages = readPolicyStages(db, generation.policyRevision);
  const settled: string[] = [];
  const owed: string[] = [];
  const close = (stageName: string, settlement: StageSettlement): void => {
    completeSourceWork(
      db,
      stageWorkId(sourceId, generation.processingGeneration, stageName),
      {
        outcome: settlement.disposition,
        reason: settlement.reason,
        ...(settlement.proof === undefined ? {} : { proof: { ...settlement.proof } }),
      },
      now,
    );
    settled.push(stageName);
  };

  const deferred: { readonly name: string; readonly settlement: StageSettlement }[] = [];
  for (const record of summary.stages) {
    const row = held.get(record.name);
    if (row === undefined || row.state === 'completed' || row.state === 'obsolete') {
      continue;
    }
    const settlement = stageSettlementOf(record);
    if (settlement !== undefined) {
      close(record.name, settlement);
      continue;
    }
    const remainder = record.withheldWork ?? [];
    if (record.settledOnUpstream !== undefined && remainder.length === 0) {
      deferred.push({ name: record.name, settlement: record.settledOnUpstream });
      continue;
    }
    // A ledger skip means an earlier run already decided this stage; its row was settled then
    // or is owed for a reason that run recorded, and this run has nothing to add.
    if (record.summary !== STAGE_ALREADY_APPLIED_SUMMARY) {
      recordOwedReason(db, row.workId, `${record.status}: ${record.summary}`, remainder);
      owed.push(record.name);
    }
  }

  // The second pass, taken against the rows as they now stand rather than against this run's
  // records: a predecessor settled by an earlier attempt counts, and one this run left owed
  // means the empty reading was a stage waiting rather than a stage with nothing to do.
  //
  // It runs in the policy's order and adds each close to the set, because a chain of proved-empty
  // stages settles from the front: the second one's predecessor is the first one, and reading a
  // set taken before the pass would leave it owed for a stage that has since closed.
  if (deferred.length > 0) {
    const closed = new Set(
      readGenerationWork(db, sourceId, generation.processingGeneration)
        .filter((row) => row.kind === 'stage' && row.state === 'completed')
        .map((row) => row.stageName ?? ''),
    );
    for (const entry of inPolicyOrder(requiredStages, deferred)) {
      const row = held.get(entry.name);
      if (row === undefined) {
        continue;
      }
      if (upstreamSettled(requiredStages, entry.name, closed)) {
        close(entry.name, entry.settlement);
        closed.add(entry.name);
        continue;
      }
      recordOwedReason(db, row.workId, `waiting on an earlier stage: ${entry.settlement.reason}`);
      owed.push(entry.name);
    }
  }

  applyForgetDisposition(db, sourceId, generation.processingGeneration, now, close);

  const readiness = evaluateProcessingReadiness({
    sourceId,
    generation: {
      processingGeneration: generation.processingGeneration,
      policyRevision: generation.policyRevision,
      inputDigest: generation.inputDigest,
      operationalRevision: generation.operationalRevision,
    },
    requiredStages,
    work: readGenerationWork(db, sourceId, generation.processingGeneration),
  });
  const unrecorded = readiness.stages
    .filter((stage) => stage.disposition === 'unrecorded')
    .map((stage) => stage.stageName);
  // Row presence is not the test. The inventory accounts for its policy when every required
  // stage carries a TYPED outcome, so a generation whose rows are all still pending is not an
  // accounted one. Obligations of other kinds may still stand; readiness reports those.
  const accounted =
    readiness.stages.length === requiredStages?.length &&
    readiness.stages.every(
      (stage) => stage.disposition === 'complete' || stage.disposition === 'not_applicable',
    );
  markInventoryComplete(db, sourceId, generation.processingGeneration, accounted);
  return { settled, owed, unrecorded, inventoryComplete: accounted };
}

/** The deferred entries in the order the policy runs them, so a chain settles from the front. */
function inPolicyOrder<T extends { readonly name: string }>(
  requiredStages: readonly string[] | undefined,
  entries: readonly T[],
): readonly T[] {
  if (requiredStages === undefined) {
    return entries;
  }
  return [...entries].sort(
    (a, b) => requiredStages.indexOf(a.name) - requiredStages.indexOf(b.name),
  );
}

/**
 * The signed forget disposition, applied to what the run left owed.
 *
 * A forgotten source's generative passes have nothing left to act on, so their rows close as not
 * applicable with the acknowledged statement as proof. Settlement and indexing obligations are
 * untouched: those are owed whatever became of the content. It is reversible in the same place,
 * because an unforget withdraws the statement the disposition rested on and the rows it closed
 * are owed again.
 *
 * A statement prepared and not yet acknowledged decides nothing either way. The answer is about
 * to move and nothing here can say which way.
 */
function applyForgetDisposition(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
  now: Date,
  close: (stageName: string, settlement: StageSettlement) => void,
): void {
  if (hasPendingSourceState(db, sourceId)) {
    return;
  }
  const forget = committedForget(db, sourceId);
  for (const row of readGenerationWork(db, sourceId, processingGeneration)) {
    const { stageName } = row;
    if (row.kind !== 'stage' || stageName === null || row.state === 'obsolete') {
      continue;
    }
    if (forget !== undefined && row.state !== 'completed') {
      close(stageName, {
        disposition: 'not_applicable',
        reason: 'source_forgotten',
        proof: { stateVersion: forget.version, knownFrom: forget.knownFrom },
      });
      continue;
    }
    if (forget === undefined && row.outcome?.reason === 'source_forgotten') {
      reopenSourceWork(db, row.workId, 'the forget this row rested on was withdrawn', now);
    }
  }
}

/**
 * Whether every stage the policy runs ahead of this one has settled.
 *
 * The policy's order is the pipeline's, so "earlier" is exactly "produces what this reads". A
 * stage the policy does not list at all cannot answer the question and is treated as unsettled,
 * which keeps the empty reading owed.
 */
function upstreamSettled(
  requiredStages: readonly string[] | undefined,
  stageName: string,
  closed: ReadonlySet<string>,
): boolean {
  if (requiredStages === undefined) {
    return false;
  }
  const position = requiredStages.indexOf(stageName);
  if (position < 0) {
    return false;
  }
  return requiredStages.slice(0, position).every((name) => closed.has(name));
}

/**
 * Why a required stage is still owed, recorded on its row without changing its state.
 *
 * A remainder is recorded with it, whole: the pairs the pass could not decide, the addresses a
 * rebuild reads them back through, and the evidence each abstention rested on. Without that the
 * row says work is owed and nothing says which work.
 */
function recordOwedReason(
  db: SqliteHandle,
  workId: string,
  reason: string,
  remainder: readonly WithheldWork[] = [],
): void {
  db.prepare(
    `UPDATE source_work SET reason = ?, attempts = attempts + 1
     WHERE work_id = ? AND state IN ('pending','retryable')`,
  ).run(reason.slice(0, 500), workId);
  if (remainder.length === 0) {
    return;
  }
  db.prepare(
    `UPDATE source_work SET continuation_json = ?
     WHERE work_id = ? AND state IN ('pending','retryable')`,
  ).run(JSON.stringify({ withheldWork: remainder }), workId);
}
