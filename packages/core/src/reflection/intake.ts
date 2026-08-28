import { ReflectionInputSchema, type ReflectionOutput } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import { writeStampedNode } from '../graph/bitemporal.js';
import { upsertEdge } from '../graph/edges.js';
import {
  CONTAINMENT_TYPE,
  findEpisodeByContentHash,
  MEMORY_PROPERTIES,
} from '../graph/episodes.js';
import { toGraphVector, type GraphProperties } from '../graph/values.js';
import type { Logger } from '../logging/logger.js';
import type { Provider, Vector } from '../providers/types.js';
import { redactPayload } from '../redact/deep-walk.js';
import type { SessionManager } from '../session/session-manager.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { enqueueReflectionJob } from '../sqlite/reflection-queue.js';
import { prepareEpisode, type PreparedEpisode, type PreparedTurn } from './content.js';
import type { ReflectionDispatch } from './dispatch.js';

/** The one job intake enqueues. P3's pipeline stages fan out from it; intake never runs them. */
export const INTEGRATE_JOB_TYPE = 'integrate';

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
  driver: Driver,
  type: typeof CONTAINMENT_TYPE | 'FOLLOWS',
  sourceId: string,
  targetId: string,
  now: Date,
): Promise<void> {
  await upsertEdge(driver, {
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

/**
 * PRD §3.2, whitepaper §4.1–4.2: the write path. Validate, redact, resolve the session,
 * store the episode and its turns with a full bitemporal stamp, link the backbone, enqueue
 * the integrate job, signal the dispatcher, return.
 *
 * Two ordering choices are load-bearing. Redaction runs on the parsed payload before
 * anything reads a content field, so no raw credential reaches the hash, the embedder, or
 * the graph. Embedding runs before the first node write, so the one network-dependent step
 * cannot leave a half-written episode behind: either the episode exists with its vectors,
 * its edges, and its queue row, or nothing was written and the caller's retry starts clean.
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

  const duplicate = await findEpisodeByContentHash(deps.driver, {
    sessionId,
    contentHash: prepared.contentHash,
  });
  if (duplicate !== undefined) {
    deps.logger.debug({ episodeId: duplicate, sessionId }, 'reflection payload already stored');
    return { episode_id: duplicate, queued: true };
  }

  const texts = [prepared.text, ...prepared.turns.map((turn) => turn.text)];
  const vectors = await deps.provider.embed(texts);

  const episode = await writeStampedNode(deps.driver, {
    label: 'Episode',
    now,
    occurredAt: prepared.occurredAt,
    properties: episodeProperties(prepared, sessionId, requireVector(vectors, 0)),
  });

  await linkStructural(deps.driver, CONTAINMENT_TYPE, episode.id, sessionId, now);

  let previousTurnId: string | undefined;
  for (const turn of prepared.turns) {
    const node = await writeStampedNode(deps.driver, {
      label: 'Turn',
      now,
      occurredAt: turn.occurredAt,
      properties: turnProperties(turn, episode.id, sessionId, requireVector(vectors, turn.sequence + 1)),
    });

    await linkStructural(deps.driver, CONTAINMENT_TYPE, node.id, episode.id, now);
    if (previousTurnId !== undefined) {
      await linkStructural(deps.driver, 'FOLLOWS', node.id, previousTurnId, now);
    }
    previousTurnId = node.id;
  }

  const jobId = enqueueReflectionJob(deps.db, INTEGRATE_JOB_TYPE, { episode_id: episode.id });
  deps.dispatch.signal({
    jobId,
    jobType: INTEGRATE_JOB_TYPE,
    episodeId: episode.id,
    sessionId,
    enqueuedAt: now,
  });

  deps.logger.info(
    {
      episodeId: episode.id,
      sessionId,
      jobId,
      turns: prepared.turnCount,
      toolExecutions: prepared.toolExecutionCount,
      observations: prepared.observationCount,
    },
    'reflection stored',
  );

  return { episode_id: episode.id, queued: true };
}
