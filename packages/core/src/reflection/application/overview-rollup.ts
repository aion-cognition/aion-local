import type { Driver } from 'neo4j-driver';

import { synthesizeGrounded } from './consolidation-synthesis.js';
import {
  memberEvidence,
  overviewOperationPrefix,
  parseEvidence,
  OVERVIEW_NARRATIVE_FAMILY,
} from './overview-publication.js';
import {
  closedWindows,
  writeMemberCursor,
  OVERVIEW_MEMBER_SCAN_LIMIT,
  type Window,
} from './overview-windows.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { findNarrativeBodies } from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  claimNarrativeRevision,
  listAllocatedRevisions,
  readAttemptPolicy,
  recordAttemptPolicy,
  releaseNarrativeClaim,
} from '../../infrastructure/sqlite/narrative-allocations.js';
import { readCitationsFrom } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  blockRevisionAttempt,
  clearRevisionBlock,
  OVERVIEW_REVISION_FAMILY,
  readNarrativeRevision,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import {
  overviewFamilyKey,
  type OverviewMember,
} from '../../infrastructure/sqlite/overview-membership.js';
import { renderConsolidationSource, type ConsolidationMember } from '../domain/consolidation.js';
import type { RollupScope } from '../domain/rollup.js';

/**
 * The calendar overview pass, over the manifest rather than over the graph.
 *
 * A window is a set of published revisions the records name, decided by each member's span END, so
 * a chunk that crosses midnight belongs to exactly one window and cannot be split by the order its
 * members arrived in. What the pass then does with a window is one of four things, and the
 * difference between them is the point:
 *
 * - **Settled.** The standing head cites exactly the members the records name now. Nothing is
 *   asked of a model and nothing is written.
 * - **Refused.** The window's required input does not fit the allowance, or a member's prose
 *   cannot be read at all. The refusal is recorded on the attempt with the bounds it ran under, no
 *   provider is called, no overview is published, and the constituent revisions are untouched. It
 *   costs no expensive-attempt budget, so a refused prefix cannot hide the windows behind it.
 * - **Reconsidered.** A refusal is a standing decision only while what it refused about still
 *   holds: a bound it did not run under, or a member body it could not read that has come back,
 *   clears the block and the window is measured again.
 * - **Published.** One revision of the `scope:window` family, through the coordinator, citing its
 *   members and closing nothing but its own prior head.
 */

export type OverviewRollupDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly publications: PublicationCoordinator;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
};

export type OverviewRollupOptions = {
  readonly scope: RollupScope;
  readonly now: Date;
  /** Expensive attempts one run makes. A refusal is not one of them. */
  readonly windowLimit: number;
  readonly renderedInputAllowance: number;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxSentences?: number;
  readonly signal?: AbortSignal;
};

export type OverviewRollupReport = {
  readonly scope: RollupScope;
  /** Closed windows the run read, whether or not it spent an attempt on one. */
  readonly windows: number;
  readonly published: number;
  readonly settled: number;
  /** Refused windows, and the one a full member page could not enumerate whole. */
  readonly blocked: number;
  readonly reconsidered: number;
  readonly failed: number;
  /** Published chunks no window could be derived for, so the gap is visible. */
  readonly unplaceable: number;
};

/** How long a claim holds its number without publishing. */
export const OVERVIEW_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Gives back a number THIS attempt still owns, and nothing else.
 *
 * Ownership is proven by an unexpired claim under this actor's own identity, so the identity check
 * lives on this side of the call: the shared helper matches on the family and the number alone, and
 * releasing a row that now carries someone else's binding would hand a live attempt's number away.
 *
 * One case this cannot see. The shared claim derives the identity from the family key and the
 * number, so a reclaim after a lease expires writes back the SAME binding rather than a new one,
 * and a stale actor's release passes this test and clears the live claim. Written against the
 * intended contract, where a reclaim mints an ownership the old actor cannot match, this check
 * closes it; under the current claim it is the one dependency this publication carries, and it is
 * confined to these four lines rather than spread through the run.
 */
function releaseOwnClaim(
  db: SqliteHandle,
  familyKey: string,
  revisionNo: number,
  operationId: string,
): boolean {
  const held = listAllocatedRevisions(db, OVERVIEW_REVISION_FAMILY, familyKey).find(
    (row) => row.revisionNo === revisionNo,
  );
  if (held?.operationId !== operationId) {
    return false;
  }
  return releaseNarrativeClaim(db, OVERVIEW_REVISION_FAMILY, {
    familyKey,
    revisionNo,
    operationId,
  });
}

