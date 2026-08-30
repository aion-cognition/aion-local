import { describeError } from '../../../infrastructure/errors.js';
import {
  findAffectedNodeIds,
  findNeighborContentVectors,
  writeContextVectors,
} from '../../../infrastructure/graph/context-vector-queries.js';
import { computeContextVectors } from '../../domain/context-vector.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * The pipeline's last stage: recompute `context_vec` on every `:Memory` node this run's
 * enrichment touched, from the current strength-weighted neighborhood of each. Deliberately
 * the only stage with a top-level `try`/`catch` around its whole body, because this operation
 * is eventually consistent: a failure here leaves affected nodes with stale context vectors
 * for the next successful run rather than costing the run its ledger mark.
 */
export class ContextVectorStage implements ReflectionStage {
  readonly name = 'context-vectors';

  async run(ctx: StageContext): Promise<StageOutcome> {
    try {
      const affectedIds = await findAffectedNodeIds(ctx.driver, ctx.episodeId);
      if (affectedIds.length === 0) {
        return { status: 'skipped', summary: 'no affected memory nodes to recompute' };
      }

      const neighbors = await findNeighborContentVectors(ctx.driver, affectedIds);
      const computed = computeContextVectors(neighbors);
      if (computed.length === 0) {
        return { status: 'skipped', summary: 'no affected node has a vectored neighbor' };
      }

      const written = await writeContextVectors(ctx.driver, computed);
      return {
        status: 'ok',
        summary: `recomputed context_vec for ${written.length} of ${affectedIds.length} affected node(s)`,
        counts: { contextVectors: written.length },
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
