import { describeError } from '../../../infrastructure/errors.js';
import {
  findAffectedNodeIds,
  findEdgeTouchedNeighborIds,
} from '../../../infrastructure/graph/context-vector-queries.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';
import { publishContextVectorSync } from '../context-vector-sync.js';

/**
 * The pipeline's last stage: recompute `context_vec` on every `:Memory` node this run's
 * enrichment touched, from the current strength-weighted neighborhood of each. Deliberately
 * the only stage with a top-level `try`/`catch` around its whole body, because this operation
 * is eventually consistent: a failure here leaves affected nodes with stale context vectors
 * for the next successful run rather than costing the run its ledger mark.
 *
 * The set is closed over the run's own edge writes before anything is computed. An edge moves
 * the context of both its endpoints, and an earlier stage writes plenty of edges whose far end
 * belongs to some other episode: an entity this run linked to one it deduplicated against, a
 * fact it superseded. Recomputing only the episode's family leaves that far end holding a
 * vector for a neighborhood it no longer has, and nothing downstream can tell a stale context
 * vector from a current one.
 *
 * The write itself is `context_vector_sync`. This stage used to be the one writer of the served
 * property that recorded no sync stamp, which left the maintenance scan unable to tell a node
 * this stage had just recomputed from one nothing had ever looked at — so the two passes could
 * each believe the other owned a node neither had. Publishing is also what gives a stage whose
 * whole contract is "the graph is the memory" a durable record of which nodes it moved.
 *
 * A node the guard could not certify comes back as a hold, not a write and not a stamp, which
 * leaves it in the staleness scan's population. That is the intended handoff: this stage runs
 * once per episode, and the scan is what runs again.
 */
export class ContextVectorStage implements ReflectionStage {
  readonly name = 'context-vectors';

  async run(ctx: StageContext): Promise<StageOutcome> {
    // Fail closed and loudly, the way narration does. A pipeline composed without a coordinator
    // cannot write this property at all any more, and a stage that quietly returned `ok` would
    // report a recomputation that never happened on every run.
    if (ctx.publications === undefined) {
      return {
        status: 'failed',
        summary: 'context vector recomputation is not composed: no publication coordinator',
      };
    }
    try {
      const affectedIds = await findAffectedNodeIds(ctx.driver, ctx.episodeId, ctx.now);
      if (affectedIds.length === 0) {
        return {
          status: 'skipped',
          summary: 'no affected memory nodes to recompute',
          retryable: true,
          settledOnUpstream: {
            disposition: 'not_applicable',
            reason: 'proved_empty_input',
            proof: { affectedNodes: 0 },
          },
        };
      }

      const touchedIds = await findEdgeTouchedNeighborIds(ctx.driver, affectedIds, ctx.now);
      const recomputeIds = [...new Set([...affectedIds, ...touchedIds])];

      const outcome = await publishContextVectorSync(
        {
          driver: ctx.driver,
          db: ctx.db,
          publications: ctx.publications,
          now: ctx.now,
        },
        {
          basis: 'enrichment',
          subject: ctx.episodeId,
          members: recomputeIds.map((id) => ({ id, workId: null })),
        },
      );
      if (outcome.status !== 'published') {
        return {
          status: 'failed',
          summary: `context vector recomputation was refused: ${outcome.reason}`,
        };
      }
      const { recomputed, cleared, stamped, holds } = outcome.result;
      const written = recomputed.length + cleared.length + stamped.length;
      return {
        status: 'ok',
        summary:
          `recomputed context_vec for ${String(recomputed.length)} of ` +
          `${String(recomputeIds.length)} affected node(s), ${String(cleared.length)} cleared, ` +
          `${String(stamped.length)} unweighted, ${String(holds.length)} held`,
        counts: { contextVectors: written },
      };
    } catch (error) {
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId },
        'context vector recomputation failed; affected nodes keep their stale context_vec',
      );
      return {
        status: 'failed',
        summary: `context vector recomputation failed: ${describeError(error)}`,
      };
    }
  }
}
