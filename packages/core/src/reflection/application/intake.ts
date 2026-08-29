import { ReflectionInputSchema, type ReflectionOutput } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import { writeStampedNodeInTransaction } from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction, type GraphTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { isGraphUnavailable } from '../../infrastructure/graph/errors.js';
import {
  CONTAINMENT_TYPE,
  findEpisodeByContentHash,
  findEpisodeByContentHashInTransaction,
  MEMORY_PROPERTIES,
} from '../../infrastructure/graph/episodes.js';
import { lockNodeInTransaction } from '../../infrastructure/graph/locks.js';
import type { PendingVectorNode } from '../../infrastructure/graph/pending-vectors.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import type { SessionManager } from '../../session/session-manager.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { countQueueJobs } from '../../infrastructure/sqlite/reflection-queue-admin.js';
import {
  DEFAULT_REFLECTION_LANE,
  enqueueReflectionJob,
  findPendingReflectionJob,
  type ReflectionLane,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { prepareEpisode, type PreparedEpisode, type PreparedTurn } from '../domain/content.js';
import type { ReflectionDispatch } from './dispatch.js';
import { ReflectionNotStoredError } from './errors.js';
import type { LaneAssigner, LaneDecision } from './lanes.js';
import { attachContentVectors } from './vectors.js';

/** The one job intake enqueues. P3's pipeline stages fan out from it; intake never runs them. */
export const INTEGRATE_JOB_TYPE = 'integrate';

/** The payload field the integrate job is keyed on, and how a queued job is matched back to its episode. */
const EPISODE_ID_FIELD = 'episode_id';

/** Appendix B provenance: how the node got into the graph, as opposed to what extracted it later. */
export const INTAKE_EXTRACTION_METHOD = 'reflection_intake';

const STRUCTURAL_SIGNALS = ['structural'];
const STRUCTURAL_PROVENANCE = ['reflection_intake'];

export type ReflectionIntakeDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly sessions: SessionManager;
  readonly provider: Provider;
  readonly dispatch: ReflectionDispatch;
  readonly logger: Logger;
  /** From `loadConfig(env).redaction.entropyThreshold`; the config module is the only env reader. */
  readonly entropyThreshold: number;
  /** Per-process arrival counters behind the lane backstop; one instance for the service's life. */
  readonly lanes: LaneAssigner;
  /** `operational.workerMaxAttempts`, so `pending_ahead` counts only rows a worker will claim. */
  readonly workerMaxAttempts: number;
};

export type ReflectionIntakeOptions = {
  /** The transport's session identity. `session_id` in the payload overrides it (PRD §3.3). */
  readonly identity: string;
  readonly now?: Date;
};

function episodeProperties(prepared: PreparedEpisode, sessionId: string): GraphProperties {
  return {
    [MEMORY_PROPERTIES.text]: prepared.text,
    [MEMORY_PROPERTIES.summary]: prepared.summary,
    [MEMORY_PROPERTIES.contentHash]: prepared.contentHash,
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [MEMORY_PROPERTIES.extractionMethod]: INTAKE_EXTRACTION_METHOD,
    [MEMORY_PROPERTIES.turnCount]: prepared.turnCount,
    [MEMORY_PROPERTIES.toolExecutionCount]: prepared.toolExecutionCount,
    [MEMORY_PROPERTIES.observationCount]: prepared.observationCount,
  };
}

function turnProperties(turn: PreparedTurn, episodeId: string, sessionId: string): GraphProperties {
  return {
    [MEMORY_PROPERTIES.text]: turn.text,
    [MEMORY_PROPERTIES.role]: turn.role,
    [MEMORY_PROPERTIES.sequence]: turn.sequence,
    [MEMORY_PROPERTIES.contentHash]: turn.contentHash,
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [MEMORY_PROPERTIES.sourceEpisodeId]: episodeId,
    [MEMORY_PROPERTIES.extractionMethod]: INTAKE_EXTRACTION_METHOD,
  };
}

async function linkStructural(
  tx: GraphTransaction,
  type: typeof CONTAINMENT_TYPE | 'FOLLOWS',
  sourceId: string,
  targetId: string,
  now: Date,
): Promise<void> {
  await upsertEdgeInTransaction(tx, {
    type,
    sourceId,
    targetId,
    strength: 1,
    confidence: 1,
    signals: STRUCTURAL_SIGNALS,
    provenance: STRUCTURAL_PROVENANCE,
    count: 0,
    now,
  });
}

type StoredEpisode = {
  readonly episodeId: string;
  readonly created: boolean;
  /** The nodes this call committed without a `content_vec`; empty for a duplicate. */
  readonly pending: readonly PendingVectorNode[];
};

