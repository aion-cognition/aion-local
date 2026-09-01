import type { Driver } from 'neo4j-driver';

import { attachContentVectors } from './vectors.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { describeError } from '../../infrastructure/errors.js';
import {
  supersede,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  findIdleSessions,
  findSessionNarratives,
  loadSessionEpisodes,
  loadSessionSourceNodes,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  assembleNarrative,
  buildNarrativeMessages,
  decideSessionNarrative,
  isSessionIdle,
  lastActivityAt,
  narrativeMaxTokens,
  narrativeNodeId,
  narrativeSpan,
  NARRATIVE_GROUNDING,
  NARRATIVE_JSON_SCHEMA,
  NarrativeOutputSchema,
  renderNarrativeSource,
  SESSION_NARRATIVE_SCOPE,
  type GroundedNarrative,
  type NarrativeDecision,
  type NarrativeSource,
  type NarrativeSpan,
} from '../domain/narrative.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../domain/stage.js';

/**
 * The pinned trigger: a session's close produces a session-scope narrative. Two entry points
 * reach the same routine: the transport's close hook, which is an explicit boundary, and the
 * idle rule, which is what a client that vanished without a DELETE leaves behind. The
 * reflection stage carries the idle rule for the episodes whose pipeline runs long after
 * their session went quiet.
 */

export const NARRATIVE_STAGE_NAME = 'narratives';

/** The idle window in the unit the closer works in; config states it in minutes. */
export const DEFAULT_SESSION_IDLE_MS = DEFAULTS.reflection.narrativeIdleMinutes * 60 * 1000;

/** Provenance: what produced the node, as distinct from what later reads it. */
export const NARRATIVE_EXTRACTION_METHOD = 'reflection_narrative';

const NARRATIVE_SIGNALS = ['compression'];
const NARRATIVE_PROVENANCE = [NARRATIVE_EXTRACTION_METHOD];

export type NarrativeDeps = {
  readonly driver: Driver;
  readonly provider: Provider;
  readonly logger: Logger;
};

export type NarrativeOptions = {
  readonly model?: string;
  readonly idleMs?: number;
  readonly timeoutMs?: number;
  readonly maxSourceEpisodes?: number;
  readonly maxEpisodeChars?: number;
  readonly now?: Date;
  /**
   * The world time to fall back on when the session's episodes carry no span end. Defaults
   * to `now`, which dates the narrative to the write.
   */
  readonly occurredAt?: Date;
  /** Cleanup only: rewrite the standing narrative over the same episodes, superseding it. */
  readonly regenerate?: boolean;
};

export type IdleSweepOptions = NarrativeOptions & {
  readonly limit?: number;
};

export type NarrativeStatus = 'created' | 'skipped' | 'failed';

export type NarrativeResult = {
  readonly status: NarrativeStatus;
  /** One line, suitable for the stage summary the ledger records verbatim. */
  readonly summary: string;
  readonly sessionId: string;
  readonly episodes: number;
  readonly narrativeId?: string;
  readonly version?: number;
};

type NarrativeSettings = {
  readonly model: string;
  readonly idleMs: number;
  readonly timeoutMs: number;
  readonly maxSourceEpisodes: number;
  readonly maxEpisodeChars: number;
  readonly now: Date;
  readonly occurredAt: Date;
  readonly regenerate: boolean;
};

function settingsOf(options: NarrativeOptions): NarrativeSettings {
  const now = options.now ?? new Date();
  return {
    model: options.model ?? DEFAULTS.models.reflect,
    idleMs: options.idleMs ?? DEFAULT_SESSION_IDLE_MS,
    timeoutMs: options.timeoutMs ?? DEFAULTS.reflection.stageTimeoutMs,
    maxSourceEpisodes: options.maxSourceEpisodes ?? DEFAULTS.reflection.maxNarrativeEpisodes,
    maxEpisodeChars: options.maxEpisodeChars ?? DEFAULTS.reflection.maxNarrativeEpisodeChars,
    now,
    occurredAt: options.occurredAt ?? now,
    regenerate: options.regenerate ?? false,
  };
}

/**
 * One structured-output call, guarded, and the grounding filter over its answer. Reflection's
 * latency regime is relaxed, not unbounded: `qwen3:8b` with reasoning on measured 10-44s with
 * occasional non-returns, so reasoning is off and the call carries its own deadline rather
 * than relying on the orchestrator, which imposes none. The token ceiling tracks the source's
 * own sentence budget: a fixed one is what a thin session pads with invention.
 */
