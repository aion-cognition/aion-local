import { enqueueReinforcementSignal } from '../../../infrastructure/sqlite/reinforcement-queue.js';
import { findCoExtractedNodeIds } from '../../../infrastructure/graph/reinforcement-queries.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * Whitepaper §7.1, Algorithm 5 integration: enqueue Hebbian reinforcement signals for
 * entities and cognitive structures co-extracted from the same episode (nodes sharing this
 * episode via MENTIONS, PARTICIPATES_IN, or EXTRACTED_FROM edges). The 0.3× factor against
 * the default Hebbian learning rate (η = 0.1) is applied at flush time (P4), not here —
 * the signal queue row is durable truth, flush determines semantics per trigger string.
 */

export const REINFORCEMENT_STAGE_NAME = 'reinforcement';

/** Trigger identifier recorded in the queue; flush-time semantics document the factor. */
export const REFLECTION_CO_EXTRACTION_TRIGGER = 'reflection:co-extraction';

/**
 * Constraint: P4's reinforcement flush uses this trigger string to apply 0.3× the base η
 * (η_base = 0.1 → η_reflection = 0.03) from Algorithm 5. The reinforcement stage enqueues
 * rows without applying the factor; the factor contract lives in the flush operation.
 */

export class ReinforcementEnqueueStage implements ReflectionStage {
  readonly name = REINFORCEMENT_STAGE_NAME;

  async run(ctx: StageContext): Promise<StageOutcome> {
    const nodeIds = await findCoExtractedNodeIds(ctx.driver, ctx.episodeId);

    if (nodeIds.length === 0) {
      return { status: 'skipped', summary: 'no entities or cognitive nodes extracted' };
    }

    if (nodeIds.length === 1) {
      return { status: 'ok', summary: 'one node extracted; no pairs to reinforce' };
    }

    // Deterministic pair order: sort so (a,b) never also enqueues (b,a). For each pair [i, j]
    // where i < j (after sorting), enqueue one signal from i to j.
    const sorted = [...nodeIds].sort();
    const enqueuedAt = ctx.now.toISOString();
    let count = 0;
    for (let index = 0; index < sorted.length; index += 1) {
      const source = sorted[index];
      if (source === undefined) {
        continue;
      }
      for (let other = index + 1; other < sorted.length; other += 1) {
        const target = sorted[other];
        if (target === undefined) {
          continue;
        }
        enqueueReinforcementSignal(
          ctx.db,
          source,
          target,
          REFLECTION_CO_EXTRACTION_TRIGGER,
          enqueuedAt,
        );
        count += 1;
      }
    }

    return {
      status: 'ok',
      summary: `${count} co-extraction reinforcement signal(s) enqueued`,
      counts: { reinforcements: count },
    };
  }
}
