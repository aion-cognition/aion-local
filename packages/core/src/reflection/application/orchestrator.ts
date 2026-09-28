import type { Driver } from 'neo4j-driver';

import type { JudgmentEvidence } from '../../evidence/application/judgment.js';
import { errorMessage, roundMs } from '../../infrastructure/errors.js';
import { loadEpisodeContext } from '../../infrastructure/graph/episode-context.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { isGenerationUnavailable } from '../../infrastructure/providers/errors.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getLedgerEntry,
  isLedgerApplied,
  markLedgerApplied,
} from '../../infrastructure/sqlite/ops-ledger.js';
import { readActiveGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import {
  readGenerationWork,
  stageWorkDigests,
} from '../../infrastructure/sqlite/source-readiness.js';
import {
  RunLedgerEntrySchema,
  StageLedgerEntrySchema,
  type StageBinding,
} from '../domain/stage-schema.js';
import {
  hasRemainder,
  shouldMarkApplied,
  stageAlreadyAppliedRecord,
  stageLedgerKey,
  stageSettlementOf,
  STAGE_UNVALIDATED_ENTRY_SUMMARY,
  summarizeRun,
  type ReflectionStage,
  type ReflectionSummary,
  type StageContext,
  type StageRecord,
  type StageUnavailability,
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
  readonly publications?: PublicationCoordinator;
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

type RefusalWatch = {
  readonly provider: Provider;
  /** The refusal the watched provider was given, or nothing where it was given none. */
  refused(): StageUnavailability | undefined;
};

/**
 * The provider a stage runs against, with any typed refusal kept where the run can read it back.
 *
 * Embedding passes straight through: it reaches the local model and is not part of the question.
 */
function watchRefusals(provider: Provider): RefusalWatch {
  let refusal: StageUnavailability | undefined;
  return {
    provider: {
      ...(provider.route === undefined ? {} : { route: provider.route }),
      embed: (texts) => provider.embed(texts),
      generate: async (req) => {
        try {
          return await provider.generate(req);
        } catch (err) {
          if (isGenerationUnavailable(err)) {
            refusal = { surface: req.surface ?? 'unlabeled', reason: errorMessage(err) };
          }
          throw err;
        }
      },
    },
    refused: () => refusal,
  };
}

/** A stage that declared the refusal itself keeps what it declared. */
function withRefusal(record: StageRecord, refused: StageUnavailability | undefined): StageRecord {
  if (refused === undefined || record.unavailable !== undefined) {
    return record;
  }
  return { ...record, unavailable: refused };
}

/** What this run's outcomes are about: the generation it started under, and what that owed. */
export function runBindingOf(db: SqliteHandle, sourceId: string): StageBinding {
  const generation = readActiveGeneration(db, sourceId);
  return {
    processingGeneration: generation?.processingGeneration ?? 0,
    operationalRevision: generation?.operationalRevision ?? 0,
    work: stageWorkDigests(db, sourceId, generation?.processingGeneration ?? 0),
  };
}

/**
 * Whether a recorded entry still describes the obligations named here.
 *
 * Two tests. The generation, because an entry recorded under the one a replacement displaced is
 * about a pass nobody is waiting for. Then the work itself: a row that gained a continuation, an
 * evidence revision or a capability the recorded pass never saw is not the row that pass
 * answered for, whatever the generation says. The readiness counter is not the test, because a
 * run advances it by settling its own rows and comparing it would re-enter every stage on every
 * ordinary retry.
 *
 * `stages` narrows it to the rows the caller is asking about: one stage for its own key, all of
 * them for the run key. An entry with no binding cannot answer the question at all, which is a
 * different answer from yes.
 */
function bindingApplies(
  recorded: StageBinding | undefined,
  current: StageBinding,
  stages: readonly string[],
): boolean {
  if (recorded?.processingGeneration !== current.processingGeneration) {
    return false;
  }
  return stages.every((name) => recorded.work[name] === current.work[name]);
}

type RecordedRun = {
  readonly stages: readonly StageRecord[];
  readonly binding: StageBinding | undefined;
};

/**
 * What a run's ledger entry holds, or nothing when it holds none this reader can validate. An
 * entry written before the typed fields existed, or one whose shape has drifted, says nothing:
 * reading a disposition out of an unvalidated summary is how prose becomes proof.
 */
function recoveredRun(db: SqliteHandle, key: string): RecordedRun | undefined {
  const entry = getLedgerEntry(db, key);
  if (entry === undefined) {
    return undefined;
  }
  const parsed = RunLedgerEntrySchema.safeParse(entry.summary);
  if (!parsed.success) {
    return undefined;
  }
  return {
    stages: parsed.data.stages.map((stage) => ({ ...stage, durationMs: 0 })),
    binding: parsed.data.binding,
  };
}

/** The same, for one stage's own key. */
function recoveredStage(
  db: SqliteHandle,
  key: string,
): { readonly record: StageRecord; readonly binding: StageBinding | undefined } | undefined {
  const entry = getLedgerEntry(db, key);
  if (entry === undefined) {
    return undefined;
  }
  const parsed = StageLedgerEntrySchema.safeParse(entry.summary);
  if (!parsed.success) {
    return undefined;
  }
  const { binding, ...held } = parsed.data;
  return { record: { name: '', ...held, durationMs: 0 }, binding };
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
    //
    // Only while its binding still applies. A key recorded under a generation a replacement has
    // since displaced is a statement about work nobody is waiting for; reusing it would hand the
    // replacement's obligations a pass that was never run for them.
    const binding = runBindingOf(this.#deps.db, episodeId);
    const held = recoveredRun(this.#deps.db, key);
    if (
      isLedgerApplied(this.#deps.db, key) &&
      bindingApplies(held?.binding, binding, Object.keys(binding.work)) &&
      coversOwedWork(this.#deps.db, episodeId, held?.stages)
    ) {
      this.#deps.logger.debug({ episodeId }, 'reflection already applied');
      return {
        episodeId,
        status: 'already_applied',
        applied: false,
        summary: summarizeRun(episodeId, elapsed(started), held?.stages ?? []),
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
      ...(this.#deps.publications === undefined ? {} : { publications: this.#deps.publications }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };

    const stages: StageRecord[] = [];
    for (const stage of this.#stages) {
      stages.push(await this.#runOrSkip(stage, context, binding));
    }

    const summary = summarizeRun(episodeId, elapsed(started), stages);
    const applied = shouldMarkApplied(stages);
    if (applied) {
      markLedgerApplied(this.#deps.db, key, { ...summary, binding });
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
          remainder: hasRemainder(stage),
          withheldReasons: [...new Set((stage.withheldWork ?? []).map((work) => work.reason))],
        })),
      },
      applied ? 'reflection enriched' : 'reflection incomplete; ledger left open',
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
  async #runOrSkip(
    stage: ReflectionStage,
    context: StageContext,
    binding: StageBinding,
  ): Promise<StageRecord> {
    const key = stageLedgerKey(context.pipelineVersion, stage.name, context.episodeId);
    // Three states, kept apart. No entry at all is a stage to run. An entry this reader can
    // decode and bind answers for the row. An entry that is applied and cannot be verified is
    // neither: its effects exist and must not be re-minted, and what it settled is unknown, so
    // the row keeps its obligation with a reason somebody can find. An undecodable entry is the
    // second kind of unverifiable, not the first kind of absent.
    const applied = isLedgerApplied(this.#deps.db, key);
    const held = applied ? recoveredStage(this.#deps.db, key) : undefined;
    if (applied && held?.binding === undefined) {
      return {
        name: stage.name,
        status: 'skipped',
        summary: STAGE_UNVALIDATED_ENTRY_SUMMARY,
        durationMs: 0,
      };
    }
    if (held !== undefined && bindingApplies(held.binding, binding, [stage.name])) {
      return stageAlreadyAppliedRecord(stage.name, held.record);
    }
    const record = await this.#runStage(stage, context);
    // A pass that named a remainder gets no key. The key is what stops a retry re-entering the
    // stage, and a stage that still owes work is exactly the one a retry has to enter.
    if (record.status !== 'failed' && !hasRemainder(record)) {
      // The disposition goes into the entry, normalized, beside the binding it was produced
      // under. A retry reads back what the pass settled; an entry holding a status can only say
      // it happened, and an entry with no binding cannot say which obligations it happened for.
      const settled = stageSettlementOf(record);
      markLedgerApplied(this.#deps.db, key, {
        status: record.status,
        summary: record.summary,
        binding,
        ...(settled === undefined ? {} : { settled }),
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
   *
   * The stage runs against a watched provider, so a refusal it turned into prose is still on the
   * record the worker reads. Without that the two reasons a stage has no model answer, a backend
   * that refused and a call that failed, arrive at the queue as the same failed outcome.
   */
  async #runStage(stage: ReflectionStage, context: StageContext): Promise<StageRecord> {
    const started = performance.now();
    const watch = watchRefusals(context.provider);
    const watched: StageContext = { ...context, provider: watch.provider };
    try {
      const outcome = await stage.run(watched);
      const record: StageRecord = withRefusal(
        { name: stage.name, ...outcome, durationMs: elapsed(started) },
        watch.refused(),
      );
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
      return withRefusal(
        {
          name: stage.name,
          status: 'failed',
          summary: 'the stage threw',
          durationMs: elapsed(started),
          error: errorMessage(err),
        },
        watch.refused(),
      );
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
