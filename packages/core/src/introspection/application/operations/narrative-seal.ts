import {
  dueChunkGroups,
  dueRemainderGroups,
  type RemainderCursor,
} from '../../../infrastructure/sqlite/chunk-nomination.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  deferRevisionAttempt,
  readNarrativeRevision,
  CHUNK_REVISION_FAMILY,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  publishChunkNarrative,
  sealSessionChunk,
  type ChunkNarrativeDeps,
} from '../../../reflection/application/chunk-narrative.js';
import { CHUNK_MAX_MEMBERS } from '../../../reflection/domain/chunk-boundary.js';
import {
  STANDING_HEAD_REASON,
  SYNTHESIS_ATTEMPTED_REASONS,
} from '../../../reflection/domain/chunk-outcome.js';
import { narrativeSealRelevance } from '../../domain/narrative-seal.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * The chunk lifecycle's operator.
 *
 * C2 built the two halves and scheduled neither: a session's tail seals through `sealSessionChunk`
 * and a sealed chunk's narrative publishes through `publishChunkNarrative`, and until this nothing
 * called either in production. This is what calls them, on the ordinary maintenance cadence and
 * under the ordinary bounds. It adds no second partition algorithm, no second publication path,
 * and no recovery scheduler of its own.
 *
 * Three things happen per run, in this order and for this reason:
 *
 * 1. **A prior pending publication is finished first**, through the coordinator's own recovery
 *    hook. The guard admits one publication at a time, so a prepared and unsettled one stands in
 *    front of every writer on the substrate, this one included.
 * 2. **A bounded page of due tails is sealed**, oldest capture position first and resuming past
 *    where the last run stopped, so a session nothing can seal stops holding the front of the
 *    queue. Membership freezes at the seal and never moves afterwards.
 * 3. **A bounded number of publication attempts is spent** on due chunks, the ones this run
 *    sealed included. One attempt is one chunk revision: not one source, and not one model call.
 *
 * What it reports is what it did, in the units the work was done in. `itemsProcessed` counts
 * attempted chunk publications and `itemsAffected` the ones the substrate acknowledged; a sealed
 * membership is durable work and is NOT an affected publication, so it travels in the detail
 * beside the blocked sources and the retries that found a head already standing.
 */

export const NARRATIVE_SEAL_OPERATION = 'narrative_seal';

/** Where the last run's seal nomination stopped. One row, naming a group and nothing else. */
const CURSOR_KEY = 'narrative_seal:remainder_cursor';

/** The first retry delay after a failed attempt; each further attempt doubles it. */
export const SEAL_RETRY_BASE_MS = 15 * 60 * 1000;

/** Where doubling stops, so a chunk that has failed all day is still tried tomorrow. */
export const SEAL_RETRY_CEILING_MS = 6 * 60 * 60 * 1000;

/**
 * What a seal run needs that the loop does not already carry: the resolver that reads a member's
 * evidence, and the coordinator every write goes through. Both are the service's own instances.
 * An operation composed without them declines rather than reaching for a second one, the way
 * every other publishing operation here declines.
 */
export type NarrativeMaintenanceDeps = Pick<ChunkNarrativeDeps, 'resolver' | 'publications'>;

export type SealScales = {
  readonly batch: number;
  readonly maxSpanMs: number;
  readonly renderedInputAllowance: number;
};

