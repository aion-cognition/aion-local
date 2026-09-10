import type { Driver } from 'neo4j-driver';

import {
  ChunkDependencySet,
  resolveChunkMemberAlone,
  resolveChunkMembers,
  type ResolvedMembers,
} from './chunk-evidence.js';
import { synthesizeChunk, type ChunkSynthesis } from './chunk-synthesis.js';
import { chunkTransitionEvidence } from './chunk-transition.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type {
  EvidenceDependency,
  EvidenceRevision,
} from '../../infrastructure/publication/preconditions.js';
import {
  listChunkMembers,
  readChunk,
  heldSessionSources,
  readRemainderMembers,
  sealChunk,
  unorderedSessionSources,
} from '../../infrastructure/sqlite/chunk-manifest.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  abandonNarrativeRevision,
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
  readPublishedRevision,
  recordRevisionAttemptFailure,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  checkPresentCoverage,
  type CheckedReadContext,
} from '../../recall/application/coverage-checker.js';
import {
  CHUNK_BOUNDARY_POLICY,
  decideChunkSeal,
  type ChunkBoundaryPolicy,
  type ChunkCandidate,
} from '../domain/chunk-boundary.js';
import { chunkMemberUnits, type ChunkMemberText } from '../domain/chunk-render.js';
import {
  decideChunkRevision,
  planChunkInput,
  type ChunkMemberEvidence,
} from '../domain/chunk-revision.js';

/**
 * The steady-state chunk lifecycle: seal a session's tail, then write one revision of what sealed.
 *
 * Nothing here holds a lock while it thinks. The evidence read, the plan and the model call all
 * happen outside every transaction, and what they produce is handed to the coordinator with the
 * dependency set it was produced under. The coordinator decides whether that reading still stands.
 */

export type ChunkNarrativeDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly resolver: EvidenceResolver;
  readonly publications: PublicationCoordinator;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
};

export type ChunkSealOptions = {
  readonly now: Date;
  /** The session is ending, so its tail seals whatever size it reached. */
  readonly sessionClosing?: boolean;
  readonly policy?: ChunkBoundaryPolicy;
};

export type ChunkSealReport = {
  /**
   * Unsealed sources this session holds outside live membership: an unproved identity, or a
   * position the migration pinned. They never seal here and they never stop the tail beside them;
   * the count travels so a caller can tell an empty session from one nobody can take.
   */
  readonly held: number;
} & (
  | { readonly status: 'sealed'; readonly chunkId: string; readonly members: readonly string[] }
  | { readonly status: 'waiting'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string }
);

/** Which class this member's own allowance puts it in, once the batch has been read. */
async function admissionOf(
  deps: ChunkNarrativeDeps,
  member: ChunkMemberEvidence,
  context: CheckedReadContext,
  policy: ChunkBoundaryPolicy,
): Promise<ChunkCandidate['admission'] & { readonly text?: ChunkMemberText }> {
  const settled =
    member.reading === 'over_budget'
      ? ((await resolveChunkMemberAlone(deps.resolver, deps.db, member.sourceId, context))
          .readings[0] ?? member)
      : member;
  if (settled.reading === 'suppressed') {
    return { status: 'suppressed' };
  }
  if (settled.reading === 'over_budget') {
    return { status: 'isolated', reason: 'member_over_resolver_budget' };
  }
  if (settled.reading !== 'complete' || settled.text === undefined) {
    return { status: 'isolated', reason: 'member_evidence_unreadable' };
  }
  return chunkMemberUnits(0, settled.text) > policy.renderedInputAllowance
    ? { status: 'isolated', reason: 'oversized_member', text: settled.text }
    : { status: 'renderable', text: settled.text };
}

/**
 * Seals the next chunk of a session's tail, or says why it is not time.
 *
 * The remainder is read one page longer than the member bound, which is all the decision can use:
 * every trigger it evaluates is decided inside that page, and the members past it are the next
 * chunk's by construction.
 */
