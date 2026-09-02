import type { Config } from '../../../infrastructure/config/schema.js';
import { consolidateClaims } from '../../../reflection/application/claim-consolidation.js';
import { HEALTH_COLLECTORS, type HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * The subject axis of consolidation: many standing claims about one thing, compressed into the
 * one higher-order claim they add up to, with every sentence citing the claims it came from.
 *
 * It asks the community projection which claims belong together, and it asks the live
 * community-size distribution how dense a neighbourhood has to be before compressing it is
 * worth anything. Neither number is shipped. On a substrate whose communities have not been
 * projected yet the run says exactly that and writes nothing, which is what the first weeks of
 * a fresh graph look like.
 */

export const CLAIM_CONSOLIDATION_OPERATION = 'claim_consolidation';

/**
 * The kill switch, by name because the config schema does not carry it yet:
 * `maintenance.claimConsolidation` (`AION_MAINTENANCE_CLAIM_CONSOLIDATION`). On by default: the
 * write is a supersession like any other, and `aion unsupersede` reopens every claim it
 * absorbed.
 */
export const CLAIM_CONSOLIDATION_KNOB = 'claimConsolidation';
export const CLAIM_CONSOLIDATION_ENV = 'AION_MAINTENANCE_CLAIM_CONSOLIDATION';
const CLAIM_CONSOLIDATION_DEFAULT = true;

/**
 * No gauge counts claims waiting to be consolidated, so this runs on the standing cadence
 * `claim_dedup` uses for its own backlog, which is the reading it shares: the answer lives in
 * the graph, and finding it costs a read the tick was going to pay for anyway.
 */
export const CLAIM_CONSOLIDATION_STANDING_RELEVANCE = 0.1;

function armed(config: Config): boolean {
  const maintenance = config.maintenance as unknown as Record<string, unknown>;
  const value = maintenance[CLAIM_CONSOLIDATION_KNOB];
  return typeof value === 'boolean' ? value : CLAIM_CONSOLIDATION_DEFAULT;
}

export function claimConsolidationRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  return CLAIM_CONSOLIDATION_STANDING_RELEVANCE;
}

export function claimConsolidationOperation(): IntrospectionOperation {
  return {
    name: CLAIM_CONSOLIDATION_OPERATION,
    bucket: 'hour',
    relevance: claimConsolidationRelevance,
    run: async (ctx): Promise<OperationOutcome> => {
      if (!armed(ctx.config)) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: `claim consolidation disabled by ${CLAIM_CONSOLIDATION_ENV}; no subject examined`,
        };
      }

      const report = await consolidateClaims(
        { driver: ctx.driver, provider: ctx.provider, logger: ctx.logger },
        {
          model: ctx.config.models.reflect,
          timeoutMs: ctx.config.reflection.stageTimeoutMs,
          maxMemberChars: ctx.config.reflection.maxNarrativeEpisodeChars,
          now: ctx.now,
          signal: ctx.signal,
        },
      );

      return {
        status: report.created === 0 ? 'noop' : 'applied',
        itemsProcessed: report.candidates,
        itemsAffected: report.created,
        detail: report.detail,
      };
    },
  };
}
