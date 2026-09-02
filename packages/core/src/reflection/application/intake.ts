import {
  ReflectionInputSchema,
  type ReflectionOrigin,
  type ReflectionOutput,
} from '@aion/protocol';

import {
  storeExperience,
  type ExperienceStoreDeps,
  type StoredEpisode,
} from './experience-store.js';
import type { LaneAssigner, LaneDecision } from './lanes.js';
import { attachContentVectors } from './vectors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { countQueueJobs } from '../../infrastructure/sqlite/reflection-queue-admin.js';
import {
  DEFAULT_REFLECTION_LANE,
  enqueueReflectionJob,
  findPendingReflectionJob,
  type ReflectionLane,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import { prepareEpisode, type PreparedEpisode, type ReflectionContent } from '../domain/content.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/** The one job intake enqueues. The reflection pipeline's stages fan out from it; intake never runs them. */
export const INTEGRATE_JOB_TYPE = 'integrate';

/** The payload field the integrate job is keyed on, and how a queued job is matched back to its episode. */
const EPISODE_ID_FIELD = 'episode_id';

export type ReflectionIntakeDeps = ExperienceStoreDeps & {
  readonly db: SqliteHandle;
  readonly provider: Provider;
  /**
   * Called once per newly enqueued job, which is what wakes the worker: the queue row is
   * durability for a restart, not something a loop watches. A listener that throws never
   * fails the intake, since the experience is already durable in the graph and the queue by
   * the time it runs.
   */
  readonly onJobEnqueued?: (jobId: string) => void | Promise<void>;
  readonly logger: Logger;
  /** From `loadConfig(env).redaction.entropyThreshold`; the config module is the only env reader. */
  readonly entropyThreshold: number;
  /** Per-process arrival counters behind the lane backstop; one instance for the service's life. */
  readonly lanes: LaneAssigner;
  /** `operational.workerMaxAttempts`, so `pending_ahead` counts only rows a worker will claim. */
  readonly workerMaxAttempts: number;
};

export type ReflectionIntakeOptions = {
  /** The transport's session identity. `session_id` in the payload overrides it. */
  readonly identity: string;
  readonly now?: Date;
};

type IntegrateJob = {
  readonly jobId: string;
  readonly enqueued: boolean;
  readonly lane: ReflectionLane;
  readonly decision: LaneDecision | undefined;
  /**
   * The row this call answers for was already claimable when the depth was measured, which is
   * only ever true of a duplicate push. It comes back out of `pending_ahead`, which counts what
   * sits ahead of this caller rather than the caller itself.
   */
  readonly countedInDepth: boolean;
};

/**
 * A listener that throws is logged and swallowed: by the time it runs the episode is already
 * in the graph and the job already in the queue, so losing the wakeup costs the worker's next
 * drain a job, not the caller their write.
 */
function notifyEnqueued(deps: ReflectionIntakeDeps, jobId: string): void {
  if (deps.onJobEnqueued === undefined) {
    return;
  }
  try {
    const result = deps.onJobEnqueued(jobId);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        deps.logger.error({ err, jobId }, 'reflection enqueue listener failed');
      });
    }
  } catch (err) {
    deps.logger.error({ err, jobId }, 'reflection enqueue listener failed');
  }
}

/**
 * Claimable interactive-lane rows already in the queue, measured before this call's own job
 * lands. Interactive is served strictly first (the lanes pin), so this is exactly how many
 * jobs sit ahead of a fresh interactive enqueue and, for a caller demoted to bulk, how many
 * interactive jobs it queues behind either way. The ack used to say `queued: true` with no
 * sense of how far behind that queue actually was.
 *
 * Bounded by the attempt limit, so a row the claim path will never take again is not reported
 * as something to wait for: one exhausted job once made every ack say "1 job ahead" against an
 * empty queue.
 */
function pendingAhead(db: SqliteHandle, maxAttempts: number): number {
  return countQueueJobs(db, { lane: DEFAULT_REFLECTION_LANE }, maxAttempts).pending;
}