async function compress(
  deps: NarrativeDeps,
  settings: NarrativeSettings,
  source: NarrativeSource,
): Promise<GroundedNarrative> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, settings.timeoutMs);
  try {
    const raw = await deps.provider.generate({
      model: settings.model,
      messages: buildNarrativeMessages(source),
      schema: NARRATIVE_JSON_SCHEMA,
      maxTokens: narrativeMaxTokens(source.sentenceBudget),
      think: false,
      signal: controller.signal,
    });
    return assembleNarrative(NarrativeOutputSchema.parse(raw), source);
  } finally {
    clearTimeout(timer);
  }
}

type NarrativeWrite = {
  readonly narrativeId: string;
  readonly sessionId: string;
  readonly decision: NarrativeDecision;
  readonly output: GroundedNarrative;
  readonly source: NarrativeSource;
  readonly span: NarrativeSpan;
  readonly now: Date;
  /** The end of the span the narrative covers, else the run's world time. */
  readonly occurredAt: Date;
};

/**
 * `summary` is the one-line gist every pack shows; `text` is the narrative body, which is
 * both what `content_fts` indexes and what the pending-vector drain would embed if the
 * embedder is down at close time. Writing the body under `text` is what keeps a narrative
 * that missed its vector recoverable by the ordinary backfill instead of permanently
 * invisible to vector search. `citations` carries the ids every stored sentence cited, which
 * is what makes the claim auditable after the fact.
 */
