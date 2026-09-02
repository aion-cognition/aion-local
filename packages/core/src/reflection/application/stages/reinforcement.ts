import { randomUUID } from 'node:crypto';

import { findCoExtractedNodeIds } from '../../../infrastructure/graph/reinforcement-queries.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  DEFAULT_REINFORCEMENT_QUEUE_CAP,
  enqueueReinforcementSignal,
} from '../../../infrastructure/sqlite/reinforcement-queue.js';
import { REFLECTION_CO_EXTRACTION_TRIGGER } from '../../../plasticity/domain/reinforcement.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * Enqueue Hebbian reinforcement signals for entities and cognitive structures co-extracted
 * from the same episode (nodes sharing this episode via MENTIONS or EXTRACTED_FROM edges).
 * The flush rate is this stage's row in `TRIGGER_POLICIES`, which carries a factor and a clique
 * discount together, so a wide episode moves each of its pairs less than a narrow one does.
 * This stage enqueues rows without applying either: the queue row is durable truth, and flush
 * determines semantics per trigger string.
 */

export const REINFORCEMENT_STAGE_NAME = 'reinforcement';

/**
 * Trigger identifier recorded in the queue; flush-time semantics document the factor. The
 * string lives with the policy table that reads it, so the producer and the flush cannot drift.
 */
export { REFLECTION_CO_EXTRACTION_TRIGGER };

/**
 * The episode-scoped gate, in the shape association inference already uses. A queue row is a
 * fresh uuid with no uniqueness constraint behind it, so without this the orchestrator's
 * crash-before-ledger-mark window doubles every pair the episode produced, and the flush
 * reinforces each of them twice.
 *
 * The pipeline version forks the key: a run under new extraction rules co-extracts a different
 * node set and owes the queue its own signals.
 */
export function coExtractionLedgerKey(pipelineVersion: string, episodeId: string): string {
  return `reinforcement.co_extraction:${pipelineVersion}:${episodeId}`;
}

export type ReinforcementEnqueueStageOptions = {
  readonly reinforcementQueueCap?: number;
};

export class ReinforcementEnqueueStage implements ReflectionStage {
  readonly name = REINFORCEMENT_STAGE_NAME;
  readonly #reinforcementQueueCap: number;

  constructor(options: ReinforcementEnqueueStageOptions = {}) {
    this.#reinforcementQueueCap = options.reinforcementQueueCap ?? DEFAULT_REINFORCEMENT_QUEUE_CAP;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const key = coExtractionLedgerKey(ctx.pipelineVersion, ctx.episodeId);
    if (isLedgerApplied(ctx.db, key)) {
      return { status: 'skipped', summary: 'co-extraction signals already enqueued' };
    }

    const nodeIds = await findCoExtractedNodeIds(ctx.driver, ctx.episodeId, ctx.now);

    if (nodeIds.length === 0) {
      return {
        status: 'skipped',
        summary: 'no entities or cognitive nodes extracted',
        retryable: true,
      };
    }

    if (nodeIds.length === 1) {
      return { status: 'ok', summary: 'one node extracted; no pairs to reinforce' };
    }

    // Deterministic pair order: sorted, so (a,b) never also enqueues (b,a).
    const sorted = [...nodeIds].sort();
    const enqueuedAt = ctx.now.toISOString();
    // One id per run, so a second producer stamping the same trigger in the same millisecond
    // stays its own burst and the flush discounts each as the clique it actually was.
    const burstId = randomUUID();
    let count = 0;
    // The burst and its ledger key commit together. A throw partway through the loop otherwise
    // leaves the written prefix behind, and the retry enqueues those pairs again under a fresh
    // timestamp, which the flush reads as a second burst rather than as the same one.
    ctx.db
      .transaction(() => {
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
              this.#reinforcementQueueCap,
              burstId,
            );
            count += 1;
          }
        }

        markLedgerApplied(ctx.db, key, { pairs: count });
      })
      .immediate();

    return {
      status: 'ok',
      summary: `${count} co-extraction reinforcement signal(s) enqueued`,
      counts: { reinforcements: count },
    };
  }
}