/**
 * Every graph write of one intake, in one transaction: the episode, its turns, and the
 * edges that reach them. Nothing here is separately visible, so a failure at any point
 * leaves the graph exactly as it was and a retry starts clean.
 *
 * No embedding is involved. The nodes commit without `content_vec` and the caller attaches
 * vectors afterward, which is what makes an inference outage cost the vectors rather than
 * the experience.
 *
 * The session is locked first. Dedupe is a read that decides a write, and the read alone
 * is not enough — two concurrent pushes of the same payload would each find no duplicate
 * and each store one. Locking the session serializes intake for that session, which is the
 * grain that matters: it is one agent conversation, and different sessions still run in
 * parallel.
 */
async function storeEpisode(
  driver: Driver,
  prepared: PreparedEpisode,
  sessionId: string,
  now: Date,
): Promise<StoredEpisode> {
  return inWriteTransaction(driver, async (tx) => {
    await lockNodeInTransaction(tx, sessionId, now);

    const duplicate = await findEpisodeByContentHashInTransaction(tx, {
      sessionId,
      contentHash: prepared.contentHash,
    });
    if (duplicate !== undefined) {
      return { episodeId: duplicate, created: false, pending: [] };
    }

    const episode = await writeStampedNodeInTransaction(tx, {
      label: 'Episode',
      now,
      occurredAt: prepared.occurredAt,
      properties: episodeProperties(prepared, sessionId),
    });
    const pending: PendingVectorNode[] = [{ id: episode.id, text: prepared.text }];

    await linkStructural(tx, CONTAINMENT_TYPE, episode.id, sessionId, now);

    let previousTurnId: string | undefined;
    for (const turn of prepared.turns) {
      const node = await writeStampedNodeInTransaction(tx, {
        label: 'Turn',
        now,
        occurredAt: turn.occurredAt,
        properties: turnProperties(turn, episode.id, sessionId),
      });
      pending.push({ id: node.id, text: turn.text });

      await linkStructural(tx, CONTAINMENT_TYPE, node.id, episode.id, now);
      if (previousTurnId !== undefined) {
        await linkStructural(tx, 'FOLLOWS', node.id, previousTurnId, now);
      }
      previousTurnId = node.id;
    }

    return { episodeId: episode.id, created: true, pending };
  });
}

/**
 * The episode this payload belongs to: the one already stored, or a newly written one. The
 * cheap read comes first so a re-pushed payload never opens a write transaction or takes
 * the session's lock. The authoritative dedupe is the one `storeEpisode` runs under it.
 */
async function resolveEpisode(
  deps: ReflectionIntakeDeps,
  prepared: PreparedEpisode,
  sessionId: string,
  now: Date,
): Promise<StoredEpisode> {
  const known = await findEpisodeByContentHash(deps.driver, {
    sessionId,
    contentHash: prepared.contentHash,
  });
  if (known !== undefined) {
    return { episodeId: known, created: false, pending: [] };
  }
  return storeEpisode(deps.driver, prepared, sessionId, now);
}

type DurableWrite = {
  readonly sessionId: string;
  readonly stored: StoredEpisode;
};

/**
 * Everything between a validated payload and a committed episode, wrapped as one region
 * because every failure inside it leaves the same state: nothing written, nothing queued.
 * That fact is what the caller has to act on, and a raw `Neo4jError` does not carry it. A
 * statement the graph itself rejected is a defect here, not an outage, and passes through
 * unchanged.
 *
 * Only the graph can put intake in that state now. Inference happens after this region
 * commits, so an Ollama outage never reaches it.
 */
async function storeDurably(
  deps: ReflectionIntakeDeps,
  prepared: PreparedEpisode,
  identity: string,
  now: Date,
): Promise<DurableWrite> {
  try {
    const { sessionId } = await deps.sessions.ensureSession({ identity, now });
    const stored = await resolveEpisode(deps, prepared, sessionId, now);
    return { sessionId, stored };
  } catch (err) {
    if (isGraphUnavailable(err)) {
      throw new ReflectionNotStoredError('graph', err);
    }
    throw err;
  }
}

/**
 * The queue row is derived from the graph, so it is repaired rather than assumed: a crash
 * between the episode's commit and this insert would otherwise strand the episode forever,
 * since every retry then matches it by content hash, answers `queued: true`, and never
 * reaches the enqueue. Checking for the pending row instead converges — the retry finds the
 * episode and the missing job, and queues it.
 *
 * better-sqlite3 is synchronous and this function awaits nothing, so the check and the
 * insert cannot interleave with another intake in this process. The long-lived service is
 * the single writer of this table (PRD §4); the CLI container claims, it does not enqueue.
 */
type IntegrateJob = {
  readonly jobId: string;
  readonly enqueued: boolean;
  readonly lane: ReflectionLane;
  readonly decision: LaneDecision | undefined;
};