export async function sealSessionChunk(
  deps: ChunkNarrativeDeps,
  sessionId: string,
  options: ChunkSealOptions,
): Promise<ChunkSealReport> {
  const policy = options.policy ?? CHUNK_BOUNDARY_POLICY;
  const held = heldSessionSources(deps.db, sessionId).length;
  const unordered = unorderedSessionSources(deps.db, sessionId);
  if (unordered.length > 0) {
    // An ELIGIBLE source with no capture position cannot be ordered into a chunk, and sealing
    // around it would leave it permanently unsealed and unnarrated without saying so. A held
    // source is a different population and refuses nothing: it is waiting for its own migration.
    return {
      held,
      status: 'refused',
      reason: `${String(unordered.length)} eligible sources carry no capture position`,
    };
  }
  const remainder = readRemainderMembers(deps.db, sessionId, policy.maxMembers + 1);
  if (remainder.length === 0) {
    return { held, status: 'waiting', reason: 'the session has no unsealed members' };
  }
  const coverage = checkPresentCoverage(deps.db, options.now);
  if (coverage.status !== 'checked') {
    return { held, status: 'refused', reason: `coverage ${coverage.refusal.reason}` };
  }
  const resolved = await resolveChunkMembers(
    deps.resolver,
    deps.db,
    remainder.map((row) => row.sourceId),
    coverage.context,
  );
  const candidates: ChunkCandidate[] = [];
  for (const [index, row] of remainder.entries()) {
    const member = resolved.readings[index];
    if (member === undefined) {
      return { held, status: 'refused', reason: `${row.sourceId} has no evidence result` };
    }
    const { text, ...admission } = await admissionOf(deps, member, coverage.context, policy);
    candidates.push({
      sourceId: row.sourceId,
      captureOrderValue: row.captureOrderValue,
      occurredAt: new Date(row.occurredAt),
      admission,
      ...(text === undefined ? {} : { text }),
    });
  }

  const decision = decideChunkSeal({
    remainder: candidates,
    now: options.now,
    sessionClosing: options.sessionClosing ?? false,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  if (decision.action === 'wait') {
    return { held, status: 'waiting', reason: decision.reason };
  }
  const members = decision.members.map((member) => member.sourceId);
  const sealed = sealChunk(deps.db, { sessionId, sourceIds: members, sealedAt: options.now });
  deps.logger.info(
    {
      sessionId,
      chunkId: sealed.chunkId,
      members: members.length,
      held,
      trigger: decision.trigger,
    },
    'chunk sealed',
  );
  return { held, status: 'sealed', chunkId: sealed.chunkId, members };
}

export type ChunkPublishOptions = {
  readonly now: Date;
  readonly policy?: ChunkBoundaryPolicy;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxSentences?: number;
  readonly signal?: AbortSignal;
};

export type ChunkPublishReport =
  | {
      readonly status: 'published';
      readonly chunkId: string;
      readonly revisionNo: number;
      readonly nodeId: string;
      readonly gaps: number;
    }
  | {
      readonly status: 'blocked' | 'deferred' | 'failed';
      readonly chunkId: string;
      readonly revisionNo: number;
      readonly reason: string;
    }
  | { readonly status: 'skipped'; readonly chunkId: string; readonly reason: string };

function storedRevision(json: string | null): EvidenceRevision | undefined {
  if (json === null) {
    return undefined;
  }
  try {
    return JSON.parse(json) as EvidenceRevision;
  } catch {
    return undefined;
  }
}

/** World time for the revision: the end of the span it covers, else the run's own clock. */
function spanOf(members: readonly ChunkMemberText[], now: Date): { start?: Date; end?: Date } {
  const stamps = members
    .map((member) => member.occurredAt)
    .filter((stamp): stamp is Date => stamp !== undefined)
    .sort((left, right) => left.getTime() - right.getTime());
  const start = stamps[0];
  const end = stamps[stamps.length - 1];
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? { end: now } : { end }),
  };
}

/**
 * One revision attempt for one sealed chunk.
 *
 * Allocation first, because a number that was handed out is spent whether or not the attempt
 * survives; then the read, the plan, and the model call, none of them holding anything. A block
 * takes the revision out of nomination with its reason rather than retrying on a timer: what
 * clears it is a changed prerequisite, and the passage of time is not one.
 */
