import type { NarrativeMaintenanceDeps } from './narrative-seal.js';
import { verifyEvidenceRevision } from '../../../evidence/application/dependencies.js';
import type { EvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import {
  publishedChunkHeads,
  type HeadCursor,
} from '../../../infrastructure/sqlite/chunk-nomination.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { publishChunkNarrative } from '../../../reflection/application/chunk-narrative.js';
import { cleanupNarratives } from '../../../reflection/application/narrative-cleanup.js';
import { HEALTH_COLLECTORS, type HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * Rewrites a narrative that no longer matches the evidence underneath it.
 *
 * A narrative compresses claims into prose and carries no supersession lineage of its own, so
 * closing the claim it was written from leaves it standing, marked current, restating the
 * correction's own subject with the old value. Two contradictory sentences, both current, is the
 * worst answer the substrate can give.
 *
 * TWO READINGS, ONE FAMILY. A narrative carries a grounding marker an applied supersession
 * stamps, and `findStaleNarratives` selects on it. A published revision carries something better:
 * the dependency set it was published on, stored with it, so what invalidated it is a question the
 * records answer exactly rather than a marker somebody had to remember to stamp. The dependency
 * pass reads that set through the same verifier the publication uses, and regrounds the exact
 * heads it finds stale through the same publication path. The marker pass catches what a stamp
 * reaches and no stored dependency names.
 *
 * It declares no metric. The one it used to declare counted the graph marker alone, which is one
 * of the two populations it now repairs; a new baseline has to exist before runs over both can be
 * scored, and the old count is not that baseline. Recorded runs stay exactly as they were, and
 * the parked sample is dropped by the scoring pass that notices the metric is gone.
 */

export const NARRATIVE_REGROUNDING_OPERATION = 'narrative_regrounding';

/**
 * Relevance divides the backlog by the batch a run actually rewrites, bound where the operation
 * is constructed. It used to divide by the shipped default because the contract hands relevance
 * only the health snapshot: an operator who halved the batch then doubled how long the same
 * backlog took and changed nothing about how urgently the loop asked for it.
 */
export function narrativeRegroundingRelevance(health: HealthSnapshot, batch: number): number {
  if (batch <= 0) {
    return 0;
  }
  // Two readings, and either one alone is demand. The marker count comes off the graph and the
  // invalidated-head count off the manifest, so a degraded collector suppresses its own term and
  // not the other's: a substrate whose graph reading failed still owes the rewrites its own
  // stored dependency sets prove.
  const marked = health.degraded.includes(HEALTH_COLLECTORS.graph)
    ? 0
    : health.graph.staleNarratives;
  const seal = health.narrativeSeal;
  const invalidated =
    health.degraded.includes(HEALTH_COLLECTORS.narrativeSeal) || seal.availability !== 'measured'
      ? 0
      : (seal.invalidatedHeads ?? 0);
  return Math.min(1, (marked + invalidated) / batch);
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

type ChunkRegrounding = {
  readonly examined: number;
  readonly stale: number;
  readonly republished: number;
};

/** Where the last pass stopped reading published heads. */
const HEAD_CURSOR_KEY = 'narrative-regrounding:head-cursor';

function readHeadCursor(db: SqliteHandle): HeadCursor | undefined {
  const summary = getLedgerEntry(db, HEAD_CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { captureKey, chunkId } = summary as { captureKey?: unknown; chunkId?: unknown };
  return typeof captureKey === 'string' && typeof chunkId === 'string' && chunkId !== ''
    ? { captureKey, chunkId }
    : undefined;
}

function writeHeadCursor(db: SqliteHandle, cursor: HeadCursor | undefined): void {
  markLedgerApplied(db, HEAD_CURSOR_KEY, cursor === undefined ? {} : { ...cursor });
}

/**
 * One bounded page of heads, resumed where the last run stopped, wrapping once at the end.
 *
 * A fixed front page is not continuation. Reading the first `batch` heads every run means a stale
 * head standing behind a page of current ones is never reached, however many times the pass runs —
 * twenty runs at a batch of one examine the same head twenty times. The cursor is the whole fix,
 * and it wraps inside the same run so a page that lands past the end still does the run's work
 * rather than spending it on an empty read.
 */
function headPage(
  db: SqliteHandle,
  batch: number,
): { heads: ReturnType<typeof publishedChunkHeads>; next: HeadCursor | undefined } {
  const resume = readHeadCursor(db);
  let heads = publishedChunkHeads(db, batch, resume);
  if (heads.length === 0 && resume !== undefined) {
    heads = publishedChunkHeads(db, batch);
  }
  const last = heads.at(-1);
  // A short page is the end of the walk: clearing the position sends the next run to the front
  // rather than leaving it parked past the last head forever.
  const next =
    heads.length < batch || last?.captureKey == null
      ? undefined
      : { captureKey: last.captureKey, chunkId: last.chunkId };
  return { heads, next };
}

/**
 * The chunk families whose published head no longer rests on what currently stands.
 *
 * Staleness is read from the head's own stored dependency set, through the verifier the
 * publication itself uses, so the two cannot disagree about what invalidation means. A head whose
 * set cannot be verified is left alone rather than rewritten: unreadable is not stale, and
 * rewriting on it would replace a standing account on the strength of a reading nobody took.
 */
async function regroundChunkFamilies(
  ctx: OperationContext,
  deps: NarrativeMaintenanceDeps,
  batch: number,
): Promise<ChunkRegrounding> {
  const { heads, next } = headPage(ctx.db, batch);
  writeHeadCursor(ctx.db, next);
  let stale = 0;
  let republished = 0;
  for (const head of heads) {
    if (ctx.signal.aborted || stale >= batch) {
      break;
    }
    const stored = storedRevision(head.evidenceRevisionJson);
    if (stored === undefined || verifyEvidenceRevision(ctx.db, stored).status !== 'stale') {
      continue;
    }
    stale += 1;
    const report = await publishChunkNarrative(
      {
        driver: ctx.driver,
        db: ctx.db,
        provider: ctx.provider,
        resolver: deps.resolver,
        publications: deps.publications,
        logger: ctx.logger,
      },
      head.chunkId,
      {
        now: ctx.now,
        model: ctx.config.models.reflect,
        timeoutMs: ctx.config.reflection.stageTimeoutMs,
        signal: ctx.signal,
      },
    );
    if (report.status === 'published') {
      republished += 1;
      continue;
    }
    ctx.logger.warn(
      { chunkId: head.chunkId, status: report.status },
      'invalidated chunk head was not regrounded on this run',
    );
  }
  return { examined: heads.length, stale, republished };
}

export function narrativeRegroundingOperation(batch: number): IntrospectionOperation {
  return {
    name: NARRATIVE_REGROUNDING_OPERATION,
    bucket: 'hour',
    relevance: (health) => narrativeRegroundingRelevance(health, batch),
    run: async (ctx): Promise<OperationOutcome> => {
      const chunks =
        ctx.narratives === undefined
          ? { examined: 0, stale: 0, republished: 0 }
          : await regroundChunkFamilies(ctx, ctx.narratives, batch);
      const report = await cleanupNarratives(
        {
          driver: ctx.driver,
          db: ctx.db,
          provider: ctx.provider,
          logger: ctx.logger,
          ...(ctx.narratives === undefined
            ? {}
            : { publications: ctx.narratives.publications, resolver: ctx.narratives.resolver }),
        },
        {
          limit: ctx.config.maintenance.narrativeCleanupBatch,
          model: ctx.config.models.reflect,
          timeoutMs: ctx.config.reflection.stageTimeoutMs,
          reflection: ctx.config.reflection,
          now: ctx.now,
        },
      );
      // Only a rewrite is an effect. A narrative left standing on proved support is the run
      // declining to touch a record that was never wrong, and one withheld is work it could not
      // do; counting either as affected would credit the operation for leaving things alone.
      const rewritten = report.regenerated + chunks.republished;
      return {
        status: rewritten === 0 ? 'noop' : 'applied',
        itemsProcessed: report.examined + chunks.examined,
        itemsAffected: rewritten,
        detail:
          `${String(chunks.republished)} of ${String(chunks.stale)} invalidated chunk head(s) ` +
          `regrounded from their stored dependencies across ${String(chunks.examined)} examined; ` +
          `${String(report.regenerated)} marked narrative(s) rewritten from the claims that are ` +
          `open now, ${String(report.held)} left standing on proved durable support, ` +
          `${String(report.withheld)} withheld for want of proof, ` +
          `${String(report.failed)} generation failure(s)`,
      };
    },
  };
}
