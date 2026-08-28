import { ReflectionInputSchema, type ReflectionOutput } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import { writeStampedNodeInTransaction } from '../graph/bitemporal.js';
import { inWriteTransaction, type GraphTransaction } from '../graph/connection.js';
import { upsertEdgeInTransaction } from '../graph/edges.js';
import {
  CONTAINMENT_TYPE,
  findEpisodeByContentHash,
  findEpisodeByContentHashInTransaction,
  MEMORY_PROPERTIES,
} from '../graph/episodes.js';
import { lockNodeInTransaction } from '../graph/locks.js';
import { toGraphVector, type GraphProperties } from '../graph/values.js';
import type { Logger } from '../logging/logger.js';
import type { Provider, Vector } from '../providers/types.js';
import { redactPayload } from '../redact/deep-walk.js';
import type { SessionManager } from '../session/session-manager.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { enqueueReflectionJob, findPendingReflectionJob } from '../sqlite/reflection-queue.js';
import { prepareEpisode, type PreparedEpisode, type PreparedTurn } from './content.js';
import type { ReflectionDispatch } from './dispatch.js';

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
};

export type ReflectionIntakeOptions = {
  /** The transport's session identity. `session_id` in the payload overrides it (PRD §3.3). */
  readonly identity: string;
  readonly now?: Date;
};

function requireVector(vectors: readonly Vector[], index: number): Vector {
  const vector = vectors[index];
  if (vector === undefined) {
    throw new Error(`embed returned ${String(vectors.length)} vectors, expected at least ${String(index + 1)}`);
  }
  return vector;
}

function episodeProperties(
  prepared: PreparedEpisode,
  sessionId: string,
  vector: Vector,
): GraphProperties {
  return {
    [MEMORY_PROPERTIES.text]: prepared.text,
    [MEMORY_PROPERTIES.summary]: prepared.summary,
    [MEMORY_PROPERTIES.contentHash]: prepared.contentHash,
    [MEMORY_PROPERTIES.contentVector]: toGraphVector(vector),
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [MEMORY_PROPERTIES.extractionMethod]: INTAKE_EXTRACTION_METHOD,
    [MEMORY_PROPERTIES.turnCount]: prepared.turnCount,
    [MEMORY_PROPERTIES.toolExecutionCount]: prepared.toolExecutionCount,
    [MEMORY_PROPERTIES.observationCount]: prepared.observationCount,
  };
}