/**
 * The queue row is derived from the graph, so it is repaired rather than assumed: a crash
 * between the episode's commit and this insert would otherwise strand the episode forever,
 * since every retry then matches it by content hash, answers `queued: true`, and never
 * reaches the enqueue. Checking for the pending row instead converges: the retry finds the
 * episode and the missing job, and queues it.
 *
 * better-sqlite3 is synchronous and this function awaits nothing, so the check and the
 * insert cannot interleave with another intake in this process. The long-lived service is
 * the single writer of this table; the CLI container claims, it does not enqueue.
 */
function ensureIntegrateJob(
  deps: ReflectionIntakeDeps,
  episodeId: string,
  sessionId: string,
  requested: ReflectionLane | undefined,
  now: Date,
): IntegrateJob {
  // A payload the substrate already holds is not an arrival: counting a client's own retries
  // against it would let a repeated push demote the session for work already queued.
  const pending = findPendingReflectionJob(
    deps.db,
    INTEGRATE_JOB_TYPE,
    EPISODE_ID_FIELD,
    episodeId,
  );
  if (pending !== undefined) {
    return {
      jobId: pending.id,
      enqueued: false,
      lane: pending.lane,
      decision: undefined,
      countedInDepth:
        pending.lane === DEFAULT_REFLECTION_LANE &&
        pending.claimedAt === null &&
        pending.attempts < deps.workerMaxAttempts,
    };
  }

  const decision = deps.lanes.assign({ sessionId, requested, now });
  const jobId = enqueueReflectionJob(
    deps.db,
    INTEGRATE_JOB_TYPE,
    { [EPISODE_ID_FIELD]: episodeId },
    { lane: decision.lane, sessionId, now },
  );
  return { jobId, enqueued: true, lane: decision.lane, decision, countedInDepth: false };
}

type IntakeArchive = {
  readonly identity: string;
  readonly sessionId: string;
  readonly episodeId: string;
  readonly prepared: PreparedEpisode;
  /** The redacted content, which is what the substrate holds and what a re-derivation must match. */
  readonly payload: ReflectionContent;
  readonly lane: ReflectionLane | undefined;
  readonly origin: ReflectionOrigin | undefined;
  readonly now: Date;
};

type ArchivedIntake = {
  /** False when the archive already held this experience under this identity. */
  readonly archived: boolean;
  readonly job: IntegrateJob;
};

/**
 * The archive row and the queue row as one commit. Both are synchronous better-sqlite3 calls
 * with nothing awaited between them, so the transaction costs nothing and buys the invariant
 * the two rows are worth having together: no job for an experience the archive does not hold.
 *
 * `occurred_at` is the payload's own clock and `archived_at` is the caller's, which is the
 * only wall-clock value on the row. A re-pushed payload conflicts on the idempotency key and
 * inserts nothing, so the row the first push wrote stays exactly as it was written.
 */
function archiveAndQueue(deps: ReflectionIntakeDeps, input: IntakeArchive): ArchivedIntake {
  return deps.db.transaction((): ArchivedIntake => ({
    archived: insertExperience(deps.db, {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      identity: input.identity,
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      contentHash: input.prepared.contentHash,
      occurredAt: input.prepared.occurredAt.toISOString(),
      archivedAt: input.now.toISOString(),
      lane: input.lane,
      origin: input.origin,
      payload: input.payload,
    }),
    job: ensureIntegrateJob(deps, input.episodeId, input.sessionId, input.lane, input.now),
  }))();
}

/**
 * The last step, and the only one allowed to fail without failing the call. Everything the
 * caller was promised is already durable: a node that ends this function without its
 * `content_vec` is a pending-vector marker the worker's drain resolves later, and until it
 * does, the episode is reachable by BM25, entity resolution, recency, and traversal: it is
 * ranking that is missing, not the memory.
 */
async function attachVectors(
  deps: ReflectionIntakeDeps,
  stored: StoredEpisode,
  sessionId: string,
): Promise<void> {
  try {
    await attachContentVectors(deps.driver, deps.provider, stored.pending);
  } catch (err) {
    deps.logger.warn(
      { err, episodeId: stored.episodeId, sessionId, pending: stored.pending.length },
      'content vectors deferred; the episode is stored and queued',
    );
  }
}