function narrativeProperties(input: NarrativeWrite): GraphProperties {
  return {
    [MEMORY_PROPERTIES.summary]: input.output.summary,
    [MEMORY_PROPERTIES.text]: input.output.narrative,
    [NARRATIVE_PROPERTIES.citations]: [...input.output.citations],
    [NARRATIVE_PROPERTIES.sentenceCount]: input.output.kept,
    [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    [MEMORY_PROPERTIES.sessionId]: input.sessionId,
    [MEMORY_PROPERTIES.extractionMethod]: NARRATIVE_EXTRACTION_METHOD,
    [NARRATIVE_PROPERTIES.scope]: SESSION_NARRATIVE_SCOPE,
    [NARRATIVE_PROPERTIES.version]: input.decision.version,
    [NARRATIVE_PROPERTIES.coverageKey]: input.decision.coverageKey,
    [NARRATIVE_PROPERTIES.coverageCount]: input.decision.episodeIds.length,
    [NARRATIVE_PROPERTIES.coverage]: input.source.coverage,
    [NARRATIVE_PROPERTIES.spanStart]: input.span.start,
    [NARRATIVE_PROPERTIES.spanEnd]: input.span.end,
  };
}

/**
 * The node and its provenance edges in one transaction. `occurred_at` is the end of the span
 * it covers, so recency ranks a narrative with the freshest experience it compresses rather
 * than with the oldest. Edge counts are zero: these are structural facts, not observations,
 * so a repeat write moves nothing.
 */
async function writeNarrative(deps: NarrativeDeps, input: NarrativeWrite): Promise<void> {
  await inWriteTransaction(deps.driver, async (tx) => {
    await writeStampedDerivedNodeInTransaction(tx, {
      label: 'Narrative',
      id: input.narrativeId,
      now: input.now,
      occurredAt: input.occurredAt,
      properties: narrativeProperties(input),
    });

    await upsertEdgeInTransaction(tx, {
      type: DERIVES_FROM_TYPE,
      sourceId: input.narrativeId,
      targetId: input.sessionId,
      strength: 1,
      confidence: 1,
      signals: NARRATIVE_SIGNALS,
      provenance: NARRATIVE_PROVENANCE,
      count: 0,
      now: input.now,
    });

    for (const episodeId of input.decision.episodeIds) {
      await upsertEdgeInTransaction(tx, {
        type: SUMMARIZED_BY_TYPE,
        sourceId: episodeId,
        targetId: input.narrativeId,
        strength: 1,
        confidence: 1,
        signals: NARRATIVE_SIGNALS,
        provenance: NARRATIVE_PROVENANCE,
        count: 0,
        now: input.now,
      });
    }
  });
}

/** Lineage, not deletion: the old version stays readable and time travel still returns it. */
async function closeSuperseded(
  deps: NarrativeDeps,
  decision: NarrativeDecision,
  narrativeId: string,
  settings: NarrativeSettings,
  occurredAt: Date,
): Promise<void> {
  for (const oldId of decision.supersedes) {
    if (oldId !== narrativeId) {
      await supersede(deps.driver, {
        oldId,
        newId: narrativeId,
        now: settings.now,
        // An older version stopped covering the session at the replacement's own world time,
        // which is not the moment the rewrite ran.
        validUntil: occurredAt,
        signals: NARRATIVE_SIGNALS,
        provenance: NARRATIVE_PROVENANCE,
      });
    }
  }
}

/**
 * The last step, and the only one allowed to fail without failing the narrative. A node that
 * ends here without its `content_vec` is the same pending-vector marker intake leaves, and
 * the worker's drain resolves it on the next pass.
 */
async function attachVector(deps: NarrativeDeps, narrativeId: string, text: string): Promise<void> {
  try {
    await attachContentVectors(deps.driver, deps.provider, [{ id: narrativeId, text }]);
  } catch (err) {
    deps.logger.warn({ err, narrativeId }, 'narrative vector deferred; the narrative is stored');
  }
}

function skipped(sessionId: string, episodes: number, summary: string): NarrativeResult {
  return { status: 'skipped', summary, sessionId, episodes };
}

/**
 * One boundary, evaluated and acted on. `requireIdle` is the difference between the two
 * triggers: a transport close is an explicit end, while the sweep and the reflection stage
 * have only silence to go on and must wait out the idle window first.
 */
async function narrateSession(
  deps: NarrativeDeps,
  sessionId: string,
  settings: NarrativeSettings,
  requireIdle: boolean,
): Promise<NarrativeResult> {
  const episodes = await loadSessionEpisodes(deps.driver, sessionId, settings.now);
  if (episodes.length === 0) {
    return skipped(sessionId, 0, 'the session holds no episodes');
  }

  if (requireIdle) {
    const activity = lastActivityAt(episodes);
    if (activity === undefined) {
      return skipped(sessionId, episodes.length, 'the session carries no activity timestamp');
    }
    if (!isSessionIdle(activity, settings.now, settings.idleMs)) {
      return skipped(sessionId, episodes.length, 'the session is still active');
    }
  }

  const span = narrativeSpan(episodes);
  // The narrative's world time is the end of what it compresses; a session whose episodes
  // carry no timestamps falls back to the run's.
  const occurredAt = span.end ?? settings.occurredAt;
  const existing = await findSessionNarratives(deps.driver, sessionId);
  const decision = decideSessionNarrative(episodes, existing, { regenerate: settings.regenerate });
  const generation = settings.regenerate ? NARRATIVE_GROUNDING : '';
  const narrativeId = narrativeNodeId(sessionId, decision.coverageKey, generation);

  if (decision.action === 'skip') {
    await closeSuperseded(deps, decision, narrativeId, settings, occurredAt);
    return skipped(sessionId, episodes.length, decision.reason);
  }

  const source = renderNarrativeSource(
    episodes,
    await loadSessionSourceNodes(deps.driver, sessionId, settings.now),
    settings.maxSourceEpisodes,
    settings.maxEpisodeChars,
  );

  let output: GroundedNarrative;
  try {
    output = await compress(deps, settings, source);
  } catch (err) {
    deps.logger.warn({ err, sessionId, episodes: episodes.length }, 'narrative compression failed');
    return {
      status: 'failed',
      summary: `narrative compression failed: ${describeError(err)}`,
      sessionId,
      episodes: episodes.length,
    };
  }

  if (output.kept === 0) {
    deps.logger.warn(
      { sessionId, episodes: episodes.length, dropped: output.dropped },
      'narrative dropped: no sentence cited a source the session holds',
    );
    return {
      status: 'failed',
      summary: `narrative dropped: ${String(output.dropped)} sentences cited nothing in the session`,
      sessionId,
      episodes: episodes.length,
    };
  }

  const write: NarrativeWrite = {
    narrativeId,
    sessionId,
    decision,
    output,
    source,
    span,
    now: settings.now,
    occurredAt,
  };
  await writeNarrative(deps, write);
  await closeSuperseded(deps, decision, narrativeId, settings, occurredAt);
  await attachVector(deps, narrativeId, output.narrative);

  deps.logger.info(
    {
      sessionId,
      narrativeId,
      version: decision.version,
      episodes: episodes.length,
      rendered: source.renderedCount,
      sentences: output.kept,
      dropped: output.dropped,
      citations: output.citations.length,
      superseded: decision.supersedes.length,
    },
    'session narrative stored',
  );

  return {
    status: 'created',
    summary: `narrative v${String(decision.version)} over ${String(episodes.length)} episodes`,
    sessionId,
    episodes: episodes.length,
    narrativeId,
    version: decision.version,
  };
}

/**
 * The transport-close trigger. `sessionId` is the transport's own session identity, which is
 * the Session node's id. Called from the MCP service's session-close hook; it waits out no
 * idle window, because the client saying goodbye is the boundary itself.
 */
export async function closeSessionNarrative(
  deps: NarrativeDeps,
  sessionId: string,
  options: NarrativeOptions = {},
): Promise<NarrativeResult> {
  return narrateSession(deps, sessionId, settingsOf(options), false);
}

/**
 * The idle trigger, for the clients that vanish without a close. Bounded by `limit` and
 * scheduled by nobody here: the worker or the maintenance tick calls it.
 */
export async function sweepIdleSessions(
  deps: NarrativeDeps,
  options: IdleSweepOptions = {},
): Promise<readonly NarrativeResult[]> {
  const settings = settingsOf(options);
  const idle = await findIdleSessions(deps.driver, {
    idleBefore: new Date(settings.now.getTime() - settings.idleMs),
    limit: options.limit ?? DEFAULTS.reflection.narrativeSweepLimit,
  });

  const results: NarrativeResult[] = [];
  for (const session of idle) {
    results.push(await narrateSession(deps, session.sessionId, settings, true));
  }
  return results;
}

export type SessionNarrativeOptions = Omit<NarrativeOptions, 'now' | 'occurredAt'>;

/**
 * The stage carries the idle rule rather than the close: by the time an episode reflects,
 * its session is usually seconds old and still open, and the narrative is the close hook's
 * to write. What the stage catches is the other case: a backlog drained after the fact, or a
 * retry that landed hours late, where the session is long gone and no close hook will ever
 * fire for it again.
 */
export class SessionNarrativeStage implements ReflectionStage {
  readonly name = NARRATIVE_STAGE_NAME;
  readonly #options: SessionNarrativeOptions;

  constructor(options: SessionNarrativeOptions = {}) {
    this.#options = options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const deps: NarrativeDeps = {
      driver: ctx.driver,
      provider: ctx.provider,
      logger: ctx.logger,
    };
    const settings = settingsOf({ ...this.#options, now: ctx.now, occurredAt: ctx.occurredAt });
    const result = await narrateSession(deps, ctx.episode.sessionId, settings, true);

    if (result.status === 'created') {
      return { status: 'ok', summary: result.summary, counts: { narratives: 1 } };
    }
    return { status: result.status === 'failed' ? 'failed' : 'skipped', summary: result.summary };
  }
}

/**
 * The transport-close hook in the shape the MCP service takes it: a synchronous callback.
 * Compression is a model call, so it cannot be awaited on a teardown path: the close is
 * scheduled, a failure is logged rather than raised, and closes queue behind one another so
 * a burst of disconnects does not fire concurrent generations at one local model. Construct
 * one per process, the same lifetime as `SessionManager`.
 */
export class SessionNarrativeCloser {
  readonly #deps: NarrativeDeps;
  readonly #options: SessionNarrativeOptions;
  /** Chained so `whenIdle()` waits for every close scheduled so far, not just the latest. */
  #pending: Promise<void> = Promise.resolve();

  constructor(deps: NarrativeDeps, options: SessionNarrativeOptions = {}) {
    this.#deps = deps;
    this.#options = options;
  }

  /** Bound as a class field so it can be assigned directly to the service's `onSessionClosed`. */
  readonly onSessionClosed = (sessionId: string): void => {
    this.#pending = this.#pending.then(async () => {
      try {
        await closeSessionNarrative(this.#deps, sessionId, this.#options);
      } catch (err) {
        this.#deps.logger.error({ err, sessionId }, 'session close narrative failed');
      }
    });
  };

  /** Resolves once every close scheduled so far has settled. Only tests should call it. */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }
}
