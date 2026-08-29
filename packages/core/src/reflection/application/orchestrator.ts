import type { Driver } from 'neo4j-driver';
import { loadEpisodeContext } from '../../infrastructure/graph/episode-context.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { isLedgerApplied, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  shouldMarkApplied,
  stageAlreadyAppliedRecord,
  stageLedgerKey,
  summarizeRun,
  type ReflectionStage,
  type ReflectionSummary,
  type StageContext,
  type StageRecord,
} from '../domain/stage.js';

/** The key that gates one episode's whole pipeline. */
export function orchestratorLedgerKey(episodeId: string): string {
  return `reflection:orchestrator:${episodeId}`;
}

/**
 * `completed` ran the stages, whatever each of them made of the episode. The other two ran
 * none and are not failures: the episode was already enriched, or there is nothing readable
 * left to enrich. Both are terminal, retrying either returns the same answer, so a caller
 * finishes the job rather than backing off. An outage throws instead, because that one is
 * worth retrying.
 */
export type ReflectionRunStatus = 'completed' | 'already_applied' | 'episode_unavailable';

export type ReflectionRun = {
  readonly episodeId: string;
  readonly status: ReflectionRunStatus;
  /** True when this run wrote the ledger key. False on a run that found it already written. */
  readonly applied: boolean;
  readonly summary: ReflectionSummary;
};

export type ReflectionOrchestratorDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly logger: Logger;
};

export type ReflectionRunOptions = {
  readonly now?: Date;
};

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function elapsed(started: number): number {
  return round(performance.now() - started);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * The run-level gate comes first so a re-enqueued job costs one SQLite read; the episode
 * loads once and every stage shares it; each stage is isolated, so a failed extraction does
 * not cost the run its deduplication; the run-level ledger is marked last, with the
 * per-stage record of what the run actually did.
 *
 * Underneath that sits the per-stage ledger: each stage is also gated on its own key,
 * marked as it finishes rather than at the end, so a retry after a partial failure re-enters
 * only the stages that have not yet applied instead of re-running the whole pipeline.
 *
 * The stage list is the pipeline. Order is the caller's, fixed at construction, and nothing
 * in here knows what any particular stage does.
 */
export class ReflectionOrchestrator {
  readonly #deps: ReflectionOrchestratorDeps;
  readonly #stages: readonly ReflectionStage[];

  constructor(deps: ReflectionOrchestratorDeps, stages: readonly ReflectionStage[]) {
    this.#deps = deps;
    this.#stages = [...stages];
  }

  get stageNames(): readonly string[] {
    return this.#stages.map((stage) => stage.name);
  }

  async run(episodeId: string, options: ReflectionRunOptions = {}): Promise<ReflectionRun> {
    const started = performance.now();
    const key = orchestratorLedgerKey(episodeId);

    if (isLedgerApplied(this.#deps.db, key)) {
      this.#deps.logger.debug({ episodeId }, 'reflection already applied');
      return this.#empty(episodeId, 'already_applied', elapsed(started));
    }

    const episode = await loadEpisodeContext(this.#deps.driver, episodeId);
    if (episode === undefined) {
      this.#deps.logger.warn({ episodeId }, 'reflection skipped: no readable episode');
      return this.#empty(episodeId, 'episode_unavailable', elapsed(started));
    }

    const context: StageContext = {
      driver: this.#deps.driver,
      db: this.#deps.db,
      provider: this.#deps.provider,
      episodeId,
      episode,
      logger: this.#deps.logger,
      now: options.now ?? new Date(),
    };

    const stages: StageRecord[] = [];
    for (const stage of this.#stages) {
      stages.push(await this.#runOrSkip(stage, context));
    }

    const summary = summarizeRun(episodeId, elapsed(started), stages);
    const applied = shouldMarkApplied(stages);
    if (applied) {
      markLedgerApplied(this.#deps.db, key, summary);
    }

    this.#deps.logger.info(
      {
        episodeId,
        sessionId: episode.sessionId,
        applied,
        durationMs: summary.durationMs,
        counts: summary.counts,
        // Named apart from `stages` below, per-episode: which stages this run entered at all
        // versus which ones a prior attempt already closed out.
        skippedStages: summary.skippedStages,
        stages: stages.map((stage) => ({
          name: stage.name,
          status: stage.status,
          durationMs: stage.durationMs,
        })),
      },
      applied ? 'reflection enriched' : 'reflection produced nothing; ledger left open',
    );

    return { episodeId, status: 'completed', applied, summary };
  }

  /**
   * The per-stage ledger gate. A stage whose key is already applied is not entered —
   * `run` is never called — so a retry cannot re-mint what an earlier attempt already wrote.
   * The key is set the moment the stage finishes without failing, `ok` or `skipped` alike,
   * mirroring `shouldMarkApplied`'s view that only `failed` leaves something to retry.
   */
  async #runOrSkip(stage: ReflectionStage, context: StageContext): Promise<StageRecord> {
    const key = stageLedgerKey(stage.name, context.episodeId);
    if (isLedgerApplied(this.#deps.db, key)) {
      return stageAlreadyAppliedRecord(stage.name);
    }
    const record = await this.#runStage(stage, context);
    if (record.status !== 'failed') {
      markLedgerApplied(this.#deps.db, key, { status: record.status, summary: record.summary });
    }
    return record;
  }

  /**
   * One stage's blast radius. A throw is caught and recorded rather than propagated: the
   * stages after it still run, and the run still enriches the episode with whatever the
   * rest of the pipeline can extract.
   */
  async #runStage(stage: ReflectionStage, context: StageContext): Promise<StageRecord> {
    const started = performance.now();
    try {
      const outcome = await stage.run(context);
      const record: StageRecord = { name: stage.name, ...outcome, durationMs: elapsed(started) };
      if (outcome.status === 'failed') {
        this.#deps.logger.warn(
          { episodeId: context.episodeId, stage: stage.name, summary: outcome.summary },
          'reflection stage reported failure',
        );
      }
      return record;
    } catch (err) {
      this.#deps.logger.error(
        { err, episodeId: context.episodeId, stage: stage.name },
        'reflection stage threw; continuing with the rest of the pipeline',
      );
      return {
        name: stage.name,
        status: 'failed',
        summary: 'the stage threw',
        durationMs: elapsed(started),
        error: errorMessage(err),
      };
    }
  }

  #empty(episodeId: string, status: ReflectionRunStatus, durationMs: number): ReflectionRun {
    return {
      episodeId,
      status,
      applied: false,
      summary: summarizeRun(episodeId, durationMs, []),
    };
  }
}