/**
 * The write path. Validate, redact, store the episode and its turns with a full bitemporal
 * stamp, link the backbone, archive the payload beside the integrate job in one commit, wake
 * the worker, then embed.
 *
 * Redaction runs on the parsed payload before anything reads a content field, so no raw
 * credential reaches the hash, the embedder, the graph, or the archive: what the archive
 * holds is what the substrate holds. The graph then takes every write as one transaction, and
 * the queue row is repaired rather than assumed, so the two stores converge on a retry
 * instead of leaving an episode nothing will ever process.
 *
 * Embedding comes last on purpose: the episode and its queue row are already durable before
 * anything embeds, so reflection jobs still queue while the embedding service is down. The
 * durable record is the episode and its queue row; vectors are an enrichment of it, so an
 * inference outage costs ranking signal until the backfill runs, never the experience.
 *
 * No generation call happens anywhere here. Extraction is the pipeline's job, and intake is
 * what makes the experience durable.
 */
export async function handleReflection(
  deps: ReflectionIntakeDeps,
  input: unknown,
  options: ReflectionIntakeOptions,
): Promise<ReflectionOutput> {
  const now = options.now ?? new Date();
  const payload = ReflectionInputSchema.parse(input);

  // `session_id` and `lane` are routing, not content. Redacting an identity would fork the
  // session and break the FOLLOWS chain; leaving either in would put scheduling metadata in
  // the content hash, so the same experience pushed on two lanes would be two episodes.
  // `origin` is provenance about the call, not about what happened, so it is carved out the
  // same way: pushing the same experience via a hook and via the MCP client stays one episode.
  const { session_id: suppliedIdentity, lane: requestedLane, origin, ...content } = payload;
  const redacted = redactPayload(content, deps.entropyThreshold);
  if (redacted.matches.length > 0) {
    deps.logger.warn(
      { matches: redacted.matches, count: redacted.matches.length },
      'redacted secrets from reflection payload',
    );
  }

  const identity = suppliedIdentity ?? options.identity;
  const prepared = prepareEpisode(redacted.value, now);
  const { sessionId, stored } = await storeExperience(deps, prepared, identity, now, origin);
  // Measured before this call's own row lands, so a fresh enqueue is not counted against
  // itself. A duplicate push matched a row that is already inside this figure, and that row is
  // the caller's own, so it comes back out below.
  const depth = pendingAhead(deps.db, deps.workerMaxAttempts);
  const { archived, job } = archiveAndQueue(deps, {
    identity,
    sessionId,
    episodeId: stored.episodeId,
    prepared,
    payload: redacted.value,
    lane: requestedLane,
    origin,
    now,
  });
  const ahead = job.countedInDepth ? depth - 1 : depth;
  if (job.enqueued) {
    notifyEnqueued(deps, job.jobId);
  }
  if (job.decision !== undefined && job.decision.lane !== DEFAULT_REFLECTION_LANE) {
    const laneFields = {
      episodeId: stored.episodeId,
      sessionId,
      reason: job.decision.reason,
      sessionArrivals: job.decision.sessionArrivals,
      globalArrivals: job.decision.globalArrivals,
    };
    // A client that asked for the bulk lane got what it asked for, which is not a problem an
    // operator has to look at. Only the arrival-rate backstop is a demotion, so only it warns.
    if (job.decision.reason === 'requested') {
      deps.logger.info(laneFields, 'reflection queued in the bulk lane');
    } else {
      deps.logger.warn(laneFields, 'reflection queued in the bulk lane');
    }
  }

  await attachVectors(deps, stored, sessionId);

  if (!stored.created) {
    // Info, not debug: a caller re-pushing an experience the substrate already holds is what
    // an operator reads to tell a retry storm from real traffic, and it is invisible at the
    // level production runs. One line per duplicate push bounds the volume by the client.
    deps.logger.info(
      { episodeId: stored.episodeId, sessionId, requeued: job.enqueued, lane: job.lane, archived },
      'reflection payload already stored',
    );
    return { episode_id: stored.episodeId, queued: true, lane: job.lane, pending_ahead: ahead };
  }

  deps.logger.info(
    {
      episodeId: stored.episodeId,
      sessionId,
      jobId: job.jobId,
      lane: job.lane,
      turns: prepared.turnCount,
      toolExecutions: prepared.toolExecutionCount,
      observations: prepared.observationCount,
    },
    'reflection stored',
  );

  return { episode_id: stored.episodeId, queued: true, lane: job.lane, pending_ahead: ahead };
}
