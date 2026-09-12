import { randomUUID } from 'node:crypto';

import { repairSurvivors, type SurvivorRepairReport } from './eviction-repair.js';
import { inWriteTransaction } from '../../../infrastructure/graph/connection.js';
import type { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { episodeEvictionPublication } from '../../../reflection/application/episode-eviction.js';
import type { EvictionCandidate } from '../../../reflection/application/eviction-eligibility.js';
import { planRemoval, type PlannedRemoval } from '../../../reflection/application/eviction-plan.js';
import { episodeEvictRelevance } from '../../domain/episode-evict.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';
import { EVICTION_SCAN_PAGE, scanEvictionCandidates } from '../eviction-census.js';

/**
 * The steady-state operator for C9's bounded eviction.
 *
 * Three things happen per run, in this order and for this reason:
 *
 * 1. **A prior pending publication is finished first.** The guard admits one publication at a
 *    time, so an unsettled one stands in front of every writer on the substrate. Nothing else
 *    here can land until it is settled, and an eviction is the last operation that should be
 *    started on top of one.
 * 2. **Survivor work an acknowledged eviction already owes is discharged.** It exists because a
 *    receipt proved a deletion, so it is real work with nothing left to decide, and leaving it
 *    behind fresh nominations would let the recomputation backlog grow behind removals.
 * 3. **A bounded number of attempts is spent**, one source each, nominated by a durable keyset
 *    scan that advances over the rows it examined whether they qualified or not. That is what
 *    stops one permanently pinned source at the head of the enumeration from holding every later
 *    eligible source behind it forever.
 *
 * `itemsAffected` counts acknowledged evictions. A nomination is not an effect, a pinned source
 * is not a failure, and a deferred attempt is a source that stayed exactly where it was.
 */

export const EPISODE_EVICT_OPERATION = 'episode_evict';

const CURSOR_KEY = 'episode_evict:scan_cursor';

export type EvictScales = {
  /** Attempts one invocation makes. One attempt is one source. */
  readonly batch: number;
  readonly minAgeMs: number;
};

function readCursor(db: OperationContext['db']): { sourceId: string } | undefined {
  const summary = getLedgerEntry(db, CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { sourceId } = summary as { sourceId?: unknown };
  return typeof sourceId === 'string' && sourceId !== '' ? { sourceId } : undefined;
}

/** Absent clears it, which is what reaching the end of the enumeration means. */
function writeCursor(db: OperationContext['db'], cursor: { sourceId: string } | undefined): void {
  markLedgerApplied(db, CURSOR_KEY, cursor === undefined ? {} : { ...cursor });
}

function noop(detail: string): OperationOutcome {
  return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail };
}

/**
 * The payload one attempt binds at run start.
 *
 * Epoch, population and every durable version travel together into the intent, because the guard
 * compares what this run READ against what it finds, and a field left out of the binding is a
 * field nothing can be compared on.
 */
function payloadOf(
  candidate: EvictionCandidate,
  plan: PlannedRemoval,
  now: Date,
): Record<string, unknown> {
  return {
    sourceId: candidate.sourceId,
    sessionId: candidate.sessionId,
    observedAt: now.toISOString(),
    coverageEpoch: candidate.coverageEpoch,
    chunkId: candidate.chunkId,
    publishedRevisionNo: candidate.publishedRevisionNo,
    processingGeneration: candidate.processingGeneration,
    operationalRevision: candidate.operationalRevision,
    readinessPolicyRevision: candidate.readinessPolicyRevision,
    projectionGeneration: candidate.projectionGeneration,
    acceptedReferenceVersion: candidate.acceptedReferenceVersion,
    qualifiedAt: candidate.qualifiedAt,
    nodeIds: [...plan.nodeIds],
    relationIds: [...plan.relationIds],
    nodeDigest: plan.nodeDigest,
    categoryDigest: plan.categoryDigest,
    survivors: plan.survivors.map((entry) => ({ ...entry })),
    contentDigests: { ...candidate.contentDigests },
    searchCoverageProof: { ...candidate.searchCoverageProof },
    dependencies: candidate.dependencies.map((entry) => ({ ...entry })),
  };
}

type AttemptTally = {
  readonly attempted: number;
  readonly evicted: number;
  readonly deferred: number;
  readonly pinned: number;
};

/**
 * One source, nominated and offered.
 *
 * The removal set is derived here, outside the guard, because deriving it is the expensive part:
 * a node read, an incident census and a hash per edge. What the guard is held for is deriving it
 * again and comparing, which is cheap next to holding the lock through the first derivation.
 */
async function attemptEviction(
  ctx: OperationContext,
  publications: PublicationCoordinator,
  candidate: EvictionCandidate,
): Promise<'evicted' | 'deferred' | 'pinned'> {
  // A managed transaction whose body only reads: the census has to see one consistent graph, and
  // this run holds no guard yet.
  const planned = await inWriteTransaction(ctx.driver, async (tx) =>
    planRemoval(ctx.db, tx, candidate),
  );
  if (planned.status !== 'planned') {
    ctx.logger.info(
      { sourceId: candidate.sourceId, reason: planned.reason },
      'episode evict pinned a source',
    );
    return 'pinned';
  }
  const outcome = await publications.publish({
    kind: episodeEvictionPublication.kind,
    operationId: randomUUID(),
    payload: payloadOf(candidate, planned.plan, ctx.now),
  });
  if (outcome.status === 'acknowledged') {
    return 'evicted';
  }
  ctx.logger.warn(
    { sourceId: candidate.sourceId, status: outcome.status, reason: outcome.reason },
    'episode evict did not settle an attempt',
  );
  return 'deferred';
}

function detailOf(
  tally: AttemptTally,
  repaired: SurvivorRepairReport,
  recovered: number,
  examined: number,
): string {
  const refused =
    repaired.refusal === undefined ? '' : ` (the guard refused the batch: ${repaired.refusal})`;
  return (
    `${String(tally.evicted)} of ${String(tally.attempted)} eviction attempt(s) acknowledged, ` +
    `${String(tally.deferred)} deferred, ${String(tally.pinned)} pinned under the guard ` +
    `over ${String(examined)} source(s) examined; ` +
    `${String(repaired.recomputed)} survivor vector(s) recomputed, ` +
    `${String(repaired.cleared)} cleared, ${String(repaired.stamped)} unweighted, ` +
    `${String(repaired.classified)} carrying none, ` +
    `${String(repaired.deferred)} left owed ` +
    `of ${String(repaired.attempted)} attempted, ` +
    `${String(repaired.lapsed)} parked obligation(s) aged out${refused}; ` +
    `${String(recovered)} pending publication(s) recovered`
  );
}

/** The graph writes the repair published: a stamp is a write, and a hold is not. */
function repairedCount(repaired: SurvivorRepairReport): number {
  return repaired.recomputed + repaired.cleared + repaired.stamped + repaired.classified;
}

async function runEvict(ctx: OperationContext, scales: EvictScales): Promise<OperationOutcome> {
  const publications = ctx.narratives?.publications;
  if (publications === undefined) {
    return noop('no publication coordinator composed to evict through; nothing asked');
  }
  let recovered = 0;
  try {
    if ((await publications.recover()) !== undefined) {
      recovered = 1;
    }
  } catch (err) {
    ctx.logger.warn({ err }, 'episode evict could not complete a pending publication');
  }
  const repaired = await repairSurvivors(
    { driver: ctx.driver, db: ctx.db, publications, now: ctx.now },
    scales.batch,
  );
  let held: string | undefined;
  try {
    held = publications.hasPending() ? 'the coordinator still holds it' : undefined;
  } catch (err) {
    ctx.logger.warn({ err }, 'episode evict could not read the publication control record');
    held = 'the publication control record could not be read';
  }
  if (held !== undefined) {
    return {
      status: repairedCount(repaired) > 0 ? 'applied' : 'noop',
      itemsProcessed: repaired.attempted,
      itemsAffected: 0,
      detail: `a prior publication is unsettled (${held}); no eviction was attempted. ${detailOf(
        { attempted: 0, evicted: 0, deferred: 0, pinned: 0 },
        repaired,
        recovered,
        0,
      )}`,
    };
  }

  const scan = scanEvictionCandidates(ctx.db, {
    now: ctx.now,
    minAgeMs: scales.minAgeMs,
    limit: EVICTION_SCAN_PAGE,
    ...(readCursor(ctx.db) === undefined ? {} : { after: readCursor(ctx.db) }),
  });
  writeCursor(ctx.db, scan.cursor);
  let tally: AttemptTally = { attempted: 0, evicted: 0, deferred: 0, pinned: 0 };
  for (const candidate of scan.candidates) {
    if (ctx.signal.aborted || tally.attempted >= scales.batch) {
      break;
    }
    const result = await attemptEviction(ctx, publications, candidate);
    tally = {
      attempted: tally.attempted + 1,
      evicted: tally.evicted + (result === 'evicted' ? 1 : 0),
      deferred: tally.deferred + (result === 'deferred' ? 1 : 0),
      pinned: tally.pinned + (result === 'pinned' ? 1 : 0),
    };
  }
  const detail = detailOf(tally, repaired, recovered, scan.examined);
  const affected = tally.evicted + repairedCount(repaired);
  if (affected === 0 && recovered === 0) {
    return noop(`nothing due; ${detail}`);
  }
  return {
    status: tally.evicted > 0 || affected > 0 ? 'applied' : 'noop',
    itemsProcessed: tally.attempted + repaired.attempted,
    itemsAffected: affected,
    detail,
  };
}

export function episodeEvictOperation(scales: EvictScales): IntrospectionOperation {
  return {
    name: EPISODE_EVICT_OPERATION,
    // A quarter-hour window and tier 2: the work is bounded, it preempts nothing, and it is
    // excluded from tier-3 consultation by carrying no `answers` condition of its own.
    bucket: 'quarter-hour',
    // No `measure`. What an eviction lowers is the resident population, and an operation scored
    // on lowering that is an operation rewarded for removing more, which is the last incentive a
    // destructive pass should carry.
    relevance: (health) => episodeEvictRelevance(health, { batch: scales.batch }),
    run: (ctx) => runEvict(ctx, scales),
  };
}
