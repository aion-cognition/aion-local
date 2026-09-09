import type { Driver } from 'neo4j-driver';

import type { JudgmentEvidence } from '../../evidence/application/judgment.js';
import { errorMessage, roundMs } from '../../infrastructure/errors.js';
import { loadEpisodeContext } from '../../infrastructure/graph/episode-context.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getLedgerEntry,
  isLedgerApplied,
  markLedgerApplied,
} from '../../infrastructure/sqlite/ops-ledger.js';
import { readActiveGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import { readGenerationWork } from '../../infrastructure/sqlite/source-readiness.js';
import { RunLedgerEntrySchema, StageLedgerEntrySchema } from '../domain/stage-schema.js';
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
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * The key that gates one episode's whole pipeline, forked by pipeline version so a prompt or
 * extraction change re-enters an episode the old version already closed.
 */
export function orchestratorLedgerKey(pipelineVersion: string, episodeId: string): string {
  return `reflection:orchestrator:${pipelineVersion}:${episodeId}`;
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
  /** Handed to every stage unchanged. The orchestrator checks no coverage of its own. */
  readonly evidence?: JudgmentEvidence;
};

export type ReflectionRunOptions = {
  readonly now?: Date;
  /** Which fork of the ledger key space this run gates on. Defaults to the shipped version. */
  readonly pipelineVersion?: string;
  /**
   * The caller's shutdown signal, handed to every stage. A stage composes it under its own
   * timeout, so a stop cuts the model call it is waiting on instead of waiting the timeout out.
   */
  readonly signal?: AbortSignal;
};

function elapsed(started: number): number {
  return roundMs(performance.now() - started);
}

/**
 * The stage outcomes a run's ledger entry holds, or nothing when it holds none this reader can
 * validate. An entry written before the typed fields existed, or one whose shape has drifted,
 * says nothing: reading a disposition out of an unvalidated summary is how prose becomes proof.
 */
function recoveredRunStages(db: SqliteHandle, key: string): readonly StageRecord[] | undefined {
  const entry = getLedgerEntry(db, key);
  if (entry === undefined) {
    return undefined;
  }
  const parsed = RunLedgerEntrySchema.safeParse(entry.summary);
  return parsed.success
    ? parsed.data.stages.map((stage) => ({ ...stage, durationMs: 0 }))
    : undefined;
}

/** The same, for one stage's own key. */
function recoveredStage(db: SqliteHandle, key: string): StageRecord | undefined {
  const entry = getLedgerEntry(db, key);
  if (entry === undefined) {
    return undefined;
  }
  const parsed = StageLedgerEntrySchema.safeParse(entry.summary);
  return parsed.success ? { name: '', ...parsed.data, durationMs: 0 } : undefined;
}

/**
 * Whether what the key recorded answers for everything the source still owes.
 *
 * Owed work governs execution, not the key. A stage the policy required and the recorded run
 * never names is a pass nobody ran, so the pipeline is entered again and the per-stage keys keep
 * whatever the earlier attempt already wrote. A source with no active generation owes nothing
 * this can measure, and the key stands.
 */
function coversOwedWork(
  db: SqliteHandle,
  sourceId: string,
  recovered: readonly StageRecord[] | undefined,
): boolean {
  const generation = readActiveGeneration(db, sourceId);
  if (generation === undefined) {
    return true;
  }
  const named = new Set((recovered ?? []).map((stage) => stage.name));
  return readGenerationWork(db, sourceId, generation.processingGeneration)
    .filter((row) => row.kind === 'stage' && row.state !== 'completed' && row.state !== 'obsolete')
    .every((row) => named.has(row.stageName ?? ''));
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
    const pipelineVersion = options.pipelineVersion ?? PIPELINE_VERSION;
    const key = orchestratorLedgerKey(pipelineVersion, episodeId);

    // A run whose key landed and whose completion did not is the crash this recovers. The key's
    // own entry holds what the earlier attempt recorded, so its typed outcomes answer for the
    // rows that are still owed rather than being lost with the attempt that took them.
    const recovered = recoveredRunStages(this.#deps.db, key);
    if (
      isLedgerApplied(this.#deps.db, key) &&
      coversOwedWork(this.#deps.db, episodeId, recovered)
    ) {
      this.#deps.logger.debug({ episodeId }, 'reflection already applied');
      return {
        episodeId,
        status: 'already_applied',
        applied: false,
        summary: summarizeRun(episodeId, elapsed(started), recovered ?? []),
      };
    }

    const now = options.now ?? new Date();
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
      now,
      // The episode's own clock where it has one, so a derived node's world time is the world
      // time of what it was derived from rather than the moment the run happened.
      occurredAt: episode.occurredAt ?? now,
      pipelineVersion,
      ...(this.#deps.evidence === undefined ? {} : { evidence: this.#deps.evidence }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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
   * The per-stage ledger gate. A stage whose key is already applied is not entered and its
   * `run` is never called, so a retry cannot re-mint what an earlier attempt already wrote.
   * The key is set when the stage applies or decides for itself that it has nothing to do.
   * A stage that skipped for want of input a failed predecessor owed it keeps its key open,
   * because the retry that re-enters that predecessor owes this stage its run too.
   */
  async #runOrSkip(stage: ReflectionStage, context: StageContext): Promise<StageRecord> {
    const key = stageLedgerKey(context.pipelineVersion, stage.name, context.episodeId);
    if (isLedgerApplied(this.#deps.db, key)) {
      const held = recoveredStage(this.#deps.db, key);
      return stageAlreadyAppliedRecord(stage.name, {
        ...(held?.settled === undefined ? {} : { settled: held.settled }),
        ...(held?.settledOnUpstream === undefined
          ? {}
          : { settledOnUpstream: held.settledOnUpstream }),
      });
    }
    const record = await this.#runStage(stage, context);
    if (record.status !== 'failed' && record.retryable !== true) {
      // The disposition goes into the entry, not only the prose. A retry that finds this key set
      // reads back what the pass settled; an entry holding a sentence can only say it happened.
      markLedgerApplied(this.#deps.db, key, {
        status: record.status,
        summary: record.summary,
        ...(record.settled === undefined ? {} : { settled: record.settled }),
        ...(record.settledOnUpstream === undefined
          ? {}
          : { settledOnUpstream: record.settledOnUpstream }),
      });
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