/**
 * Claimable interactive-lane rows already in the queue, measured before this call's own job
 * lands. Interactive is served strictly first (the lanes pin), so this is exactly how many
 * jobs sit ahead of a fresh interactive enqueue and, for a caller demoted to bulk, how many
 * interactive jobs it queues behind either way — the ack used to say `queued: true` with no
 * sense of how far behind that queue actually was.
 *
 * Bounded by the attempt limit, so a row the claim path will never take again is not reported
 * as something to wait for: one exhausted job made every ack in the exercise say "1 job ahead"
 * against an empty queue.
 */
function pendingAhead(db: SqliteHandle, maxAttempts: number): number {
  return countQueueJobs(db, { lane: DEFAULT_REFLECTION_LANE }, maxAttempts).pending;
}

function ensureIntegrateJob(
  deps: ReflectionIntakeDeps,
  episodeId: string,
  sessionId: string,
  requested: ReflectionLane | undefined,
  now: Date,
): IntegrateJob {
  // A payload the substrate already holds is not an arrival: counting a client's own retries
  // against it would let a repeated push demote the session for work already queued.
  const pending = findPendingReflectionJob(deps.db, INTEGRATE_JOB_TYPE, EPISODE_ID_FIELD, episodeId);
  if (pending !== undefined) {
    return { jobId: pending.id, enqueued: false, lane: pending.lane, decision: undefined };
  }

  const decision = deps.lanes.assign({ sessionId, requested, now });
  const jobId = enqueueReflectionJob(
    deps.db,
    INTEGRATE_JOB_TYPE,
    { [EPISODE_ID_FIELD]: episodeId },
    { lane: decision.lane, sessionId },
  );
  return { jobId, enqueued: true, lane: decision.lane, decision };
}

/**
 * The last step, and the only one allowed to fail without failing the call. Everything the
 * caller was promised is already durable: a node that ends this function without its
 * `content_vec` is a pending-vector marker the worker's drain resolves later, and until it
 * does, the episode is reachable by BM25, entity resolution, recency, and traversal — it is
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
 * PRD §3.2, whitepaper §4.1–4.2: the write path. Validate, redact, store the episode and
 * its turns with a full bitemporal stamp, link the backbone, enqueue the integrate job,
 * signal the dispatcher, then embed.
 *
 * Redaction runs on the parsed payload before anything reads a content field, so no raw
 * credential reaches the hash, the embedder, or the graph. The graph then takes every write
 * as one transaction, and the queue row is repaired rather than assumed, so the two stores
 * converge on a retry instead of leaving an episode nothing will ever process.
 *
 * Embedding comes last on purpose (PRD §10: "reflection jobs queue until service returns").
 * The durable record is the episode and its queue row; vectors are an enrichment of it, so
 * an inference outage costs ranking signal until the backfill runs, never the experience.
 *
 * No generation call happens anywhere here. Extraction is the pipeline's job (whitepaper
 * §6.1) and intake is what makes the experience durable.
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
  const { session_id: suppliedIdentity, lane: requestedLane, ...content } = payload;
  const redacted = redactPayload(content, deps.entropyThreshold);
  if (redacted.matches.length > 0) {
    deps.logger.warn(
      { matches: redacted.matches, count: redacted.matches.length },
      'redacted secrets from reflection payload',
    );
  }

  const prepared = prepareEpisode(redacted.value, now);
  const { sessionId, stored } = await storeDurably(
    deps,
    prepared,
    suppliedIdentity ?? options.identity,
    now,
  );
  // Measured before this call's own row lands, so a fresh enqueue is not counted against
  // itself; a duplicate payload reads the same figure the already-queued job would.
  const ahead = pendingAhead(deps.db, deps.workerMaxAttempts);
  const job = ensureIntegrateJob(deps, stored.episodeId, sessionId, requestedLane, now);
  if (job.enqueued) {
    deps.dispatch.signal({
      jobId: job.jobId,
      jobType: INTEGRATE_JOB_TYPE,
      episodeId: stored.episodeId,
      sessionId,
      enqueuedAt: now,
    });
  }
  if (job.decision !== undefined && job.decision.lane !== DEFAULT_REFLECTION_LANE) {
    deps.logger.warn(
      {
        episodeId: stored.episodeId,
        sessionId,
        reason: job.decision.reason,
        sessionArrivals: job.decision.sessionArrivals,
        globalArrivals: job.decision.globalArrivals,
      },
      'reflection queued in the bulk lane',
    );
  }

  await attachVectors(deps, stored, sessionId);

  if (!stored.created) {
    deps.logger.debug(
      { episodeId: stored.episodeId, sessionId, requeued: job.enqueued, lane: job.lane },
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
