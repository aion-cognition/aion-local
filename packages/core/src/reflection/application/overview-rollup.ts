import type { Driver } from 'neo4j-driver';

import { synthesizeGrounded } from './consolidation-synthesis.js';
import { overviewOperationPrefix, OVERVIEW_NARRATIVE_FAMILY } from './overview-publication.js';
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
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  overviewFamilyKey,
  publishedChunkSpans,
  publishedOverviewSpans,
  unplaceableChunks,
  type MemberCursor,
  type OverviewMember,
} from '../../infrastructure/sqlite/overview-membership.js';
import { renderConsolidationSource, type ConsolidationMember } from '../domain/consolidation.js';
import { isWindowClosed, rollupWindow, type RollupScope } from '../domain/rollup.js';

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
 * - **Reconsidered.** A refusal recorded under a different allowance than the one in force is not
 *   a standing decision: the block clears and the window is measured again.
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
  readonly blocked: number;
  readonly reconsidered: number;
  readonly failed: number;
  /** Published chunks no window could be derived for, so the gap is visible. */
  readonly unplaceable: number;
};

/** Members read per run, across every window. The bound on the scan, not on the attempts. */
export const OVERVIEW_MEMBER_SCAN_LIMIT = 500;

/** How long a claim holds its number without publishing. */
export const OVERVIEW_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Gives back a number THIS attempt still owns, and nothing else.
 *
 * Ownership is proven by an unexpired claim under this actor's own identity. A number whose row
 * now carries a different binding was reclaimed after this actor's lease expired, and the reclaim
 * mints a new ownership: releasing it here would hand a live attempt's number away. The shared
 * helper matches on the family and the number alone, so the identity check lives on this side of
 * the call rather than being assumed of it.
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

type Window = {
  readonly key: string;
  readonly start: Date;
  readonly end: Date;
  readonly members: readonly OverviewMember[];
};

/** Every member of the scope below, grouped into the closed windows of this scope. */
function readMembers(
  db: SqliteHandle,
  scope: RollupScope,
  after?: MemberCursor,
): readonly OverviewMember[] {
  return scope === 'day'
    ? publishedChunkSpans(db, OVERVIEW_MEMBER_SCAN_LIMIT, after)
    : publishedOverviewSpans(db, 'day', OVERVIEW_MEMBER_SCAN_LIMIT, after);
}

function closedWindows(
  db: SqliteHandle,
  scope: RollupScope,
  now: Date,
): {
  readonly windows: readonly Window[];
  readonly unplaceable: number;
  readonly next: MemberCursor | undefined;
} {
  const cursor = readMemberCursor(db, scope);
  let members = readMembers(db, scope, cursor);
  if (members.length === 0 && cursor !== undefined) {
    // The end of the enumeration, reached inside this run. Starting from the front again is what
    // makes the position a position rather than a discharge.
    members = readMembers(db, scope);
  }
  const grouped = new Map<
    string,
    { bounds: ReturnType<typeof rollupWindow>; rows: OverviewMember[] }
  >();
  for (const member of members) {
    const at = new Date(member.spanEnd);
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    const bounds = rollupWindow(scope, at);
    const entry = grouped.get(bounds.key);
    if (entry === undefined) {
      grouped.set(bounds.key, { bounds, rows: [member] });
      continue;
    }
    entry.rows.push(member);
  }
  const windows = [...grouped.values()]
    .filter((entry) => isWindowClosed(entry.bounds, now))
    .map((entry) => ({
      key: entry.bounds.key,
      start: entry.bounds.start,
      end: entry.bounds.end,
      members: [...entry.rows].sort((left, right) => left.spanEnd.localeCompare(right.spanEnd)),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  // Past the last member this page read, so the next page reaches the windows behind it. A page
  // that came back short is the end of the walk and clears the position.
  const last = members[members.length - 1];
  const next =
    members.length < OVERVIEW_MEMBER_SCAN_LIMIT || last === undefined
      ? undefined
      : { spanEnd: last.spanEnd, familyKey: last.familyKey };
  return { windows, unplaceable: scope === 'day' ? unplaceableChunks(db) : 0, next };
}

/** Where the last pass of one scope stopped reading members. */
function memberCursorKey(scope: RollupScope): string {
  return `narrative-overview:member-cursor:${scope}`;
}

function readMemberCursor(db: SqliteHandle, scope: RollupScope): MemberCursor | undefined {
  const summary = getLedgerEntry(db, memberCursorKey(scope))?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { spanEnd, familyKey } = summary as { spanEnd?: unknown; familyKey?: unknown };
  return typeof spanEnd === 'string' && typeof familyKey === 'string' && familyKey !== ''
    ? { spanEnd, familyKey }
    : undefined;
}

function writeMemberCursor(
  db: SqliteHandle,
  scope: RollupScope,
  cursor: MemberCursor | undefined,
): void {
  markLedgerApplied(db, memberCursorKey(scope), cursor === undefined ? {} : { ...cursor });
}

/** Whether the standing head already cites exactly this membership. */
function settled(db: SqliteHandle, familyKey: string, members: readonly OverviewMember[]): boolean {
  const head = readPublishedRevision(db, OVERVIEW_REVISION_FAMILY, familyKey);
  if (head === undefined) {
    return false;
  }
  const cited = readCitationsFrom(db, head.nodeId)
    .map((citation) => citation.targetId)
    .sort();
  const current = members.map((member) => member.nodeId).sort();
  return cited.join(' ') === current.join(' ');
}

/**
 * Clears a refusal the policy in force would no longer produce.
 *
 * A block is not a delay and it is not permanent either: what it recorded was a refusal UNDER A
 * BOUND, so the question a later run asks is whether that bound still stands. An allowance that
 * moved makes the recorded refusal a statement about a policy nobody is running any more.
 */
function reconsiderBlocked(db: SqliteHandle, familyKey: string, allowance: number): boolean {
  let cleared = false;
  for (let revisionNo = 1; ; revisionNo += 1) {
    const row = readNarrativeRevision(db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo);
    if (row === undefined) {
      break;
    }
    if (row.blockedReason === null) {
      continue;
    }
    const policy = readAttemptPolicy(db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo);
    if (policy?.renderedInputAllowance === allowance) {
      continue;
    }
    if (clearRevisionBlock(db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo)) {
      cleared = true;
    }
  }
  return cleared;
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

  const head = readPublishedRevision(deps.db, OVERVIEW_REVISION_FAMILY, familyKey);
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
      expectedHead: head?.revisionNo ?? null,
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
  const { windows, unplaceable, next } = closedWindows(deps.db, options.scope, options.now);
  writeMemberCursor(deps.db, options.scope, next);
  let published = 0;
  let settledWindows = 0;
  let blocked = 0;
  let reconsidered = 0;
  let failed = 0;
  let examined = 0;

  for (const window of windows) {
    if (options.signal?.aborted === true || published + failed >= options.windowLimit) {
      break;
    }
    examined += 1;
    const familyKey = overviewFamilyKey(options.scope, window.key);
    if (reconsiderBlocked(deps.db, familyKey, options.renderedInputAllowance)) {
      reconsidered += 1;
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
