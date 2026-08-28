import type { Driver } from 'neo4j-driver';
import {
  supersede,
  writeStampedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import {
  DERIVES_FROM_TYPE,
  findIdleSessions,
  findSessionNarratives,
  loadSessionEpisodes,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  buildNarrativeMessages,
  decideSessionNarrative,
  isSessionIdle,
  lastActivityAt,
  narrativeNodeId,
  narrativeSpan,
  NARRATIVE_JSON_SCHEMA,
  NarrativeOutputSchema,
  renderNarrativeSource,
  SESSION_NARRATIVE_SCOPE,
  type NarrativeDecision,
  type NarrativeOutput,
  type NarrativeSource,
  type NarrativeSpan,
} from '../domain/narrative.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../domain/stage.js';
import { attachContentVectors } from './vectors.js';

/**
 * Whitepaper §6.10 and the pinned trigger: a session's close produces a session-scope
 * narrative. Two entry points reach the same routine — the transport's close hook, which is
 * an explicit boundary, and the idle rule, which is what a client that vanished without a
 * DELETE leaves behind. The reflection stage carries the idle rule for the episodes whose
 * pipeline runs long after their session went quiet.
 */

export const NARRATIVE_STAGE_NAME = 'narratives';

/** Pinned P3 defaults. The integration task threads config over the ones config carries. */
export const DEFAULT_NARRATIVE_MODEL = 'qwen3:8b';
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_NARRATIVE_TIMEOUT_MS = 60_000;
export const DEFAULT_NARRATIVE_MAX_TOKENS = 700;
export const DEFAULT_MAX_SOURCE_EPISODES = 40;
export const DEFAULT_MAX_EPISODE_CHARS = 2_000;
export const DEFAULT_IDLE_SWEEP_LIMIT = 20;

/** Appendix B provenance: what produced the node, as distinct from what later reads it. */
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
};

function settingsOf(options: NarrativeOptions): NarrativeSettings {
  return {
    model: options.model ?? DEFAULT_NARRATIVE_MODEL,
    idleMs: options.idleMs ?? DEFAULT_SESSION_IDLE_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_NARRATIVE_TIMEOUT_MS,
    maxSourceEpisodes: options.maxSourceEpisodes ?? DEFAULT_MAX_SOURCE_EPISODES,
    maxEpisodeChars: options.maxEpisodeChars ?? DEFAULT_MAX_EPISODE_CHARS,
    now: options.now ?? new Date(),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * One structured-output call, guarded. Reflection's latency regime is relaxed, not unbounded:
 * `qwen3:8b` with reasoning on measured 10-44s with occasional non-returns, so reasoning is
 * off and the call carries its own deadline rather than relying on the orchestrator, which
 * imposes none.
 */
async function compress(
  deps: NarrativeDeps,
  settings: NarrativeSettings,
  source: NarrativeSource,
): Promise<NarrativeOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const raw = await deps.provider.generate({
      model: settings.model,
      messages: buildNarrativeMessages(source.text),
      schema: NARRATIVE_JSON_SCHEMA,
      maxTokens: DEFAULT_NARRATIVE_MAX_TOKENS,
      think: false,
      signal: controller.signal,
    });
    return NarrativeOutputSchema.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

type NarrativeWrite = {
  readonly narrativeId: string;
  readonly sessionId: string;
  readonly decision: NarrativeDecision;
  readonly output: NarrativeOutput;
  readonly source: NarrativeSource;
  readonly span: NarrativeSpan;
  readonly now: Date;
};

/**
 * `summary` is the one-line gist every pack shows; `text` is the narrative body, which is
 * both what `content_fts` indexes and what the pending-vector drain would embed if the
 * embedder is down at close time. Writing the body under `text` is what keeps a narrative
 * that missed its vector recoverable by the ordinary backfill instead of permanently
 * invisible to vector search.
 */
function narrativeProperties(input: NarrativeWrite): GraphProperties {
  return {
    [MEMORY_PROPERTIES.summary]: input.output.summary,
    [MEMORY_PROPERTIES.text]: input.output.narrative,
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
    await writeStampedNodeInTransaction(tx, {
      label: 'Narrative',
      id: input.narrativeId,
      now: input.now,
      ...(input.span.end === undefined ? {} : { occurredAt: input.span.end }),
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
  now: Date,
): Promise<void> {
  for (const oldId of decision.supersedes) {
    if (oldId !== narrativeId) {
      await supersede(deps.driver, {
        oldId,
        newId: narrativeId,
        now,
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
async function attachVector(
  deps: NarrativeDeps,
  narrativeId: string,
  text: string,
): Promise<void> {
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
  const episodes = await loadSessionEpisodes(deps.driver, sessionId);
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

  const existing = await findSessionNarratives(deps.driver, sessionId);
  const decision = decideSessionNarrative(episodes, existing);
  const narrativeId = narrativeNodeId(sessionId, decision.coverageKey);

  if (decision.action === 'skip') {
    await closeSuperseded(deps, decision, narrativeId, settings.now);
    return skipped(sessionId, episodes.length, decision.reason);
  }

  const source = renderNarrativeSource(
    episodes,
    settings.maxSourceEpisodes,
    settings.maxEpisodeChars,
  );

  let output: NarrativeOutput;
  try {
    output = await compress(deps, settings, source);
  } catch (err) {
    deps.logger.warn({ err, sessionId, episodes: episodes.length }, 'narrative compression failed');
    return {
      status: 'failed',
      summary: `narrative compression failed: ${errorMessage(err)}`,
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
    span: narrativeSpan(episodes),
    now: settings.now,
  };
  await writeNarrative(deps, write);
  await closeSuperseded(deps, decision, narrativeId, settings.now);
  await attachVector(deps, narrativeId, output.narrative);

  deps.logger.info(
    {
      sessionId,
      narrativeId,
      version: decision.version,
      episodes: episodes.length,
      rendered: source.renderedCount,
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
    limit: options.limit ?? DEFAULT_IDLE_SWEEP_LIMIT,
  });

  const results: NarrativeResult[] = [];
  for (const session of idle) {
    results.push(await narrateSession(deps, session.sessionId, settings, true));
  }
  return results;
}

export type SessionNarrativeOptions = Omit<NarrativeOptions, 'now'>;

/**
 * Algorithm 4 step 9. The stage carries the idle rule rather than the close: by the time an
 * episode reflects, its session is usually seconds old and still open, and the narrative is
 * the close hook's to write. What the stage catches is the other case — a backlog drained
 * after the fact, a retry that landed hours late — where the session is long gone and no
 * close hook will ever fire for it again.
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
    const settings = settingsOf({ ...this.#options, now: ctx.now });
    const result = await narrateSession(deps, ctx.episode.sessionId, settings, true);

    if (result.status === 'created') {
      return { status: 'ok', summary: result.summary, counts: { narratives: 1 } };
    }
    return { status: result.status === 'failed' ? 'failed' : 'skipped', summary: result.summary };
  }
}

/**
 * The transport-close hook in the shape the MCP service takes it: a synchronous callback.
 * Compression is a model call, so it cannot be awaited on a teardown path — the close is
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
