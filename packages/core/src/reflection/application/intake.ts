import { ReflectionInputSchema, type ReflectionOutput } from '@aion/protocol';

import { ReflectionNotStoredError, ReflectionPreBirthRefusedError } from './errors.js';
import type { ExperienceStoreDeps } from './experience-store.js';
import {
  intakeOperationId,
  publishIntake,
  type AcceptedSource,
  type IntakePublisher,
} from './intake-transport.js';
import type { LaneAssigner, LaneDecision } from './lanes.js';
import { recordRecallFeedback, redactFeedback } from './recall-feedback.js';
import { redactProvenance } from './stated-references.js';
import { isGraphUnavailable } from '../../infrastructure/graph/errors.js';
import { readPublicationGuardBirth } from '../../infrastructure/graph/publication-guard.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  experienceArchiveKey,
} from '../../infrastructure/sqlite/experience-archive.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { readCurrentReadinessPolicy } from '../../infrastructure/sqlite/readiness-policies.js';
import { countQueueJobs } from '../../infrastructure/sqlite/reflection-queue-admin.js';
import {
  DEFAULT_REFLECTION_LANE,
  findPendingJobForEpisode,
  type ReflectionLane,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { resolveSourceOccurrence } from '../../infrastructure/sqlite/source-occurrence.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import { applyBirthFence, type BirthFenceOutcome } from '../domain/birth-fence.js';
import { prepareEpisode } from '../domain/content.js';

/** The one job intake enqueues. The reflection pipeline's stages fan out from it; intake never runs them. */
export const INTEGRATE_JOB_TYPE = 'integrate';

export type ReflectionIntakeDeps = ExperienceStoreDeps & {
  readonly db: SqliteHandle;
  /**
   * The one path an accepted payload reaches either store by. Every write an acceptance makes
   * happens inside the operation this publishes, so there is no second, unfenced way in.
   */
  readonly publications: IntakePublisher;
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
 * Claimable interactive-lane enrichments already in the queue, measured before this call's own
 * job lands. Interactive is served strictly first (the lanes pin), so this is exactly how many
 * enrichments sit ahead of a fresh interactive enqueue and, for a caller demoted to bulk, how
 * many it queues behind either way.
 *
 * Integrate rows only. The vector row an acceptance also writes rides the same lane and is one
 * embed call, so adding it would double the figure without telling the caller anything about
 * when their experience is enriched.
 *
 * Bounded by the attempt limit, so a row the claim path will never take again is not reported
 * as something to wait for: one exhausted job once made every ack say "1 job ahead" against an
 * empty queue.
 */
function pendingAhead(db: SqliteHandle, maxAttempts: number): number {
  return countQueueJobs(
    db,
    { lane: DEFAULT_REFLECTION_LANE, jobType: INTEGRATE_JOB_TYPE },
    maxAttempts,
  ).pending;
}

/**
 * The queue row the acknowledgment wrote, read back so the caller can be told which lane its
 * work landed in and woken through the listener it registered.
 *
 * Read rather than assumed: the acknowledgment writes the row only where the acceptance owed
 * one, so a duplicate push finds whichever row the original acceptance left, and an acceptance
 * whose work a worker has already claimed finds none.
 */
function queuedJob(
  deps: ReflectionIntakeDeps,
  accepted: AcceptedSource,
  decision: LaneDecision,
): IntegrateJob {
  const pending = findPendingJobForEpisode(deps.db, INTEGRATE_JOB_TYPE, accepted.sourceId);
  if (pending === undefined) {
    return { jobId: '', enqueued: false, lane: decision.lane, decision, countedInDepth: false };
  }
  return {
    jobId: pending.id,
    enqueued: accepted.created,
    lane: pending.lane,
    decision,
    countedInDepth:
      !accepted.created &&
      pending.lane === DEFAULT_REFLECTION_LANE &&
      pending.claimedAt === null &&
      pending.attempts < deps.workerMaxAttempts,
  };
}

/**
 * The substrate's own birth: the instant its `PublicationGuard` node was minted. Undefined on
 * a substrate with no recorded pairing yet, and on one whose guard read comes back empty for
 * the same reason; the birth fence reads either as "nothing to judge against" rather than
 * "born now".
 *
 * Translates a graph outage the same way `resolveSession` does: this read reaches the graph
 * before that one does, so an unavailable graph has to fail the same way here as it always
 * has, rather than surfacing as a driver error nothing downstream recognises.
 */
async function substrateBirth(deps: ReflectionIntakeDeps): Promise<Date | undefined> {
  const pairing = readSubstratePairing(deps.db);
  if (pairing === undefined) {
    return undefined;
  }
  try {
    return await readPublicationGuardBirth(deps.driver, pairing.substrateId);
  } catch (err) {
    if (isGraphUnavailable(err)) {
      throw new ReflectionNotStoredError('graph', err);
    }
    throw err;
  }
}

/** Present only once a push actually loses turns or tool executions to the birth fence. */
function preBirthTrimDisclosure(
  fenced: BirthFenceOutcome,
): Pick<ReflectionOutput, 'pre_birth_trim'> {
  if (fenced.trimmedTurns === 0 && fenced.trimmedToolExecutions === 0) {
    return {};
  }
  return {
    pre_birth_trim: { turns: fenced.trimmedTurns, tool_executions: fenced.trimmedToolExecutions },
  };
}

/**
 * The write path. Validate, redact, resolve the session, and publish the acceptance.
 *
 * Everything durable an acceptance makes happens inside that publication: which source this
 * payload is, its archive row and identity records, its graph projection, the references it
 * carried, and the queue rows that make its work claimable. This function decides none of it and
 * writes to neither store. What is left here is the caller's half: the redaction that has to
 * happen before any content field is read, the lane the arrival rate assigns, and the embedding
 * that follows a durable acceptance.
 *
 * Redaction runs on the parsed payload before anything reads a content field, so no raw
 * credential reaches the hash, the embedder, the graph, or the archive: what the archive holds
 * is what the substrate holds.
 *
 * Nothing here embeds. The acceptance enqueues the source's vector work beside its integrate
 * row, so the call returns as soon as the experience is durable rather than holding the caller
 * through a round trip to the embedding service. Until that row runs, the episode is reachable
 * by BM25, entity resolution, recency and traversal, and recall labels what it serves.
 *
 * No generation call happens anywhere here either. Extraction is the pipeline's job, and intake
 * is what makes the experience durable.
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
  // `provenance` joins them: it is a statement about other nodes rather than about what
  // happened here, so folding it into the content hash would make the same experience pushed
  // with and without its references two separate episodes. `feedback` is carved out for the
  // same reason: it says what became of memories already stored, not what happened.
  const {
    session_id: suppliedIdentity,
    lane: requestedLane,
    origin,
    provenance,
    feedback,
    ...content
  } = payload;
  const redacted = redactPayload(content, deps.entropyThreshold);
  if (redacted.matches.length > 0) {
    deps.logger.warn(
      { matches: redacted.matches, count: redacted.matches.length },
      'redacted secrets from reflection payload',
    );
  }

  const birth = await substrateBirth(deps);
  const fenced = applyBirthFence(redacted.value, birth);
  if (fenced.emptied) {
    // `emptied` only turns true inside the branch of `applyBirthFence` that already received a
    // defined `birth`, so this is redundant in fact and here only to narrow the type below.
    if (birth !== undefined) {
      deps.logger.info(
        {
          turns: fenced.trimmedTurns,
          toolExecutions: fenced.trimmedToolExecutions,
          substrateBornAt: birth.toISOString(),
        },
        'reflection payload predates the substrate entirely; refused',
      );
      throw new ReflectionPreBirthRefusedError({
        substrateBornAt: birth,
        refusedTurns: fenced.trimmedTurns,
        refusedToolExecutions: fenced.trimmedToolExecutions,
      });
    }
  }
  if (fenced.trimmedTurns > 0 || fenced.trimmedToolExecutions > 0) {
    deps.logger.warn(
      {
        turns: fenced.trimmedTurns,
        toolExecutions: fenced.trimmedToolExecutions,
        substrateBornAt: birth?.toISOString(),
      },
      "reflection payload trimmed to the substrate's birth",
    );
  }

  const statedReferences = redactProvenance(deps, provenance, deps.entropyThreshold);
  const identity = suppliedIdentity ?? options.identity;
  const prepared = prepareEpisode(fenced.content, now);
  const sessionId = await resolveSession(deps, identity, prepared.occurredAt, now);
  // The arrival backstop is the caller's own reading and cannot be taken inside the operation,
  // which is serialized: by the time the guard is held the rate this measures has moved on. A
  // payload the records already hold is a client retrying rather than an arrival, so it does not
  // move the rate. That lookup decides scheduling only; which source this is stays the guarded
  // decision inside the operation, and a stale answer here costs at most a lane.
  const decision = alreadyHeld(deps, identity, prepared.contentHash, sessionId)
    ? {
        lane: requestedLane ?? DEFAULT_REFLECTION_LANE,
        reason: 'requested' as const,
        sessionArrivals: 0,
        globalArrivals: 0,
      }
    : deps.lanes.assign({ sessionId, requested: requestedLane, now });
  // Measured before this call's own row lands, so a fresh enqueue is not counted against
  // itself. A duplicate push matched a row that is already inside this figure, and that row is
  // the caller's own, so it comes back out below.
  const depth = pendingAhead(deps.db, deps.workerMaxAttempts);

  const accepted = await publishIntake(
    deps.publications,
    {
      identity,
      sessionId,
      prepared,
      // The content alone, after the birth fence: the acceptance re-derives its own `prepared`
      // from this same value (see `intake-publication.ts`), so a pre-birth turn trimmed here
      // and not from this field would still reach the graph through that path. What the
      // caller stated about other memories travels beside it as its own accepted batch, and
      // folding it in here would put it in the identity hash the acceptance recomputes: the
      // same experience pushed with and without its references would then be two occurrences.
      payload: fenced.content,
      references: statedReferences,
      origin,
      lane: decision.lane,
      occurredAt: now,
      readiness: readCurrentReadinessPolicy(deps.db),
    },
    intakeOperationId(),
  );

  // Recorded against the session the call resolved to, and not archived: these rows live in the
  // same local database the archive does, so a replay that rebuilds the graph finds them already
  // there rather than re-stating them.
  recordRecallFeedback(deps, {
    feedback: redactFeedback(deps, feedback, deps.entropyThreshold),
    sessionId,
    episodeId: accepted.sourceId,
    now,
  });

  const job = queuedJob(deps, accepted, decision);
  const ahead = job.countedInDepth ? depth - 1 : depth;
  if (job.enqueued && job.jobId !== '') {
    notifyEnqueued(deps, job.jobId);
  }
  if (job.lane !== DEFAULT_REFLECTION_LANE) {
    const laneFields = {
      episodeId: accepted.sourceId,
      sessionId,
      reason: decision.reason,
      sessionArrivals: decision.sessionArrivals,
      globalArrivals: decision.globalArrivals,
    };
    // A client that asked for the bulk lane got what it asked for, which is not a problem an
    // operator has to look at. Only the arrival-rate backstop is a demotion, so only it warns.
    if (decision.reason === 'requested') {
      deps.logger.info(laneFields, 'reflection queued in the bulk lane');
    } else {
      deps.logger.warn(laneFields, 'reflection queued in the bulk lane');
    }
  }

  if (!accepted.created) {
    // Info, not debug: a caller re-pushing an experience the substrate already holds is what
    // an operator reads to tell a retry storm from real traffic, and it is invisible at the
    // level production runs. One line per duplicate push bounds the volume by the client.
    deps.logger.info(
      { episodeId: accepted.sourceId, sessionId, lane: job.lane },
      'reflection payload already stored',
    );
    return {
      episode_id: accepted.sourceId,
      queued: true,
      lane: job.lane,
      pending_ahead: ahead,
      ...preBirthTrimDisclosure(fenced),
    };
  }

  deps.logger.info(
    {
      episodeId: accepted.sourceId,
      sessionId,
      jobId: job.jobId,
      lane: job.lane,
      turns: prepared.turnCount,
      toolExecutions: prepared.toolExecutionCount,
      observations: prepared.observationCount,
    },
    'reflection stored',
  );

  return {
    episode_id: accepted.sourceId,
    queued: true,
    lane: job.lane,
    pending_ahead: ahead,
    ...preBirthTrimDisclosure(fenced),
  };
}

/**
 * Whether this exact payload already has an occurrence in this session.
 *
 * A scheduling read and nothing more. The acceptance decides which source the payload is under
 * the guard, and this answer changing between here and there costs the caller a lane rather than
 * an identity.
 */
function alreadyHeld(
  deps: ReflectionIntakeDeps,
  identity: string,
  contentHash: string,
  sessionId: string,
): boolean {
  const identityHash = experienceArchiveKey(identity, contentHash, ARCHIVE_SCHEMA_VERSION);
  return resolveSourceOccurrence(deps.db, { identityHash, sessionId }).kind === 'held';
}

/**
 * The session the call belongs to, ensured before the acceptance names it.
 *
 * It is a backbone write rather than a memory: the acceptance links its projection to a Session
 * that has to exist first, and a graph that cannot answer leaves the caller with nothing written
 * and nothing queued, which is what the error says.
 */
async function resolveSession(
  deps: ReflectionIntakeDeps,
  identity: string,
  occurredAt: Date,
  now: Date,
): Promise<string> {
  try {
    const { sessionId } = await deps.sessions.ensureSession({ identity, now, occurredAt });
    return sessionId;
  } catch (err) {
    if (isGraphUnavailable(err)) {
      throw new ReflectionNotStoredError('graph', err);
    }
    throw err;
  }
}
