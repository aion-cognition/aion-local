import type { Driver } from 'neo4j-driver';

import type { EpisodeContext } from '../../infrastructure/graph/episode-context.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The contract every reflection stage implements, and the pure aggregation the orchestrator
 * records against `reflection:orchestrator:{episodeId}`. This file governs how a stage
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
};

/**
 * Everything a stage is given. The episode is loaded once per run and shared, so eight
 * stages do not read the same turns eight times.
 */
export type StageContext = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly episodeId: string;
  readonly episode: EpisodeContext;
  readonly logger: Logger;
  /** The run's clock. Every write a stage stamps uses it, so one run has one timestamp. */
  readonly now: Date;
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
 * The per-episode ledger key only ever gated the whole pipeline. A stage
 * with no ledger of its own (`cognitive`, historically) re-runs its full extraction on every
 * retry of the run it belongs to, and each pass MERGEs a fresh set of near-duplicate nodes
 * because its only idempotency is a content hash over LLM output that never collides twice.
 * `reflection:stage:{stageName}:{episodeId}` closes that gap one level down: the orchestrator
 * marks it the moment a stage finishes without failing and skips the stage entirely, without
 * calling `run`, when the key is already there. A retry therefore re-enters only the stages
 * that have not yet applied.
 */
export function stageLedgerKey(stageName: string, episodeId: string): string {
  return `reflection:stage:${stageName}:${episodeId}`;
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