/** What the whole window would render to with nothing clipped. */
const UNCLIPPED = Number.MAX_SAFE_INTEGER;

const CAPACITY_BLOCK = 'blocked_window_capacity';
const UNREADABLE_BLOCK = 'blocked_window_member_unreadable';

/**
 * Whether the standing head still answers for this window exactly as the records hold it now.
 *
 * Three questions, because the citation set answers none of them alone. What a head CITES is the
 * support its prose rests on, and grounded output that stood on one of two members cites one: an
 * equality against the window's membership called that unchanged window changed and paid for the
 * same synthesis every run. What a head COVERS is the dependency set it published against, which
 * is durable on the revision and moves when a member arrives, leaves or republishes. And a covered
 * set whose ids have not moved can still be out of date — a correction under a member is a new
 * reading of the same member — so the stored evidence is verified rather than assumed current.
 *
 * The citation check that remains is a containment, not an equality: a head citing something the
 * window no longer holds is resting on prose about a member that has gone.
 */
function settled(db: SqliteHandle, familyKey: string, members: readonly OverviewMember[]): boolean {
  const head = readPublishedRevision(db, OVERVIEW_REVISION_FAMILY, familyKey);
  const stored = parseEvidence(head?.evidenceRevisionJson ?? null);
  if (head === undefined || stored === undefined) {
    return false;
  }
  if (memberEvidence(db, members).digest !== stored.digest) {
    return false;
  }
  const covered = new Set(members.map((member) => member.nodeId));
  if (readCitationsFrom(db, head.nodeId).some((citation) => !covered.has(citation.targetId))) {
    return false;
  }
  return verifyEvidenceRevision(db, stored).status === 'current';
}

/**
 * Clears a refusal whose recorded prerequisite no longer holds.
 *
 * A block is not a delay and it is not permanent either: what it recorded was a refusal UNDER A
 * BOUND and ABOUT A STATE, so a later run asks both questions. An allowance that moved makes the
 * refusal a statement about a policy nobody is running any more. An unreadable member is the other
 * prerequisite, and it moves on its own: a body missing from the graph while the window was
 * measured can come back with the same policy and the same member identity, and testing only the
 * allowance left that window refused for ever with nothing left to change.
 *
 * The bodies are read once per family and only where a standing refusal actually named an
 * unreadable member, so a family blocked on its allowance costs no graph read at all.
 */
async function reconsiderBlocked(
  deps: OverviewRollupDeps,
  options: OverviewRollupOptions,
  window: Window,
  familyKey: string,
): Promise<boolean> {
  let cleared = false;
  let read: Promise<boolean> | undefined;
  const membersReadable = (): Promise<boolean> => {
    read ??= findNarrativeBodies(
      deps.driver,
      window.members.map((member) => member.nodeId),
    ).then((bodies) => toConsolidationMembers(window.members, bodies, options.scope) !== undefined);
    return read;
  };
  for (let revisionNo = 1; ; revisionNo += 1) {
    const row = readNarrativeRevision(deps.db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo);
    if (row === undefined) {
      break;
    }
    if (row.blockedReason === null) {
      continue;
    }
    const policy = readAttemptPolicy(deps.db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo);
    const moved =
      policy?.renderedInputAllowance !== options.renderedInputAllowance ||
      (row.blockedReason === UNREADABLE_BLOCK && (await membersReadable()));
    if (moved && clearRevisionBlock(deps.db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo)) {
      cleared = true;
    }
  }
  return cleared;
}

/** Whether this family still carries a refusal, after the reconsideration had its say. */
function standingBlock(db: SqliteHandle, familyKey: string): boolean {
  return listAllocatedRevisions(db, OVERVIEW_REVISION_FAMILY, familyKey).some(
    (row) => row.blockedReason !== null,
  );
}

function toConsolidationMembers(
  members: readonly OverviewMember[],
  bodies: Map<
    string,
    { readonly text: string; readonly summary?: string; readonly occurredAt?: Date }
  >,
  scope: RollupScope,
): readonly ConsolidationMember[] | undefined {
  const rendered: ConsolidationMember[] = [];
  for (const member of members) {
    const body = bodies.get(member.nodeId);
    if (body === undefined || (body.text.length === 0 && body.summary === undefined)) {
      return undefined;
    }
    rendered.push({
      id: member.nodeId,
      kind: `${scope === 'day' ? 'chunk' : 'day'} narrative`,
      text: body.text.length > 0 ? body.text : (body.summary ?? ''),
      ...(body.occurredAt === undefined ? {} : { occurredAt: body.occurredAt }),
    });
  }
  return rendered;
}