export async function publishChunkNarrative(
  deps: ChunkNarrativeDeps,
  chunkId: string,
  options: ChunkPublishOptions,
): Promise<ChunkPublishReport> {
  const chunk = readChunk(deps.db, chunkId);
  if (chunk === undefined) {
    return { status: 'skipped', chunkId, reason: 'no such sealed chunk' };
  }
  const head = readPublishedRevision(deps.db, CHUNK_REVISION_FAMILY, chunkId);
  const stored = head === undefined ? undefined : storedRevision(head.evidenceRevisionJson);
  const decision = decideChunkRevision(
    head === undefined ? undefined : { revisionNo: head.revisionNo, nodeId: head.nodeId },
    stored === undefined ? undefined : verifyEvidenceRevision(deps.db, stored),
  );
  if (decision.action === 'skip') {
    return { status: 'skipped', chunkId, reason: decision.reason };
  }

  const coverage = checkPresentCoverage(deps.db, options.now);
  if (coverage.status !== 'checked') {
    return {
      status: 'failed',
      chunkId,
      revisionNo: 0,
      reason: `coverage ${coverage.refusal.reason}`,
    };
  }
  const allocation = allocateNarrativeRevision(
    deps.db,
    CHUNK_REVISION_FAMILY,
    chunkId,
    options.now,
  );
  const frozen = listChunkMembers(deps.db, chunkId);
  const residency = frozen.map((sourceId) => {
    const row = readSourceResidency(deps.db, sourceId);
    return {
      sourceId,
      residency: row?.state ?? ('resident' as const),
      projectionGeneration: row?.projectionGeneration ?? 0,
    };
  });

  const members = await settledMembers(deps, frozen, coverage.context);
  const transition = await chunkTransitionEvidence(
    deps,
    decision.changed,
    frozen,
    coverage.context,
  );
  const dependencies: EvidenceDependency[] = [...members.dependencies, ...transition.dependencies];

  const policy = options.policy ?? CHUNK_BOUNDARY_POLICY;
  const oversized = oversizedMemberOf(members, policy);
  const plan = planChunkInput({
    members: members.readings,
    transition: transition.readings,
    // Sealing never consults these: what may still be said about a member is not a membership
    // question. Publishing does, because the revision is what would rest on the reading.
    unprovedScopes: members.unprovedScopes,
    allowance: policy.renderedInputAllowance,
    ...(oversized === undefined ? {} : { oversizedMember: oversized }),
  });
  if (plan.status === 'block') {
    blockRevisionAttempt(
      deps.db,
      CHUNK_REVISION_FAMILY,
      chunkId,
      allocation.revisionNo,
      plan.reason,
    );
    deps.logger.warn(
      { chunkId, reason: plan.reason, detail: plan.detail },
      'chunk revision blocked',
    );
    return {
      status: 'blocked',
      chunkId,
      revisionNo: allocation.revisionNo,
      reason: plan.reason,
    };
  }

  let synthesis: ChunkSynthesis;
  try {
    synthesis = await synthesizeChunk(deps, {
      sessionId: chunk.sessionId,
      plan,
      allowance: policy.renderedInputAllowance,
      now: options.now,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxSentences === undefined ? {} : { maxSentences: options.maxSentences }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (err) {
    recordRevisionAttemptFailure(deps.db, CHUNK_REVISION_FAMILY, {
      familyKey: chunkId,
      revisionNo: allocation.revisionNo,
      reason: 'synthesis_failed',
    });
    deps.logger.warn({ err, chunkId }, 'chunk narrative synthesis failed');
    return {
      status: 'failed',
      chunkId,
      revisionNo: allocation.revisionNo,
      reason: 'synthesis_failed',
    };
  }
  if (synthesis.output.kept === 0) {
    recordRevisionAttemptFailure(deps.db, CHUNK_REVISION_FAMILY, {
      familyKey: chunkId,
      revisionNo: allocation.revisionNo,
      reason: 'no_grounded_sentence',
    });
    return {
      status: 'failed',
      chunkId,
      revisionNo: allocation.revisionNo,
      reason: 'no_grounded_sentence',
    };
  }

  const span = spanOf(plan.members, options.now);
  const outcome = await deps.publications.publish({
    kind: 'narrative_publish',
    operationId: `narrative-publish:${chunkId}:${String(allocation.revisionNo)}`,
    payload: {
      chunkId,
      sessionId: chunk.sessionId,
      revisionNo: allocation.revisionNo,
      nodeId: allocation.nodeId,
      summary: synthesis.output.summary,
      narrative: synthesis.output.narrative,
      citations: synthesis.citations,
      sentenceCount: synthesis.output.kept,
      coverage: synthesis.render.source.coverage,
      ...(span.start === undefined ? {} : { spanStart: span.start.toISOString() }),
      ...(span.end === undefined ? {} : { spanEnd: span.end.toISOString() }),
      occurredAt: (span.end ?? options.now).toISOString(),
      members: residency,
      coverageGaps: synthesis.gaps,
      dependencies,
      // The epoch the evidence was read under, carried rather than re-read: an activation during
      // the model call has to refuse this output, not relabel it.
      coverageEpoch: coverage.context.coverageEpoch,
      expectedHead: head?.revisionNo ?? null,
    },
  });

  if (outcome.status !== 'acknowledged') {
    // The allocation is spent and the decision is requeued: what published is what stands, and
    // the next attempt reads the substrate again rather than re-blessing this output.
    abandonNarrativeRevision(
      deps.db,
      CHUNK_REVISION_FAMILY,
      chunkId,
      allocation.revisionNo,
      options.now,
    );
    return {
      status: 'deferred',
      chunkId,
      revisionNo: allocation.revisionNo,
      reason: outcome.reason,
    };
  }

  deps.logger.info(
    {
      chunkId,
      revisionNo: allocation.revisionNo,
      nodeId: allocation.nodeId,
      sentences: synthesis.output.kept,
      gaps: synthesis.gaps.length,
    },
    'chunk narrative published',
  );
  return {
    status: 'published',
    chunkId,
    revisionNo: allocation.revisionNo,
    nodeId: allocation.nodeId,
    gaps: synthesis.gaps.length,
  };
}

/**
 * The frozen membership's evidence, with every bound answer re-asked in an allowance of its own.
 *
 * A batch that ran out of room reports the bound for every address it could not reach, and taking
 * that at face value would block a chunk over a shortage that belonged to the request rather than
 * to any member. Only a source that still hits the bound alone is over it.
 */
async function settledMembers(
  deps: ChunkNarrativeDeps,
  frozen: readonly string[],
  context: CheckedReadContext,
): Promise<ResolvedMembers> {
  const batch = await resolveChunkMembers(deps.resolver, deps.db, frozen, context);
  const dependencies = new ChunkDependencySet();
  dependencies.addAll(batch.dependencies);
  const unprovedScopes = [...batch.unprovedScopes];
  const readings: ChunkMemberEvidence[] = [];
  for (const member of batch.readings) {
    if (member.reading !== 'over_budget') {
      readings.push(member);
      continue;
    }
    const again = await resolveChunkMemberAlone(deps.resolver, deps.db, member.sourceId, context);
    // The reread's OWN dependency set, folded in: an address the batch never reached acquires its
    // source, part and negative-scope tokens here and nowhere else.
    dependencies.addAll(again.dependencies);
    unprovedScopes.push(...again.unprovedScopes);
    readings.push(again.readings[0] ?? { sourceId: member.sourceId, reading: 'unreadable' });
  }
  return {
    // Two readings of one scope that disagree are two moments, not a set: the member they name is
    // a reading that did not settle rather than a token to choose between.
    readings: readings.map((member) =>
      dependencies.conflicted(member.sourceId)
        ? { sourceId: member.sourceId, reading: 'unreadable' as const }
        : member,
    ),
    dependencies: dependencies.list(),
    unprovedScopes,
  };
}

/**
 * The single member this chunk sealed around whose full text the allowance cannot carry.
 *
 * A chunk with more than one member never has one: the seal admits members only while the running
 * render fits, so an oversized member reaches publication alone or not at all.
 */
function oversizedMemberOf(
  members: ResolvedMembers,
  policy: ChunkBoundaryPolicy,
): string | undefined {
  if (members.readings.length !== 1) {
    return undefined;
  }
  const only = members.readings[0];
  if (only?.reading !== 'complete' || only.text === undefined) {
    return undefined;
  }
  return chunkMemberUnits(0, only.text) > policy.renderedInputAllowance ? only.sourceId : undefined;
}
