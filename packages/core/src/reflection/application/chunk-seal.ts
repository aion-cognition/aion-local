import type { Driver } from 'neo4j-driver';

import { resolveChunkMemberAlone, resolveChunkMembers } from './chunk-evidence.js';
import { ensureSessionFamily } from './narrative-family.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import {
  ChunkSealRefused,
  heldSessionSources,
  readRemainderMembers,
  sealChunk,
  unorderedSessionSources,
  type RemainderMember,
} from '../../infrastructure/sqlite/chunk-manifest.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
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
import type { ChunkMemberEvidence } from '../domain/chunk-revision.js';

/**
 * The first half of the steady-state lifecycle: when a session's unsealed tail becomes a chunk.
 *
 * Nothing here holds a lock while it thinks. The evidence read that measures each member happens
 * outside every transaction, and the seal itself is one short immediate write of a membership the
 * decision already fixed.
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

/** The live tail and a frozen migration use the same source adapter and rendered-input admission. */
export async function measureChunkCandidates(
  deps: ChunkNarrativeDeps,
  remainder: readonly RemainderMember[],
  context: CheckedReadContext,
  policy: ChunkBoundaryPolicy,
): Promise<
  | { readonly status: 'measured'; readonly candidates: readonly ChunkCandidate[] }
  | { readonly status: 'refused'; readonly reason: string }
> {
  const resolved = await resolveChunkMembers(
    deps.resolver,
    deps.db,
    remainder.map((row) => row.sourceId),
    context,
  );
  const candidates: ChunkCandidate[] = [];
  for (const [index, row] of remainder.entries()) {
    const member = resolved.readings[index];
    if (member === undefined) {
      return { status: 'refused', reason: `${row.sourceId} has no evidence result` };
    }
    const { text, ...admission } = await admissionOf(deps, member, context, policy);
    candidates.push({
      sourceId: row.sourceId,
      captureOrderValue: row.captureOrderValue,
      occurredAt: new Date(row.occurredAt),
      arrivalAt: new Date(row.createdAt),
      admission,
      ...(text === undefined ? {} : { text }),
    });
  }
  return { status: 'measured', candidates };
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
  const family = await ensureSessionFamily(deps, sessionId);
  if (family.status !== 'ready') {
    return { held, status: 'refused', reason: family.reason };
  }
  const measured = await measureChunkCandidates(deps, remainder, coverage.context, policy);
  if (measured.status !== 'measured') {
    return { held, ...measured };
  }

  const decision = decideChunkSeal({
    remainder: measured.candidates,
    now: options.now,
    sessionClosing: options.sessionClosing ?? false,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  if (decision.action === 'wait') {
    return { held, status: 'waiting', reason: decision.reason };
  }
  const members = decision.members.map((member) => member.sourceId);
  // The facts this decision was taken on, restated for the freeze to re-read. The reads above
  // happened across an await, and a verification withdrawn in that interval would otherwise be
  // frozen into a membership the records no longer stand behind.
  const expected = decision.members.map((member) => ({
    sourceId: member.sourceId,
    captureOrderValue: member.captureOrderValue,
  }));
  let sealed;
  try {
    sealed = sealChunk(deps.db, {
      sessionId,
      sourceIds: members,
      sealedAt: options.now,
      expected,
    });
  } catch (err) {
    if (err instanceof ChunkSealRefused) {
      deps.logger.warn({ sessionId, sourceId: err.sourceId }, 'chunk seal refused at the freeze');
      return { held, status: 'refused', reason: err.message };
    }
    throw err;
  }
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