type WindowOutcome = 'published' | 'blocked' | 'failed';

async function rollUpWindow(
  deps: OverviewRollupDeps,
  options: OverviewRollupOptions,
  window: Window,
  epoch: string,
): Promise<WindowOutcome> {
  const familyKey = overviewFamilyKey(options.scope, window.key);
  const bodies = await findNarrativeBodies(
    deps.driver,
    window.members.map((member) => member.nodeId),
  );
  const claim = claimNarrativeRevision(deps.db, OVERVIEW_REVISION_FAMILY, {
    familyKey,
    operationPrefix: overviewOperationPrefix(familyKey),
    now: options.now,
    leaseUntil: new Date(options.now.getTime() + OVERVIEW_CLAIM_LEASE_MS),
  });
  const operationId = `${overviewOperationPrefix(familyKey)}${String(claim.revisionNo)}`;
  const policy = { renderedInputAllowance: options.renderedInputAllowance };
  // The head this attempt is fenced against, bound HERE and not after the synthesis. Reading it
  // afterwards means a slow actor picks up whatever a faster one published while it worked and
  // offers that as its own expectation — an old computation relabelled against a new head, which
  // is how the shared slot ends up holding an output nothing can acknowledge.
  const expectedHead =
    readPublishedRevision(deps.db, OVERVIEW_REVISION_FAMILY, familyKey)?.revisionNo ?? null;

  const refuse = (reason: string, detail: Record<string, unknown>): WindowOutcome => {
    recordAttemptPolicy(deps.db, OVERVIEW_REVISION_FAMILY, familyKey, claim.revisionNo, policy);
    blockRevisionAttempt(deps.db, OVERVIEW_REVISION_FAMILY, familyKey, claim.revisionNo, reason);
    deps.logger.warn({ familyKey, reason, ...detail }, 'overview window refused');
    return 'blocked';
  };

  const members = toConsolidationMembers(window.members, bodies, options.scope);
  if (members === undefined) {
    // A member whose prose nobody can read is a hole in the window, and a window is covered whole
    // or refused. Publishing around it would store a coverage of 1 over a day it never read.
    return refuse(UNREADABLE_BLOCK, { members: window.members.length });
  }
  const source = renderConsolidationSource(members, UNCLIPPED, options.maxSentences);
  if (source.text.length > options.renderedInputAllowance) {
    return refuse(CAPACITY_BLOCK, {
      requiredUnits: source.text.length,
      allowance: options.renderedInputAllowance,
    });
  }

  let synthesis;
  try {
    synthesis = await synthesizeGrounded(deps.provider, source, buildMessages(source, options), {
      model: options.model ?? DEFAULTS.models.reflect,
      surface: 'narrative_overview',
      timeoutMs: options.timeoutMs ?? DEFAULTS.reflection.stageTimeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (err) {
    releaseOwnClaim(deps.db, familyKey, claim.revisionNo, operationId);
    deps.logger.warn({ err, familyKey }, 'overview synthesis failed');
    return 'failed';
  }
  if (synthesis.status !== 'grounded') {
    releaseOwnClaim(deps.db, familyKey, claim.revisionNo, operationId);
    deps.logger.info({ familyKey, status: synthesis.status }, 'overview not written');
    return 'failed';
  }

  const outcome = await publishOrFail(deps, familyKey, {
    kind: 'overview_publish',
    operationId,
    payload: {
      familyKey,
      scope: options.scope,
      windowKey: window.key,
      revisionNo: claim.revisionNo,
      nodeId: claim.nodeId,
      summary: synthesis.grounded.summary,
      narrative: synthesis.grounded.narrative,
      citations: [...synthesis.grounded.citations],
      sentenceCount: synthesis.grounded.kept,
      members: window.members.map((member) => ({
        familyKey: member.familyKey,
        nodeId: member.nodeId,
        revisionNo: member.revisionNo,
      })),
      spanStart: window.start.toISOString(),
      spanEnd: window.end.toISOString(),
      occurredAt: window.end.toISOString(),
      coverageEpoch: epoch,
      expectedHead,
    },
  });
  if (outcome?.status !== 'acknowledged') {
    // A claim an operation is holding is not the caller's to release, and the helper refuses to
    // take one back once a durable intent exists — so an interrupted publication keeps its number
    // and the coordinator's own recovery is what settles it.
    releaseOwnClaim(deps.db, familyKey, claim.revisionNo, operationId);
    deps.logger.info(
      { familyKey, status: outcome?.status ?? 'threw', reason: outcome?.reason },
      'overview publication did not land',
    );
    return 'failed';
  }
  deps.logger.info(
    { familyKey, revisionNo: claim.revisionNo, members: window.members.length },
    'overview published',
  );
  return 'published';
}

/**
 * One window's publication, with a coordinator error kept to that window.
 *
 * A pass over a calendar is a page of independent windows: failing the whole run over one of them
 * would leave the rest of the page unexamined and the operation reporting nothing it did.
 */
async function publishOrFail(
  deps: OverviewRollupDeps,
  familyKey: string,
  request: Parameters<PublicationCoordinator['publish']>[0],
) {
  try {
    return await deps.publications.publish(request);
  } catch (err) {
    deps.logger.warn({ err, familyKey }, 'overview publication could not be settled');
    return undefined;
  }
}

function buildMessages(
  source: { readonly text: string },
  options: OverviewRollupOptions,
): readonly { readonly role: 'system' | 'user'; readonly content: string }[] {
  return [
    {
      role: 'system',
      content:
        `Compress this ${options.scope} into one grounded account. Every sentence must cite the ` +
        'handles it came from, and you may state nothing the sources do not.',
    },
    { role: 'user', content: source.text },
  ];
}

export async function rollUpOverviews(
  deps: OverviewRollupDeps,
  options: OverviewRollupOptions,
): Promise<OverviewRollupReport> {
  const epoch = readCurrentCoverageContract(deps.db)?.epoch;
  const empty: OverviewRollupReport = {
    scope: options.scope,
    windows: 0,
    published: 0,
    settled: 0,
    blocked: 0,
    reconsidered: 0,
    failed: 0,
    unplaceable: 0,
  };
  if (epoch === undefined) {
    return empty;
  }
  const { windows, unplaceable, next, cut } = closedWindows(deps.db, options.scope, options.now);
  writeMemberCursor(deps.db, options.scope, next);
  let published = 0;
  let settledWindows = 0;
  let blocked = 0;
  let reconsidered = 0;
  let failed = 0;
  let examined = 0;

  if (cut !== undefined) {
    // A closed window this page could not enumerate whole. Leaving it out of the report offers an
    // incomplete reading as a calendar that holds nothing there, and the part of it that fit is
    // never published: an overview whose coverage says 1 has to have read all of what it covers.
    examined += 1;
    blocked += 1;
    deps.logger.warn(
      {
        scope: options.scope,
        window: cut.key,
        read: cut.members.length,
        bound: OVERVIEW_MEMBER_SCAN_LIMIT,
      },
      'overview window could not be enumerated whole at the member scan bound',
    );
  }

  for (const window of windows) {
    if (options.signal?.aborted === true || published + failed >= options.windowLimit) {
      break;
    }
    examined += 1;
    const familyKey = overviewFamilyKey(options.scope, window.key);
    if (await reconsiderBlocked(deps, options, window, familyKey)) {
      reconsidered += 1;
    }
    if (standingBlock(deps.db, familyKey)) {
      // A refusal the reconsideration did not clear is a prerequisite that has not moved. Claiming
      // another number to reach the same refusal spends a revision per pass and asks nothing new.
      blocked += 1;
      continue;
    }
    if (settled(deps.db, familyKey, window.members)) {
      settledWindows += 1;
      continue;
    }
    const outcome = await rollUpWindow(deps, options, window, epoch);
    if (outcome === 'published') {
      published += 1;
    } else if (outcome === 'blocked') {
      blocked += 1;
    } else {
      failed += 1;
    }
  }

  return {
    scope: options.scope,
    windows: examined,
    published,
    settled: settledWindows,
    blocked,
    reconsidered,
    failed,
    unplaceable,
  };
}

/** Re-exported so a reader of the graph can tell an overview from the two other families. */
export { OVERVIEW_NARRATIVE_FAMILY };
export { OVERVIEW_MEMBER_SCAN_LIMIT };
