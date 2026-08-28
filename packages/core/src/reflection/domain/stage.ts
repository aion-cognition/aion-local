import type { Driver } from 'neo4j-driver';
import type { EpisodeContext } from '../../infrastructure/graph/episode-context.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The contract every reflection stage implements, and the pure aggregation the orchestrator
 * records against `reflection:orchestrator:{episodeId}`. Whitepaper §6 and Algorithm 4
 * govern the stages themselves; this file governs how one of them reports.
 *
 * A stage takes its inputs from the graph, keyed on the episode, not from the stage before
 * it. Failure isolation is what forces that: a stage runs whether or not its predecessor
 * succeeded, so a stage that read an in-memory handoff would quietly do nothing on exactly
 * the runs isolation exists to survive. The graph is the memory, and it is already the
 * idempotent record of what earlier stages did.
 */

export type StageStatus = 'ok' | 'failed' | 'skipped';

/**
 * What the stage changed, by name — entities, merges, associations. Keys merge across the
 * run by summing, so the whitepaper's flat enrichment tally falls out of the per-stage
 * numbers as long as two stages counting the same thing agree on the key.
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
};

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
 * Whitepaper §6.1: a job is re-enqueued after a transient failure and the entry gate is what
 * makes that safe. The key therefore closes only on a run that had nothing left to retry —
 * every stage either did its work or had none to do. One failed stage keeps it open, because
 * a model timeout on extraction is exactly the transient the retry exists for, and marking
 * the run applied would gate the episode out of the pipeline forever with the failed stage's
 * structure permanently missing and no operation that re-extracts it.
 *
 * Isolation (§12.2) is unaffected: the stages after a failure still run and their writes
 * still stand. What the retry re-runs is idempotent by construction — MERGE on identity, the
 * edge merge policy, and the per-episode operation keys — except the salience counters,
 * which count a re-observation on purpose and are bounded by the worker's attempt limit.
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
  return { episodeId, durationMs, stages, counts: mergeStageCounts(stages) };
}
