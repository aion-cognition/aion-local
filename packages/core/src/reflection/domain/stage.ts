import type { Driver } from 'neo4j-driver';

import type { JudgmentEvidence, WithheldWork } from '../../evidence/application/judgment.js';
import type { EpisodeContext } from '../../infrastructure/graph/episode-context.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The contract every reflection stage implements, and the pure aggregation the orchestrator
 * records against `reflection:orchestrator:{version}:{episodeId}`. This file governs how a stage
 * reports, not what any stage does.
 *
 * A stage takes its inputs from the graph, keyed on the episode, not from the stage before
 * it. Failure isolation is what forces that: a stage runs whether or not its predecessor
 * succeeded, so a stage that read an in-memory handoff would quietly do nothing on exactly
 * the runs isolation exists to survive. The graph is the memory, and it is already the
 * idempotent record of what earlier stages did.
 */

export type StageStatus = 'ok' | 'failed' | 'skipped';

/**
 * What the stage changed, by name: entities, merges, associations. Keys merge across the
 * run by summing, so a flat enrichment tally falls out of the per-stage numbers as long as
 * two stages counting the same thing agree on the key.
 */
export type StageCounts = Readonly<Record<string, number>>;

export type StageOutcome = {
  readonly status: StageStatus;
  /** One line, recorded verbatim in the ledger. A skip says why it skipped. */
  readonly summary: string;
  readonly counts?: StageCounts;
  /**
   * A skip for want of input another stage owed this one. The orchestrator leaves the stage's
   * ledger key open, so the retry that re-enters the failed predecessor re-enters this stage
   * too. Absent means the stage decided for itself and a retry would decide the same.
   */
  readonly retryable?: boolean;
  /**
   * Judgments nobody could ask about, with what they were about and the evidence they were
   * judged against. The key stays open either way, because the work is owed either way; the
   * disposition is what says whether running it again could decide it.
   */
  readonly withheldWork?: readonly WithheldWork[];
  /**
   * What this run settles about the stage's obligation to the source, when it settles it.
   * Absent means the obligation is still owed, whatever the prose above says.
   */
  readonly settled?: StageSettlement;
  /**
   * A settlement that holds only once every earlier required stage has settled.
   *
   * A stage that read its input successfully and found none has proved the input empty only if
   * the stage that produces that input finished. Until then the same reading is a stage waiting
   * on a predecessor, which is work owed. Missing vectors and unreadable nodes never qualify:
   * those are absent evidence rather than proved absence, so a stage in that position declares
   * nothing and stays owed.
   */
  readonly settledOnUpstream?: StageSettlement;
};

/**
 * Why a stage that published nothing is nevertheless finished with this source.
 *
 * The set is closed and every member names something the stage actually held. A stage that
 * failed, that could not read what it needed, or that ended a bounded scan owes its work and
 * says nothing here. Prose in `summary` is not a typed reason, and reading a disposition out of
 * one is how an unprocessed source passes for a finished one.
 */
export const STAGE_SETTLEMENT_REASONS = [
  'accepted_pass_applied',
  'below_minimum_input',
  'disabled_by_policy',
  'proved_empty_input',
  'pass_produced_nothing',
  'effects_already_recorded',
  'dispatch_acknowledged',
  'source_forgotten',
] as const;

export type StageSettlementReason =
  /** The accepted pass ran and its effects were written. This is what an `ok` status means. */
  | 'accepted_pass_applied'
  /** The episode carries less readable content than the stage's accepted minimum. */
  | 'below_minimum_input'
  /** The recorded policy turned this pass off for this source. */
  | 'disabled_by_policy'
  /** A complete upstream read proved there was nothing for this stage to act on. */
  | 'proved_empty_input'
  /** The accepted pass ran to its end and had nothing to publish. */
  | 'pass_produced_nothing'
  /** An earlier run already created this stage's durable effects. */
  | 'effects_already_recorded'
  /** The pass is a dispatch and the receiving side acknowledged it. */
  | 'dispatch_acknowledged'
  /**
   * The source was forgotten, so its generative passes have nothing left to act on.
   *
   * It carries the acknowledged source-state version it rests on. The disposition is reversible
   * the way the statement is: an unforget re-owes exactly the rows this closed, which is why the
   * proof names the version rather than recording that a forget happened at some point.
   */
  | 'source_forgotten';

