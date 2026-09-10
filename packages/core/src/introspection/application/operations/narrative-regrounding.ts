import type { NarrativeMaintenanceDeps } from './narrative-seal.js';
import { verifyEvidenceRevision } from '../../../evidence/application/dependencies.js';
import type { EvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { publishedChunkHeads } from '../../../infrastructure/sqlite/chunk-nomination.js';
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
 * TWO FAMILIES, TWO WAYS OF KNOWING. The legacy whole-session narrative carries a grounding marker
 * an apply stamps, and `findStaleNarratives` selects on it. A chunk revision carries something
 * better: the dependency set it was published on, stored with it, so what invalidated it is a
 * question the records answer exactly rather than a marker somebody had to remember to stamp. The
 * chunk pass reads that set through the same verifier the publication uses, and regrounds the
 * exact heads it finds stale through the same publication path — no whole-session rewrite for a
 * chunk, and no second synthesis path.
 *
 * It declares no metric. The one it used to declare counted the legacy graph marker, which is a
 * number about the family this operation is leaving rather than the population it now repairs; a
 * new baseline has to exist before runs over the new population can be scored, and the old count
 * is not that baseline. Recorded runs stay exactly as they were — they were true under the
 * interpretation that made them — and the parked sample is dropped by the scoring pass that
 * notices the metric is gone.
 */

export const NARRATIVE_REGROUNDING_OPERATION = 'narrative_regrounding';

/**
 * Relevance divides the backlog by the batch a run actually rewrites, bound where the operation
 * is constructed. It used to divide by the shipped default because the contract hands relevance
 * only the health snapshot: an operator who halved the batch then doubled how long the same
 * backlog took and changed nothing about how urgently the loop asked for it.
 */
export function narrativeRegroundingRelevance(health: HealthSnapshot, batch: number): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph) || batch <= 0) {
    return 0;
  }
  return Math.min(1, health.graph.staleNarratives / batch);
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
  const heads = publishedChunkHeads(ctx.db, batch);
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
        { driver: ctx.driver, db: ctx.db, provider: ctx.provider, logger: ctx.logger },
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
          `${String(report.regenerated)} legacy narrative(s) rewritten from the claims that are ` +
          `open now, ${String(report.held)} left standing on proved durable support, ` +
          `${String(report.withheld)} withheld for want of proof, ` +
          `${String(report.failed)} generation failure(s)`,
      };
    },
  };
}
