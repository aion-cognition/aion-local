import type { ReflectionOrigin } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import { ReflectionNotStoredError } from './errors.js';
import { writeStampedNodeInTransaction } from '../../infrastructure/graph/bitemporal.js';
import {
  inWriteTransaction,
  type GraphTransaction,
} from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import {
  CONTAINMENT_TYPE,
  findEpisodeByContentHash,
  findEpisodeByContentHashInTransaction,
  MEMORY_PROPERTIES,
} from '../../infrastructure/graph/episodes.js';
import { isGraphUnavailable } from '../../infrastructure/graph/errors.js';
import { lockNodeInTransaction } from '../../infrastructure/graph/locks.js';
import type { PendingVectorNode } from '../../infrastructure/graph/pending-vectors.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { SessionManager } from '../../session/session-manager.js';
import type { PreparedEpisode, PreparedTurn } from '../domain/content.js';

/** Provenance: how the node got into the graph, as opposed to what extracted it later. */
export const INTAKE_EXTRACTION_METHOD = 'reflection_intake';

const STRUCTURAL_SIGNALS = ['structural'];
const STRUCTURAL_PROVENANCE = ['reflection_intake'];

export type ExperienceStoreDeps = {
  readonly driver: Driver;
  readonly sessions: SessionManager;
};

export type StoredEpisode = {
  readonly episodeId: string;
  readonly created: boolean;
  /** The nodes this call committed without a `content_vec`; empty for a duplicate. */
  readonly pending: readonly PendingVectorNode[];
};

export type DurableWrite = {
  readonly sessionId: string;
  readonly stored: StoredEpisode;
};

function episodeProperties(
  prepared: PreparedEpisode,
  sessionId: string,
  origin: ReflectionOrigin | undefined,
): GraphProperties {
  return {
    [MEMORY_PROPERTIES.text]: prepared.text,
    [MEMORY_PROPERTIES.summary]: prepared.summary,
    [MEMORY_PROPERTIES.contentHash]: prepared.contentHash,
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [MEMORY_PROPERTIES.extractionMethod]: INTAKE_EXTRACTION_METHOD,
    [MEMORY_PROPERTIES.turnCount]: prepared.turnCount,
    [MEMORY_PROPERTIES.toolExecutionCount]: prepared.toolExecutionCount,
    [MEMORY_PROPERTIES.observationCount]: prepared.observationCount,
    // Undefined when the caller named none: absent origin is an absent property, no sentinel.
    [MEMORY_PROPERTIES.originChannel]: origin?.channel,
    [MEMORY_PROPERTIES.originEvent]: origin?.event,
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
 * is not enough: two concurrent pushes of the same payload would each find no duplicate
 * and each store one. Locking the session serializes intake for that session, which is the
 * grain that matters: it is one agent conversation, and different sessions still run in
 * parallel.
 */
async function storeEpisode(
  driver: Driver,
  prepared: PreparedEpisode,
  sessionId: string,
  now: Date,
  origin: ReflectionOrigin | undefined,
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
      properties: episodeProperties(prepared, sessionId, origin),
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
  driver: Driver,
  prepared: PreparedEpisode,
  sessionId: string,
  now: Date,
  origin: ReflectionOrigin | undefined,
): Promise<StoredEpisode> {
  const known = await findEpisodeByContentHash(driver, {
    sessionId,
    contentHash: prepared.contentHash,
  });
  if (known !== undefined) {
    return { episodeId: known, created: false, pending: [] };
  }
  return storeEpisode(driver, prepared, sessionId, now, origin);
}

/**
 * Everything between a prepared payload and a committed episode: the session it belongs to,
 * the dedupe, and the write. It stands apart from intake because making an experience durable
 * and queueing work on it are separate jobs, and a caller can want the first without the
 * second.
 *
 * The whole region is wrapped because every failure inside it leaves the same state: nothing
 * written, nothing queued. That fact is what the caller has to act on, and a raw `Neo4jError`
 * does not carry it. A statement the graph itself rejected is a defect here, not an outage,
 * and passes through unchanged.
 *
 * Only the graph can put a caller in that state now. Inference happens after this region
 * commits, so an Ollama outage never reaches it.
 */
export async function storeExperience(
  deps: ExperienceStoreDeps,
  prepared: PreparedEpisode,
  identity: string,
  now: Date,
  origin: ReflectionOrigin | undefined,
): Promise<DurableWrite> {
  try {
    const { sessionId } = await deps.sessions.ensureSession({
      identity,
      now,
      occurredAt: prepared.occurredAt,
    });
    const stored = await resolveEpisode(deps.driver, prepared, sessionId, now, origin);
    return { sessionId, stored };
  } catch (err) {
    if (isGraphUnavailable(err)) {
      throw new ReflectionNotStoredError('graph', err);
    }
    throw err;
  }
}