export type StageSettlement = {
  readonly disposition: 'complete' | 'not_applicable';
  readonly reason: StageSettlementReason;
  /** What the disposition rests on, recorded beside it so a later reader can check the same thing. */
  readonly proof?: Readonly<Record<string, string | number | boolean>>;
};

/**
 * Everything a stage is given. The episode is loaded once per run and shared, so every stage
 * reads the same turns once.
 */
export type StageContext = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly episodeId: string;
  readonly episode: EpisodeContext;
  readonly logger: Logger;
  /**
   * The run's clock: transaction stamps, lock expiries, and any decision about elapsed time.
   * One run has one value, so a replay of an old episode still ages its locks against the
   * moment the replay happens.
   */
  readonly now: Date;
  /**
   * When the episode happened, which is what a derived node's world time is stamped from. It
   * falls back to `now` for an episode carrying no timestamp of its own.
   */
  readonly occurredAt: Date;
  /** The pipeline version this run's ledger keys are forked under. */
  readonly pipelineVersion: string;
  /**
   * The evidence a destructive judgment runs on, bound to the context whoever checked coverage
   * built. A stage that judges asks it before it spends a model call. Absent where the pipeline
   * was composed outside a checked entry point, which leaves those stages judging on their own
   * reads, as they did before this seam existed.
   */
  readonly evidence?: JudgmentEvidence;
  /**
   * The caller's shutdown signal, composed under every model call's own deadline through
   * `deadlineFor`. Without it a stop waits out the full stage timeout on a call it already
   * gave up on, once per remaining stage.
   */
  readonly signal?: AbortSignal;
};

/**
 * Stages are constructed and ordered by the caller. Nothing self-registers: the pipeline is
 * the list handed to `ReflectionOrchestrator`, which is the only place the order lives.
 */
export type ReflectionStage = {
  readonly name: string;
  run(ctx: StageContext): Promise<StageOutcome>;
};

export type StageRecord = StageOutcome & {
  readonly name: string;
  readonly durationMs: number;
  /** The message of a throw. Absent when the stage returned `failed` and explained itself. */
  readonly error?: string;
};

export type ReflectionSummary = {
  readonly episodeId: string;
  readonly durationMs: number;
  readonly stages: readonly StageRecord[];
  /** Every stage's counts, summed by key. */
  readonly counts: StageCounts;
  /** Stage names the per-stage ledger skipped this run because an earlier attempt already applied them. */
  readonly skippedStages: readonly string[];
};

/**
 * `reflection:stage:{version}:{stageName}:{episodeId}` gates one stage of one episode, where
 * the per-episode key gates the whole pipeline. A stage whose only idempotency is a content
 * hash over model output MERGEs a fresh set of near-duplicate nodes on every retry, because
 * that hash never collides twice; this key is what keeps a retry out of it. The orchestrator
 * marks it when a stage applies and skips the stage entirely, without calling `run`, when the
 * key is already there, so a retry re-enters only the stages that have not applied.
 *
 * The version sits ahead of the stage name so a pipeline bump re-enters every stage: the key a
 * stage earned under the old prompts gates only the old version's run.
 */
export function stageLedgerKey(
  pipelineVersion: string,
  stageName: string,
  episodeId: string,
): string {
  return `reflection:stage:${pipelineVersion}:${stageName}:${episodeId}`;
}

/** Whether the pass left named work behind, whatever it managed to write. */
export function hasRemainder(outcome: StageOutcome): boolean {
  return outcome.retryable === true || (outcome.withheldWork ?? []).length > 0;
}

/**
 * What one run settles about a stage's obligation, or nothing when it settles nothing.
 *
 * An `ok` status is the stage saying it ran its accepted pass and wrote its effects, so it
 * settles the obligation whether or not it declared a reason of its own. Everything else needs
 * the stage to have declared one: a failure, a skip for want of input, and a bounded scan that
 * ended are all work still owed, and the prose in `summary` is not evidence about which.
 *
 * A pass that succeeded and still named a remainder settles nothing either. The effects it wrote
 * are durable and stay written; the obligation is what the row holds, and the row still owes the
 * pairs the pass could not decide. The entity-dedup route produces exactly that combination.
 */
