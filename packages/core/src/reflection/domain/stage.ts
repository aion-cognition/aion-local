import type { Driver } from 'neo4j-driver';

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

/** The `summary` a skipped-by-ledger stage records, distinct from a stage's own business-logic skip. */
export const STAGE_ALREADY_APPLIED_SUMMARY = 'already applied on an earlier attempt';

/** The record the orchestrator produces for a stage it did not enter because its ledger key was already set. */
export function stageAlreadyAppliedRecord(name: string): StageRecord {
  return { name, status: 'skipped', summary: STAGE_ALREADY_APPLIED_SUMMARY, durationMs: 0 };
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
 */
export function shouldMarkApplied(stages: readonly StageRecord[]): boolean {
  return stages.length > 0 && stages.every((stage) => stage.status !== 'failed');
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
