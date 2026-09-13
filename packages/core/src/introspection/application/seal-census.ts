import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import {
  blockedChunkSources,
  dueChunkGroups,
  dueRemainderGroups,
  heldRemainderMembership,
  inputFullRemainderGroups,
  publishedChunkHeads,
  type HeadCursor,
} from '../../infrastructure/sqlite/chunk-nomination.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { coordinatorControl } from '../../infrastructure/sqlite/publication-coordinator-store.js';
import { NEUTRAL_SEAL_DEMAND, type SealDemand } from '../domain/health.js';

/**
 * The chunk lifecycle's demand, taken once per tick from durable state.
 *
 * Two readings, taken apart on purpose. The FRESH CENSUS counts what a run could pick up now; the
 * PENDING READING says whether a publication is already prepared and unsettled. A substrate whose
 * manifest cannot be read still knows about an interrupted publication, and a run is called for on
 * that alone: finishing what the last one started is the work, and no fresh eligibility is needed
 * to justify it. Folding the two into one try/catch would have lost exactly that case.
 *
 * The census is bounded like the run it scores. Counting an unbounded backlog to divide by a batch
 * of two costs a full scan every tick to produce a number that saturates at the first page, so each
 * group read stops one past the point where the ratio is already 1 and the count is reported as the
 * floor it is.
 */

/**
 * How far past the batch the census counts. The relevance ratio saturates at B, so what is above
 * the ceiling changes no score; the extra page is what lets a caller tell a full page from a page
 * that ended exactly on the bound.
 */
export const SEAL_CENSUS_CEILING_FACTOR = 4;

export type SealCensusInput = {
  readonly now: Date;
  /** The publication attempts one run makes, which is what the count is scored against. */
  readonly batch: number;
  /** Elapsed arrival age at which a session's tail seals on the span trigger. */
  readonly maxSpanMs: number;
  /** Members one chunk may hold, which is the other trigger durable state can see. */
  readonly maxMembers: number;
  /**
   * The rendered input one synthesis may spend, which is the third trigger. Optional so a caller
   * reading a census of the shipped policy need not restate it; `observe.ts` threads the live
   * value, so a retuned allowance moves the discovery and the run together.
   */
  readonly renderedInputAllowance?: number;
};

function ageMs(now: Date, at: string | undefined): number | undefined {
  if (at === undefined) {
    return undefined;
  }
  const stamp = new Date(at).getTime();
  if (Number.isNaN(stamp)) {
    return undefined;
  }
  return Math.max(0, now.getTime() - stamp);
}

function oldest(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left <= right ? left : right;
}

/**
 * The pending publication, read on its own so an unreadable control record is a `undefined`
 * rather than a `false`. Nothing pending and nobody able to say are different answers, and the
 * second one must not read as a healthy substrate.
 */
function readPending(db: SqliteHandle): { pending: boolean | undefined; reason?: string } {
  try {
    return { pending: coordinatorControl(db).pendingOperationId !== null };
  } catch (err) {
    return {
      pending: undefined,
      reason: `the publication control record is unreadable: ${String(err)}`,
    };
  }
}

/**
 * Published heads that no longer rest on what stands, counted over a MOVING bounded page.
 *
 * Invalidation is a property of the head's own stored dependency set, so the count is taken through
 * the verifier the publication itself uses rather than from a marker a write had to remember to
 * stamp. A head whose set will not parse is left out of the count: unreadable is not stale, and the
 * pass that would rewrite it declines it on the same reading.
 *
 * The page moves because a fixed one cannot discover anything. Verifying the first four heads every
 * tick means five current heads in front of a stale sixth give relevance zero for ever, and the
 * cursor the RUN advances is no help: the run is what relevance was supposed to select. So the
 * collector carries its own position, advances it on every observation, and wraps at the end. It is
 * a floor either way — what it reports is what this page found, not what the substrate holds.
 */
const CENSUS_HEAD_CURSOR_KEY = 'narrative-seal:census-head-cursor';