export function stageSettlementOf(outcome: StageOutcome): StageSettlement | undefined {
  if (hasRemainder(outcome)) {
    return undefined;
  }
  if (outcome.settled !== undefined) {
    return outcome.settled;
  }
  if (outcome.status === 'ok') {
    return { disposition: 'complete', reason: 'accepted_pass_applied' };
  }
  return undefined;
}

/** The `summary` a skipped-by-ledger stage records, distinct from a stage's own business-logic skip. */
export const STAGE_ALREADY_APPLIED_SUMMARY = 'already applied on an earlier attempt';

/**
 * The record the orchestrator produces for a stage it did not enter because its ledger key was
 * already set.
 *
 * The earlier attempt's disposition travels with it when the entry carries one. Without that the
 * retry that follows a crash between the stage and its settlement reports a skip nobody can act
 * on, and the row stays owed for a pass that already ran.
 */
export function stageAlreadyAppliedRecord(
  name: string,
  recovered: Pick<StageOutcome, 'settled' | 'settledOnUpstream'> = {},
): StageRecord {
  return {
    name,
    status: 'skipped',
    summary: STAGE_ALREADY_APPLIED_SUMMARY,
    durationMs: 0,
    ...(recovered.settled === undefined ? {} : { settled: recovered.settled }),
    ...(recovered.settledOnUpstream === undefined
      ? {}
      : { settledOnUpstream: recovered.settledOnUpstream }),
  };
}

function isStageAlreadyApplied(record: StageRecord): boolean {
  return record.status === 'skipped' && record.summary === STAGE_ALREADY_APPLIED_SUMMARY;
}

export function mergeStageCounts(stages: readonly StageRecord[]): StageCounts {
  const totals: Record<string, number> = {};
  for (const stage of stages) {
    for (const [key, value] of Object.entries(stage.counts ?? {})) {
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

/**
 * A job is re-enqueued after a transient failure and the entry gate is what makes that safe.
 * The key therefore closes only on a run that had nothing left to retry: every stage either
 * did its work or had none to do. One failed stage keeps it open, because a model timeout on
 * extraction is exactly the transient the retry exists for, and marking the run applied would
 * gate the episode out of the pipeline forever with the failed stage's structure permanently
 * missing and no operation that re-extracts it.
 *
 * Stage isolation is unaffected: the stages after a failure still run and their writes still
 * stand. What the retry re-runs is idempotent by construction (MERGE on identity, the edge
 * merge policy, and the per-episode operation keys) except the salience counters, which count
 * a re-observation on purpose and are bounded by the worker's attempt limit.
 *
 * A run with no stages at all stays retryable too: an unconfigured pipeline has enriched
 * nothing, and marking it would gate the episode out of the pipeline that follows.
 *
 * A pass that named a remainder and declared no disposition for it keeps the key open for the
 * same reason a failure does: the work is owed, and a closed run key is what would stop the
 * retry from entering the stage that owes it. A remainder beside a declared disposition does
 * not, because the stage has said what the run settles and what it waits on.
 */
export function shouldMarkApplied(stages: readonly StageRecord[]): boolean {
  return (
    stages.length > 0 &&
    stages.every(
      (stage) =>
        stage.status !== 'failed' &&
        !(hasRemainder(stage) && declaredDisposition(stage) === undefined),
    )
  );
}

/** What the stage said about its obligation, either outright or once its predecessors close. */
function declaredDisposition(outcome: StageOutcome): StageSettlement | undefined {
  return outcome.settled ?? outcome.settledOnUpstream;
}

export function summarizeRun(
  episodeId: string,
  durationMs: number,
  stages: readonly StageRecord[],
): ReflectionSummary {
  return {
    episodeId,
    durationMs,
    stages,
    counts: mergeStageCounts(stages),
    skippedStages: stages.filter(isStageAlreadyApplied).map((stage) => stage.name),
  };
}
