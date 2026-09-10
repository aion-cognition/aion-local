import { resolveChunkEnrichment } from './chunk-enrichment.js';
import {
  ChunkDependencySet,
  resolveChunkMemberAlone,
  resolveChunkMembers,
  type ResolvedMembers,
} from './chunk-evidence.js';
import {
  sealSessionChunk,
  type ChunkNarrativeDeps,
  type ChunkSealOptions,
  type ChunkSealReport,
} from './chunk-seal.js';
import { ChunkInputRefused, synthesizeChunk, type ChunkSynthesis } from './chunk-synthesis.js';
import { chunkTransitionEvidence } from './chunk-transition.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import type {
  EvidenceDependency,
  EvidenceRevision,
} from '../../infrastructure/publication/preconditions.js';
import { listChunkMembers, readChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import {
  claimNarrativeRevision,
  recordAttemptPolicy,
  releaseNarrativeClaim,
} from '../../infrastructure/sqlite/narrative-allocations.js';
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
import { CHUNK_BOUNDARY_POLICY, type ChunkBoundaryPolicy } from '../domain/chunk-boundary.js';
import { chunkMemberUnits, type ChunkMemberText } from '../domain/chunk-render.js';
import {
  decideChunkRevision,
  planChunkInput,
  type ChunkMemberEvidence,
} from '../domain/chunk-revision.js';

/**
 * The second half of the steady-state lifecycle: writing one revision of a sealed chunk.
 *
 * The seal beside it is `chunk-seal.ts`, re-exported here so the lifecycle has one import path.
 * Nothing here holds a lock while it thinks: the evidence read, the plan and the model call all
 * happen outside every transaction, and what they produce is handed to the coordinator with the
 * dependency set it was produced under. The coordinator decides whether that reading still stands.
 */

export { sealSessionChunk };
export type { ChunkNarrativeDeps, ChunkSealOptions, ChunkSealReport };

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

/**
 * The operation identity a chunk revision publishes under, without its number.
 *
 * Derived from the chunk rather than minted, so whether an allocation carries a durable intent is
 * a question the records answer exactly: the id is the same one any earlier attempt on that
 * number would have used, and one number is one identity.
 */
function operationPrefix(chunkId: string): string {
  return `narrative-publish:${chunkId}:`;
}

function publicationOperationId(chunkId: string, revisionNo: number): string {
  return `${operationPrefix(chunkId)}${String(revisionNo)}`;
}

/**
 * How long a claim holds its number without publishing.
 *
 * The model call is the long part and it is already bounded, so the lease is that bound plus room
 * for the reads and the guard around it. Too short and a live attempt loses its number; too long
 * and a dead one strands it until the lease expires. Neither is a correctness question — the
 * durable-intent test decides that — so the number is a scheduling choice, stated here.
 */
const CLAIM_MARGIN_MS = 60_000;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120_000;

/**
 * Gives a claimed number back after an attempt that opened no intent.
 *
 * The failure is already counted on the row; what the release adds is that the NEXT attempt takes
 * this number up rather than spending another beside it. A number an operation is holding is not
 * released here — the coordinator's own recovery settles that one.
 *
 * A block releases too. The block itself is what keeps the row out of nomination, and it clears on
 * its prerequisite; leaving a lease on top of it would hold the number past the moment the work
 * became runnable again.
 */
function releaseClaim(deps: ChunkNarrativeDeps, chunkId: string, revisionNo: number): void {
  releaseNarrativeClaim(deps.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo,
    operationId: publicationOperationId(chunkId, revisionNo),
  });
}

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
  // Ownership before any asynchronous work, written rather than inferred: two callers reading
  // the same absence of a publication record both proceeded under one number, and their two valid
  // outputs then collided on one operation identity.
  const allocation = claimNarrativeRevision(deps.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    operationPrefix: operationPrefix(chunkId),
    now: options.now,
    leaseUntil: new Date(
      options.now.getTime() + (options.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS) + CLAIM_MARGIN_MS,
    ),
  });
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
  // Optional context, resolved over the submitted membership and fenced before the bound is
  // applied. What cannot be certified is omitted rather than submitted, which is the one licence
  // being optional actually buys.
  const enrichment = await resolveChunkEnrichment(deps, frozen, options.now);
  const dependencies: EvidenceDependency[] = [
    ...members.dependencies,
    ...transition.dependencies,
    ...enrichment.dependencies,
  ];

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
    recordAttemptPolicy(deps.db, CHUNK_REVISION_FAMILY, chunkId, allocation.revisionNo, {
      renderedInputAllowance: policy.renderedInputAllowance,
      maxMembers: policy.maxMembers,
    });
    releaseClaim(deps, chunkId, allocation.revisionNo);
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
      enrichment: enrichment.nodes,
      allowance: policy.renderedInputAllowance,
      now: options.now,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxSentences === undefined ? {} : { maxSentences: options.maxSentences }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (err) {
    // A refused input is not a failed attempt. Nothing was asked of a model and nothing will be
    // until a prerequisite moves, so the revision is blocked with its reason rather than dated
    // forward to try the same refusal again.
    if (err instanceof ChunkInputRefused) {
      blockRevisionAttempt(
        deps.db,
        CHUNK_REVISION_FAMILY,
        chunkId,
        allocation.revisionNo,
        err.reason,
      );
      recordAttemptPolicy(deps.db, CHUNK_REVISION_FAMILY, chunkId, allocation.revisionNo, {
        renderedInputAllowance: policy.renderedInputAllowance,
        maxMembers: policy.maxMembers,
      });
      releaseClaim(deps, chunkId, allocation.revisionNo);
      deps.logger.warn({ chunkId, reason: err.reason }, 'chunk revision input refused');
      return { status: 'blocked', chunkId, revisionNo: allocation.revisionNo, reason: err.reason };
    }
    recordRevisionAttemptFailure(deps.db, CHUNK_REVISION_FAMILY, {
      familyKey: chunkId,
      revisionNo: allocation.revisionNo,
      reason: 'synthesis_failed',
    });
    releaseClaim(deps, chunkId, allocation.revisionNo);
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
    releaseClaim(deps, chunkId, allocation.revisionNo);
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
    operationId: publicationOperationId(chunkId, allocation.revisionNo),
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
    // The output is refused and its number is spent: this attempt bound an intent, so the number
    // can never be taken up again. What must not go with it is the work — a refusal that left no
    // durable row would take the chunk out of the scheduler's sight until something else moved.
    // So a fresh allocation carries the reason and the attempt count forward, due now, for the
    // scheduler that owns how long to wait.
    abandonNarrativeRevision(
      deps.db,
      CHUNK_REVISION_FAMILY,
      chunkId,
      allocation.revisionNo,
      options.now,
    );
    const next = allocateNarrativeRevision(deps.db, CHUNK_REVISION_FAMILY, chunkId, options.now);
    recordRevisionAttemptFailure(deps.db, CHUNK_REVISION_FAMILY, {
      familyKey: chunkId,
      revisionNo: next.revisionNo,
      reason: outcome.reason,
    });
    return { status: 'deferred', chunkId, revisionNo: next.revisionNo, reason: outcome.reason };
  }

  deps.logger.info(
    {
      chunkId,
      revisionNo: allocation.revisionNo,
      nodeId: allocation.nodeId,
      sentences: synthesis.output.kept,
      gaps: synthesis.gaps.length,
      enrichment: enrichment.nodes.length,
      uncertifiedEnrichment: enrichment.uncertified.length,
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