function readCursor(db: SqliteHandle): RemainderCursor | undefined {
  const summary = getLedgerEntry(db, CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { captureKey, sessionId } = summary as { captureKey?: unknown; sessionId?: unknown };
  if (typeof captureKey !== 'string' || typeof sessionId !== 'string' || captureKey === '') {
    return undefined;
  }
  return { captureKey, sessionId };
}

/** Absent clears it, which is what reaching the end of the enumeration means. */
function writeCursor(db: SqliteHandle, cursor: RemainderCursor | undefined): void {
  markLedgerApplied(db, CURSOR_KEY, cursor === undefined ? {} : { ...cursor });
}

/** Doubling backoff off the attempts the revision row already counts. */
export function sealRetryDelayMs(attempts: number): number {
  const doublings = Math.min(Math.max(0, attempts - 1), 16);
  return Math.min(SEAL_RETRY_CEILING_MS, SEAL_RETRY_BASE_MS * 2 ** doublings);
}

function narrativeDeps(ctx: OperationContext, deps: NarrativeMaintenanceDeps): ChunkNarrativeDeps {
  return {
    driver: ctx.driver,
    db: ctx.db,
    provider: ctx.provider,
    resolver: deps.resolver,
    publications: deps.publications,
    logger: ctx.logger,
  };
}

/** The seal and the publication are measured against the same policy, so a chunk that sealed
 * inside the allowance is a chunk that renders inside it. */
function policyOf(scales: SealScales) {
  return {
    renderedInputAllowance: scales.renderedInputAllowance,
    maxMembers: CHUNK_MAX_MEMBERS,
    maxSpanMs: scales.maxSpanMs,
  };
}

type SealPass = {
  readonly chunkIds: readonly string[];
  readonly sealed: number;
  readonly members: number;
  readonly refused: number;
};

/**
 * The tails this run seals, and the chunks that produces.
 *
 * A refusal is not a failure of the run: a session carrying a source with no capture position
 * cannot be ordered into a chunk and says so, and the cursor moves past it so the sessions behind
 * it are reached on the same pass rather than waiting for a repair nothing here performs. The
 * cursor discharges nothing — the refused session is nominated again once it wraps.
 */
async function sealDueTails(
  ctx: OperationContext,
  deps: NarrativeMaintenanceDeps,
  scales: SealScales,
): Promise<SealPass> {
  const chunkDeps = narrativeDeps(ctx, deps);
  const chunkIds: string[] = [];
  let members = 0;
  let refused = 0;
  let cursor = readCursor(ctx.db);
  let wrapped = cursor === undefined;
  for (let page = 0; page < 2 && chunkIds.length + refused < scales.batch; page += 1) {
    const groups = dueRemainderGroups(ctx.db, {
      now: ctx.now,
      maxSpanMs: scales.maxSpanMs,
      maxMembers: CHUNK_MAX_MEMBERS,
      limit: scales.batch - chunkIds.length - refused,
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    if (groups.length === 0) {
      // The end of the enumeration. Start again from the front once, so a run that resumed near
      // the tail still spends its page, and stop if it has already been round.
      if (wrapped) {
        cursor = undefined;
        break;
      }
      wrapped = true;
      cursor = undefined;
      continue;
    }
    for (const group of groups) {
      if (ctx.signal.aborted) {
        break;
      }
      const report = await sealSessionChunk(chunkDeps, group.sessionId, {
        now: ctx.now,
        policy: policyOf(scales),
      });
      cursor = { captureKey: group.captureKey, sessionId: group.sessionId };
      if (report.status === 'sealed') {
        chunkIds.push(report.chunkId);
        members += report.members.length;
      } else if (report.status === 'refused') {
        refused += 1;
        ctx.logger.warn(
          { sessionId: group.sessionId, reason: report.reason },
          'narrative seal refused a session tail',
        );
      }
    }
    if (ctx.signal.aborted) {
      break;
    }
  }
  writeCursor(ctx.db, cursor);
  return { chunkIds, sealed: chunkIds.length, members, refused };
}

/**
 * What one publication attempt cost and what it settled.
 *
 * Two things a status word cannot say on its own, so both are read from the reason the lifecycle
 * returned rather than inferred from the word.
 *
 * `standing` is a head that still reads the same, and ONLY that. A head whose stored evidence
 * nobody could verify, or one whose coverage nobody could establish, is also reported `skipped`,
 * and calling it standing says the chunk is narrated when what actually happened is that the
 * substrate could not tell. That is `held`.
 *
 * `synthesized` says a provider was asked. `failed` covers both sides of the call — a coverage
 * refusal before it and a generation that threw after it — so counting every failure as a call
 * inflates the one cost measurement this operation contributes.
 */
type AttemptResult = {
  readonly published: boolean;
  readonly standing: boolean;
  readonly held: boolean;
  readonly blocked: boolean;
  readonly synthesized: boolean;
};

const NOTHING: AttemptResult = {
  published: false,
  standing: false,
  held: false,
  blocked: false,
  synthesized: false,
};

/**
 * A failed attempt is dated forward here rather than inside the lifecycle, because how long to
 * wait is a property of the cadence and not of the failure. A blocked attempt is dated nowhere:
 * its block clears on a changed prerequisite, and a timer is not one.
 */
async function attemptPublication(
  ctx: OperationContext,
  deps: NarrativeMaintenanceDeps,
  scales: SealScales,
  chunkId: string,
): Promise<AttemptResult> {
  const report = await publishChunkNarrative(narrativeDeps(ctx, deps), chunkId, {
    now: ctx.now,
    policy: policyOf(scales),
    model: ctx.config.models.reflect,
    timeoutMs: ctx.config.reflection.stageTimeoutMs,
    signal: ctx.signal,
  });
  if (report.status === 'published') {
    return { ...NOTHING, published: true, synthesized: true };
  }
  if (report.status === 'skipped') {
    const standing = report.reason === STANDING_HEAD_REASON;
    if (!standing) {
      ctx.logger.info(
        { chunkId, reason: report.reason },
        'narrative seal is holding a chunk whose head it could not establish',
      );
    }
    return { ...NOTHING, standing, held: !standing };
  }
  if (report.status === 'blocked') {
    ctx.logger.warn({ chunkId, reason: report.reason }, 'narrative seal blocked a chunk revision');
    return { ...NOTHING, blocked: true };
  }
  // A deferral happens after the output exists, so it cost a call; a failure may be either side
  // of one, and the lifecycle's own reason set is what says which.
  const synthesized =
    report.status === 'deferred' || SYNTHESIS_ATTEMPTED_REASONS.includes(report.reason);
  if (report.status === 'failed') {
    const row = readNarrativeRevision(ctx.db, CHUNK_REVISION_FAMILY, chunkId, report.revisionNo);
    deferRevisionAttempt(
      ctx.db,
      CHUNK_REVISION_FAMILY,
      chunkId,
      report.revisionNo,
      new Date(ctx.now.getTime() + sealRetryDelayMs(row?.attempts ?? 1)),
    );
  }
  ctx.logger.warn(
    { chunkId, status: report.status, reason: report.reason },
    'narrative seal could not publish a chunk revision',
  );
  return { ...NOTHING, synthesized };
}

type RunTally = {
  readonly attempted: number;
  readonly published: number;
  readonly synthesized: number;
  readonly blocked: number;
  readonly standing: number;
  readonly held: number;
};

function detailOf(
  seal: SealPass,
  tally: RunTally,
  recovered: number,
  blockedSources: number,
): string {
  return (
    `${String(tally.published)} of ${String(tally.attempted)} chunk publication attempt(s) ` +
    `acknowledged, ${String(tally.synthesized)} reached synthesis; ` +
    `${String(seal.sealed)} membership(s) sealed over ${String(seal.members)} source(s); ` +
    `${String(tally.standing)} standing head(s), ${String(tally.held)} held head(s), ` +
    `${String(tally.blocked)} blocked attempt(s) ` +
    `over ${String(blockedSources)} held source(s), ${String(seal.refused)} refused tail(s), ` +
    `${String(recovered)} pending publication(s) recovered`
  );
}

function noop(detail: string): OperationOutcome {
  return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail };
}

/**
 * Whether a prior publication is still unsettled, and why the run cannot say otherwise.
 *
 * `undefined` is the only answer that lets a run continue, and it means the records said so. A
 * control record that cannot be read is not an absent pending operation: it is the question
 * unanswered, which is the state a run must not act through.
 */
function heldPending(ctx: OperationContext, deps: NarrativeMaintenanceDeps): string | undefined {
  try {
    return deps.publications.hasPending() ? 'the coordinator still holds it' : undefined;
  } catch (err) {
    ctx.logger.warn({ err }, 'narrative seal could not read the publication control record');
    return 'the publication control record could not be read';
  }
}

/**
 * The chunks this run may attempt, in one order over one population.
 *
 * Taken AFTER the seal and read from the manifest, so a membership this run froze is in the same
 * enumeration as everything else that is due and takes its place in it by capture position. The
 * queue used to put the freshly sealed chunks in front, which made arrival outrank age: a
 * substrate taking new sources faster than it publishes them would spend every slot on the newest
 * tail while the oldest chunk waited forever, and the remainder cursor protects only the seal
 * side. Blocked and future-due attempts stay excluded, and nothing here discharges anything.
 */
function publicationQueue(ctx: OperationContext, batch: number): readonly string[] {
  return dueChunkGroups(ctx.db, ctx.now, batch).map((group) => group.chunkId);
}

async function runSeal(ctx: OperationContext, scales: SealScales): Promise<OperationOutcome> {
  const deps = ctx.narratives;
  if (deps === undefined) {
    return noop('no narrative publisher composed to seal or publish through; nothing asked');
  }
  let recovered = 0;
  try {
    if ((await deps.publications.recover()) !== undefined) {
      recovered = 1;
    }
  } catch (err) {
    ctx.logger.warn({ err }, 'narrative seal could not complete a pending publication');
  }
  // Recovery before new work is not a preference about ordering; it is what the ≤1-pending
  // invariant means. While a prior operation is unsettled the guard admits no other, so sealing a
  // membership or starting another expensive attempt here spends the run on work that cannot
  // land and freezes a partition around a publication that may still be discarded. A recovery
  // that threw proves nothing either way, so the question asked is the records': is the prior
  // operation settled or absent. Anything else, including an unreadable control record, holds.
  const held = heldPending(ctx, deps);
  if (held !== undefined) {
    return noop(`a prior publication is unsettled (${held}); no seal or attempt was started`);
  }

  const seal = await sealDueTails(ctx, deps, scales);
  let tally: RunTally = {
    attempted: 0,
    published: 0,
    synthesized: 0,
    blocked: 0,
    standing: 0,
    held: 0,
  };
  for (const chunkId of publicationQueue(ctx, scales.batch)) {
    if (ctx.signal.aborted || tally.attempted >= scales.batch) {
      break;
    }
    const result = await attemptPublication(ctx, deps, scales, chunkId);
    tally = {
      attempted: tally.attempted + 1,
      published: tally.published + (result.published ? 1 : 0),
      synthesized: tally.synthesized + (result.synthesized ? 1 : 0),
      blocked: tally.blocked + (result.blocked ? 1 : 0),
      standing: tally.standing + (result.standing ? 1 : 0),
      held: tally.held + (result.held ? 1 : 0),
    };
  }

  const blockedSources = Object.values(ctx.health.narrativeSeal.blockedSourcesByReason).reduce(
    (total, count) => total + count,
    0,
  );
  const detail = detailOf(seal, tally, recovered, blockedSources);
  if (tally.attempted === 0 && seal.sealed === 0 && recovered === 0) {
    return noop(`nothing due; ${detail}`);
  }
  return {
    // A durable allocated or sealed row alone is not an affected publication, so a run that
    // sealed but published nothing reports what it did in the detail and claims no effect.
    status: tally.published > 0 ? 'applied' : 'noop',
    itemsProcessed: tally.attempted,
    itemsAffected: tally.published,
    detail,
  };
}

export function narrativeSealOperation(scales: SealScales): IntrospectionOperation {
  return {
    name: NARRATIVE_SEAL_OPERATION,
    bucket: 'hour',
    // No `measure`. The snapshot counts what the lifecycle owes, not what a narrative is worth,
    // and an operation scored on lowering its own backlog is credited alike for a chunk it
    // published and one it blocked.
    relevance: (health) =>
      narrativeSealRelevance(health, { batch: scales.batch, ageScaleMs: scales.maxSpanMs }),
    run: (ctx) => runSeal(ctx, scales),
  };
}
