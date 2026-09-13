import type { Driver } from 'neo4j-driver';

import { dispatchChunkNarrative } from './narrative-chunk-dispatch.js';
import { ensureSessionFamily } from './narrative-family.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { findIdleSessions } from '../../infrastructure/graph/narrative-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';
import type { ChunkBoundaryPolicy } from '../domain/chunk-boundary.js';
import { narrativeScale } from '../domain/narrative-scale.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../domain/stage.js';

/**
 * The pinned trigger: a session's close produces a session-scope narrative. Two entry points
 * reach the same routine: the transport's close hook, which is an explicit boundary, and the
 * idle rule, which is what a client that vanished without a DELETE leaves behind. The
 * reflection stage carries the idle rule for the episodes whose pipeline runs long after
 * their session went quiet.
 */

export const NARRATIVE_STAGE_NAME = 'narratives';

const MINUTE_MS = 60 * 1000;

/** The idle window in the unit the closer works in; config states it in minutes. */
export const DEFAULT_SESSION_IDLE_MS = DEFAULTS.reflection.narrativeIdleMinutes * MINUTE_MS;

export { NARRATIVE_EXTRACTION_METHOD } from '../domain/narrative.js';

export type NarrativeDeps = {
  readonly driver: Driver;
  readonly provider: Provider;
  readonly logger: Logger;
  readonly db?: SqliteHandle;
  readonly publications?: PublicationCoordinator;
  readonly resolver?: EvidenceResolver;
};

export type NarrativeOptions = {
  readonly chunkPolicy?: ChunkBoundaryPolicy;
  readonly model?: string;
  readonly idleMs?: number;
  readonly timeoutMs?: number;
  /**
   * The knob group the synthesis is sized out of. Both routes' numbers live in it and the
   * resolved route picks between them, so a caller threads the group a deployment configured
   * rather than picking a window itself and pinning the local one onto a remote model.
   */
  readonly reflection?: Config['reflection'];
  readonly now?: Date;
  /**
   * The world time to fall back on when the session's episodes carry no span end. Defaults
   * to `now`, which dates the narrative to the write.
   */
  readonly occurredAt?: Date;
  /** Cleanup only: rewrite the standing narrative over the same episodes, superseding it. */
  readonly regenerate?: boolean;
  /** The caller's shutdown signal, composed under each compression call's own deadline. */
  readonly signal?: AbortSignal;
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

/** Every option resolved, which is what the compression beside this reads its sizes from. */
export type NarrativeSettings = {
  readonly chunkPolicy?: ChunkBoundaryPolicy;
  readonly model: string;
  readonly idleMs: number;
  readonly timeoutMs: number;
  readonly maxSourceEpisodes: number;
  readonly maxEpisodeChars: number;
  readonly maxSentences: number;
  readonly now: Date;
  readonly occurredAt: Date;
  readonly regenerate: boolean;
  readonly signal?: AbortSignal;
};

/** Keeps the legacy renderer's route-specific input sizes. */
function settingsOf(options: NarrativeOptions, provider: Provider): NarrativeSettings {
  const now = options.now ?? new Date();
  const scale = narrativeScale(
    provider.route?.provider === 'anthropic',
    options.reflection ?? DEFAULTS.reflection,
  );
  return {
    ...(options.chunkPolicy === undefined ? {} : { chunkPolicy: options.chunkPolicy }),
    model: options.model ?? DEFAULTS.anthropic.model,
    idleMs: options.idleMs ?? DEFAULT_SESSION_IDLE_MS,
    timeoutMs: options.timeoutMs ?? DEFAULTS.reflection.stageTimeoutMs,
    maxSourceEpisodes: scale.maxSourceEpisodes,
    maxEpisodeChars: scale.episodeChars,
    maxSentences: scale.maxSentences,
    now,
    occurredAt: options.occurredAt ?? now,
    regenerate: options.regenerate ?? false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/**
 * One boundary, evaluated and acted on. `requireIdle` is the difference between the two
 * triggers: a transport close is an explicit end, while the sweep and the reflection stage
 * have only silence to go on. Silence is no longer the only thing they have: a session still
 * running crosses a mid-session boundary on its own length or on a pause inside it, and the
 * narrative that boundary writes is an ordinary version the close later supersedes.
 */
async function narrateSession(
  deps: NarrativeDeps,
  sessionId: string,
  settings: NarrativeSettings,
  requireIdle: boolean,
): Promise<NarrativeResult> {
  if (deps.db === undefined || deps.publications === undefined) {
    return {
      status: 'failed',
      sessionId,
      episodes: 0,
      summary: 'narrative publication is not composed',
    };
  }
  await deps.publications.recover();
  const family = await ensureSessionFamily(
    { ...deps, db: deps.db, publications: deps.publications },
    sessionId,
  );
  if (family.status !== 'ready') {
    return { status: 'failed', sessionId, episodes: 0, summary: family.reason };
  }
  const coverage = checkPresentCoverage(deps.db, settings.now);
  if (coverage.status !== 'checked') {
    return {
      status: 'failed',
      sessionId,
      episodes: 0,
      summary: `coverage ${coverage.refusal.reason}`,
    };
  }
  return dispatchChunkNarrative(
    { ...deps, db: deps.db, publications: deps.publications },
    sessionId,
    settings,
    !requireIdle,
  );
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
  return narrateSession(deps, sessionId, settingsOf(options, deps.provider), false);
}

/**
 * The idle trigger, for the clients that vanish without a close. Bounded by `limit` and
 * scheduled by nobody here: the worker or the maintenance tick calls it.
 */
export async function sweepIdleSessions(
  deps: NarrativeDeps,
  options: IdleSweepOptions = {},
): Promise<readonly NarrativeResult[]> {
  const settings = settingsOf(options, deps.provider);
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

  /**
   * What this instance runs on. The run's own clock and shutdown signal are the orchestrator's
   * and are not part of what readiness requires, so they are not here to be recorded.
   */
  describe(): Omit<SessionNarrativeOptions, 'signal'> {
    const options: SessionNarrativeOptions & { signal?: AbortSignal } = { ...this.#options };
    delete options.signal;
    return options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const deps: NarrativeDeps = {
      driver: ctx.driver,
      provider: ctx.provider,
      logger: ctx.logger,
      db: ctx.db,
      ...(ctx.publications === undefined ? {} : { publications: ctx.publications }),
    };
    const settings = settingsOf(
      {
        ...this.#options,
        now: ctx.now,
        occurredAt: ctx.occurredAt,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
      ctx.provider,
    );
    const result = await narrateSession(deps, ctx.episode.sessionId, settings, true);

    if (result.status === 'created') {
      return { status: 'ok', summary: result.summary, counts: { narratives: 1 } };
    }
    if (result.status === 'failed') {
      return { status: 'failed', summary: result.summary };
    }
    // What this stage owes one source is the dispatch, and a session that has not reached a
    // boundary has taken it. Whether a narrative covers that source is a separate question with
    // its own record: no session-wide stage outcome answers it.
    return {
      status: 'skipped',
      summary: result.summary,
      settled: {
        disposition: 'complete',
        reason: 'dispatch_acknowledged',
        proof: { sessionId: result.sessionId, episodes: result.episodes },
      },
    };
  }
}

export { SessionNarrativeCloser } from './session-narrative-closer.js';