function turnProperties(
  turn: PreparedTurn,
  episodeId: string,
  sessionId: string,
  vector: Vector,
): GraphProperties {
  return {
    [MEMORY_PROPERTIES.text]: turn.text,
    [MEMORY_PROPERTIES.role]: turn.role,
    [MEMORY_PROPERTIES.sequence]: turn.sequence,
    [MEMORY_PROPERTIES.contentHash]: turn.contentHash,
    [MEMORY_PROPERTIES.contentVector]: toGraphVector(vector),
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
};

/**
 * Every graph write of one intake, in one transaction: the episode, its turns, and the
 * edges that reach them. Nothing here is separately visible, so a failure at any point
 * leaves the graph exactly as it was and a retry starts clean.
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
  vectors: readonly Vector[],
  now: Date,
): Promise<StoredEpisode> {
  return inWriteTransaction(driver, async (tx) => {
    await lockNodeInTransaction(tx, sessionId, now);

    const duplicate = await findEpisodeByContentHashInTransaction(tx, {
      sessionId,
      contentHash: prepared.contentHash,
    });
    if (duplicate !== undefined) {
      return { episodeId: duplicate, created: false };
    }

    const episode = await writeStampedNodeInTransaction(tx, {
      label: 'Episode',
      now,
      occurredAt: prepared.occurredAt,
      properties: episodeProperties(prepared, sessionId, requireVector(vectors, 0)),
    });

    await linkStructural(tx, CONTAINMENT_TYPE, episode.id, sessionId, now);

    let previousTurnId: string | undefined;
    for (const turn of prepared.turns) {
      const node = await writeStampedNodeInTransaction(tx, {
        label: 'Turn',
        now,
        occurredAt: turn.occurredAt,
        properties: turnProperties(turn, episode.id, sessionId, requireVector(vectors, turn.sequence + 1)),
      });

      await linkStructural(tx, CONTAINMENT_TYPE, node.id, episode.id, now);
      if (previousTurnId !== undefined) {
        await linkStructural(tx, 'FOLLOWS', node.id, previousTurnId, now);
      }
      previousTurnId = node.id;
    }

    return { episodeId: episode.id, created: true };
  });
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
function ensureIntegrateJob(db: SqliteHandle, episodeId: string): { jobId: string; enqueued: boolean } {
  const pending = findPendingReflectionJob(db, INTEGRATE_JOB_TYPE, EPISODE_ID_FIELD, episodeId);
  if (pending !== undefined) {
    return { jobId: pending.id, enqueued: false };
  }
  return {
    jobId: enqueueReflectionJob(db, INTEGRATE_JOB_TYPE, { [EPISODE_ID_FIELD]: episodeId }),
    enqueued: true,
  };
}

/**
 * PRD §3.2, whitepaper §4.1–4.2: the write path. Validate, redact, resolve the session,
 * store the episode and its turns with a full bitemporal stamp, link the backbone, enqueue
 * the integrate job, signal the dispatcher, return.
 *
 * Three ordering choices are load-bearing. Redaction runs on the parsed payload before
 * anything reads a content field, so no raw credential reaches the hash, the embedder, or
 * the graph. Embedding runs before the transaction opens, because it is the one
 * network-dependent step and a write transaction must not be held open across it. The
 * graph writes then land as one transaction, and the queue row is repaired rather than
 * assumed, so the two stores converge on a retry instead of stranding the episode.
 *
 * The dedupe read happens twice on purpose: once here, cheaply, so a re-pushed payload does
 * not pay for an embedding it will discard, and again inside the transaction under the
 * session's lock, where it is the authoritative one.
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

  // `session_id` is routing, not content: redacting an identity would fork the session and
  // break the FOLLOWS chain, so it is lifted out before the walk and never re-joined.
  const { session_id: suppliedIdentity, ...content } = payload;
  const redacted = redactPayload(content, deps.entropyThreshold);
  if (redacted.matches.length > 0) {
    deps.logger.warn(
      { matches: redacted.matches, count: redacted.matches.length },
      'redacted secrets from reflection payload',
    );
  }

  const { sessionId } = await deps.sessions.ensureSession({
    identity: suppliedIdentity ?? options.identity,
    now,
  });

  const prepared = prepareEpisode(redacted.value, now);
  const known = await findEpisodeByContentHash(deps.driver, {
    sessionId,
    contentHash: prepared.contentHash,
  });

  const stored =
    known === undefined
      ? await storeEpisode(
          deps.driver,
          prepared,
          sessionId,
          await deps.provider.embed([prepared.text, ...prepared.turns.map((turn) => turn.text)]),
          now,
        )
      : { episodeId: known, created: false };

  const job = ensureIntegrateJob(deps.db, stored.episodeId);
  if (job.enqueued) {
    deps.dispatch.signal({
      jobId: job.jobId,
      jobType: INTEGRATE_JOB_TYPE,
      episodeId: stored.episodeId,
      sessionId,
      enqueuedAt: now,
    });
  }

  if (!stored.created) {
    deps.logger.debug(
      { episodeId: stored.episodeId, sessionId, requeued: job.enqueued },
      'reflection payload already stored',
    );
    return { episode_id: stored.episodeId, queued: true };
  }

  deps.logger.info(
    {
      episodeId: stored.episodeId,
      sessionId,
      jobId: job.jobId,
      turns: prepared.turnCount,
      toolExecutions: prepared.toolExecutionCount,
      observations: prepared.observationCount,
    },
    'reflection stored',
  );

  return { episode_id: stored.episodeId, queued: true };
}
