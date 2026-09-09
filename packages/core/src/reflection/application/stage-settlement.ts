import { admitsTransfer } from './readiness.js';
import type { WithheldWork } from '../../evidence/application/judgment.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  markInventoryComplete,
  reopenSourceWork,
} from '../../infrastructure/sqlite/generation-lifecycle.js';
import {
  advanceOperationalRevision,
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
  readPolicyTransferCapabilities,
  readStageWorkDetail,
  type StageWorkDetail,
} from '../../infrastructure/sqlite/source-readiness.js';
import {
  ContinuationEffectSchema,
  TransferContinuationSchema,
  TransferEvidenceSchema,
} from '../domain/continuation-schema.js';
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
      recordOwedReason(
        db,
        sourceId,
        generation.processingGeneration,
        row.workId,
        `${record.status}: ${record.summary}`,
        remainder,
      );
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
      recordOwedReason(
        db,
        sourceId,
        generation.processingGeneration,
        row.workId,
        `waiting on an earlier stage: ${entry.settlement.reason}`,
      );
      owed.push(entry.name);
    }
  }

  const detail = new Map(
    readStageWorkDetail(db, sourceId, generation.processingGeneration).map((row) => [
      row.stageName,
      row,
    ]),
  );
  applyForgetDisposition(db, sourceId, generation.processingGeneration, now, close, {
    detail,
    requiredStages,
  });

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
  // Row presence is not the test, and neither is terminality. The inventory accounts for its
  // policy when every required stage carries a TYPED outcome OR names owed work somebody can
  // still run: a supported transfer is accounted for and is not finished, which are two answers
  // to two questions. A generation whose rows are all still pending answers neither.
  const capabilities = readPolicyTransferCapabilities(db, generation.policyRevision);
  const accounted =
    readiness.stages.length === requiredStages?.length &&
    readiness.stages.every(
      (stage) =>
        stage.disposition === 'complete' ||
        stage.disposition === 'not_applicable' ||
        (stage.disposition === 'transferred' &&
          transferAccounted(detail.get(stage.stageName), capabilities)),
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
  work: {
    readonly detail: ReadonlyMap<string, StageWorkDetail>;
    readonly requiredStages: readonly string[] | undefined;
  },
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
    // The effect decides, not the container, and it is classified positively from the row's own
    // declaration or the accepted contract. A row that owes consistency work on RETAINED
    // endpoints, and a row whose effect nothing classifies, are both left alone: forgetting the
    // source does not make another node's neighbourhood correct.
    if (!forgetDisposesOf(stageName, work.requiredStages, work.detail.get(stageName))) {
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
 * What a stage's remaining work would DO, which is what the forget ruling classifies on.
 *
 * `source_generation` is generative use of the source's own content, and a forgotten source
 * leaves it nothing to act on. `retained_endpoint` is consistency work about OTHER nodes, which
 * is owed whatever became of this source.
 */
type StageEffect = 'source_generation' | 'retained_endpoint';

/**
 * Effects a row's continuation may declare, and what each one is about.
 *
 * A closed set, declared where it is read. An effect this build does not register is
 * unclassified: the row said what it is carrying and nothing here knows what that is.
 */
const DECLARED_EFFECTS: Readonly<Record<string, StageEffect>> = {
  retained_endpoint_vector: 'retained_endpoint',
  source_dependent_generation: 'source_generation',
};

/**
 * What each stage the contract lists does, from C8 section 2's stage table.
 *
 * Extraction, the bounded nomination passes and the relation passes are generative use of the
 * source. The stages that are absent are absent on purpose: a reinforcement flush and a context
 * vector recompute act on retained endpoints, the narrative dispatch belongs to a coverage
 * revision, and none of that stops being owed because this source was forgotten. A stage name
 * nothing here classifies is unclassified for the same reason a row is: nobody said what its
 * pass does, and absence of a classification is not proof the work vanished with the source.
 */
const CONTRACT_STAGE_EFFECTS: Readonly<Record<string, StageEffect>> = {
  entities: 'source_generation',
  cognitive: 'source_generation',
  'entity-dedup': 'source_generation',
  associations: 'source_generation',
  'semantic-relationships': 'source_generation',
  supersession: 'source_generation',
};

/**
 * What the row says its remaining work is, or nothing when it says nothing about its effect.
 *
 * A continuation that is a transfer or a withheld remainder declares no effect and answers
 * nothing here; the accepted contract classifies those rows instead.
 */
function declaredEffect(
  row: StageWorkDetail | undefined,
): StageEffect | 'unclassified' | undefined {
  if (row?.continuationJson == null) {
    return undefined;
  }
  const parsed = ContinuationEffectSchema.safeParse(parseJson(row.continuationJson));
  if (!parsed.success) {
    return undefined;
  }
  return DECLARED_EFFECTS[parsed.data.effect] ?? 'unclassified';
}

/**
 * Whether a forget disposes of this row, classified positively by effect.
 *
 * Two places an effect can come from, and both name one: the row's own validated declaration,
 * or the accepted contract's classification of a stage that contract required. Everything else
 * is unclassified — a declared effect this build does not register, a row some other pass added,
 * a stage no table accounts for — and unclassified is not a licence to close it. The row stays
 * owed, pinned to somebody who can decide it, because closing it here would leave retained
 * endpoints holding a reading nobody will recompute.
 */
function forgetDisposesOf(
  stageName: string,
  requiredStages: readonly string[] | undefined,
  row: StageWorkDetail | undefined,
): boolean {
  const declared = declaredEffect(row);
  if (declared !== undefined) {
    return declared === 'source_generation';
  }
  return (
    requiredStages?.includes(stageName) === true &&
    CONTRACT_STAGE_EFFECTS[stageName] === 'source_generation'
  );
}

/**
 * Whether a transferred stage names a transfer this build and this policy admit, with everything
 * a runner needs to pick it up.
 *
 * A state alone is not a transfer, and neither is a set of non-null columns. The evidence has to
 * be a revision whose digest follows from its own dependencies, the addresses have to name
 * something, the identity has to be there, and the runner has to be one both the accepted policy
 * lists and this build registers, at the revision it registers it under. Anything short of that
 * is a row somebody moved, and the inventory does not account for it.
 */
function transferAccounted(
  row: StageWorkDetail | undefined,
  capabilities: readonly string[] | undefined,
): boolean {
  if (row?.continuationJson == null || row.capabilityRevision === null) {
    return false;
  }
  if (!TransferEvidenceSchema.safeParse(parseJson(row.inputRevisionJson ?? 'null')).success) {
    return false;
  }
  const parsed = TransferContinuationSchema.safeParse(parseJson(row.continuationJson));
  if (!parsed.success) {
    return false;
  }
  return admitsTransfer({
    runner: parsed.data.runner,
    runnerRevision: parsed.data.runnerRevision,
    capabilityRevision: row.capabilityRevision,
    policyCapabilities: capabilities,
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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
  sourceId: string,
  processingGeneration: number,
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
  const changed = db
    .prepare(
      `UPDATE source_work SET continuation_json = ?
       WHERE work_id = ? AND state IN ('pending','retryable')`,
    )
    .run(JSON.stringify({ withheldWork: remainder }), workId).changes;
  // A continuation is what the row now owes, which is not what it owed before. A readiness proof
  // taken against the old reading is stale the moment this lands, so the counter moves with it in
  // the caller's own transaction rather than the change being invisible to the fence.
  if (changed > 0) {
    advanceOperationalRevision(db, sourceId, processingGeneration);
  }
}