function readCensusCursor(db: SqliteHandle): HeadCursor | undefined {
  const summary = getLedgerEntry(db, CENSUS_HEAD_CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { captureKey, chunkId } = summary as { captureKey?: unknown; chunkId?: unknown };
  return typeof captureKey === 'string' && typeof chunkId === 'string' && chunkId !== ''
    ? { captureKey, chunkId }
    : undefined;
}

function invalidatedHeadCount(db: SqliteHandle, ceiling: number): number {
  const resume = readCensusCursor(db);
  let heads = publishedChunkHeads(db, ceiling, resume);
  if (heads.length === 0 && resume !== undefined) {
    heads = publishedChunkHeads(db, ceiling);
  }
  const last = heads.at(-1);
  markLedgerApplied(
    db,
    CENSUS_HEAD_CURSOR_KEY,
    heads.length < ceiling || last?.captureKey == null
      ? {}
      : { captureKey: last.captureKey, chunkId: last.chunkId },
  );
  let stale = 0;
  for (const head of heads) {
    if (head.evidenceRevisionJson === null) {
      continue;
    }
    let stored: EvidenceRevision;
    try {
      stored = JSON.parse(head.evidenceRevisionJson) as EvidenceRevision;
    } catch {
      continue;
    }
    if (verifyEvidenceRevision(db, stored).status === 'stale') {
      stale += 1;
    }
  }
  return stale;
}

export function readSealDemand(db: SqliteHandle, input: SealCensusInput): SealDemand {
  const { pending, reason } = readPending(db);
  const ceiling = Math.max(1, input.batch * SEAL_CENSUS_CEILING_FACTOR);
  try {
    const chunks = dueChunkGroups(db, input.now, ceiling);
    const remainders = dueRemainderGroups(db, {
      now: input.now,
      maxSpanMs: input.maxSpanMs,
      maxMembers: input.maxMembers,
      limit: ceiling,
    });
    // The input trigger, discovered rather than measured: a tail already carrying more than a
    // render may spend is demand even while it is young and small. A session counted here and by
    // the count or age triggers is one group, not two.
    const inputFull = inputFullRemainderGroups(db, {
      allowance: input.renderedInputAllowance ?? DEFAULTS.maintenance.chunkRenderedInputAllowance,
      maxMembers: input.maxMembers,
      limit: ceiling,
    });
    const remainderKeys = new Set(remainders.map((group) => group.sessionId));
    const extraInput = inputFull.filter((group) => !remainderKeys.has(group.sessionId));
    const blocked = [...blockedChunkSources(db)];
    const held = heldRemainderMembership(db);
    const blockedSourcesByReason: Record<string, number> = {};
    for (const tally of blocked) {
      blockedSourcesByReason[tally.reason] = tally.sources;
    }
    if (held.sources > 0) {
      // An unverified source stays outside membership. It is held, not eligible, and it is
      // named so the wait is visible rather than a source that is simply never narrated.
      blockedSourcesByReason.membership_unverified = held.sources;
    }
    const blockedAt = blocked.reduce<string | undefined>(
      (soonest, tally) => oldest(soonest, tally.oldestAt),
      held.oldestAt,
    );
    // The age of the oldest ELIGIBLE group, so an offered tail does not date a backlog it may
    // turn out not to be part of.
    const eligibleAt = [
      ...chunks.map((chunk) => chunk.sealedAt),
      ...remainders.map((group) => group.oldestArrivalAt),
    ].reduce<string | undefined>((soonest, at) => oldest(soonest, at), undefined);
    return {
      eligibleGroups: chunks.length + remainders.length,
      dueRemainders: remainders.length,
      inputCandidates: extraInput.length,
      dueChunks: chunks.length,
      oldestEligibleAgeMs: ageMs(input.now, eligibleAt),
      invalidatedHeads: invalidatedHeadCount(db, ceiling),
      blockedSourcesByReason,
      blockedOldestAgeMs: ageMs(input.now, blockedAt),
      pendingPublishedRepair: pending,
      availability: 'measured',
      ...(reason === undefined ? {} : { diagnostic: reason }),
    };
  } catch (err) {
    return {
      ...NEUTRAL_SEAL_DEMAND,
      pendingPublishedRepair: pending,
      diagnostic: `the narrative manifest census failed: ${String(err)}`,
    };
  }
}
