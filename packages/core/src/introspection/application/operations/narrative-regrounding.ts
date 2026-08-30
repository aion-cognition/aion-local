import { reflectProvider, type ProviderFactory } from './routed-generation.js';
import { cleanupNarratives } from '../../../reflection/application/narrative-cleanup.js';
import { HEALTH_COLLECTORS, type HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * Rewrites a narrative that no longer matches the claims underneath it.
 *
 * A narrative compresses a session's claims into prose, and it carries no supersession lineage
 * of its own: closing the claim it was written from leaves the narrative standing, marked
 * current, restating the correction's own subject with the old value, and a pack serves it
 * beside the replacement. Two contradictory sentences, both current, is the worst answer the
 * substrate can give.
 *
 * The repair already existed as a hand-run tool. What was missing was anything that ran it:
 * `findStaleNarratives` selects on the grounding revision, and a correction does not change
 * one. An apply now stamps the affected narratives with a marker that is not the current
 * revision, which is what this operation drains.
 */

export const NARRATIVE_REGROUNDING_OPERATION = 'narrative_regrounding';

/** Mirrors `maintenance.narrativeCleanupBatch`'s own default; see `defaults.ts` for why. */
const DEFAULT_NARRATIVE_BATCH = 10;

export type NarrativeRegroundingOverrides = {
  readonly buildProvider?: ProviderFactory;
};

export function narrativeRegroundingRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  return Math.min(1, health.graph.staleNarratives / DEFAULT_NARRATIVE_BATCH);
}

export function narrativeRegroundingOperation(
  overrides: NarrativeRegroundingOverrides = {},
): IntrospectionOperation {
  const buildProvider = overrides.buildProvider ?? reflectProvider;

  return {
    name: NARRATIVE_REGROUNDING_OPERATION,
    bucket: 'hour',
    relevance: narrativeRegroundingRelevance,
    measure: (health) => health.graph.staleNarratives,
    improves: 'lower',
    run: async (ctx): Promise<OperationOutcome> => {
      const report = await cleanupNarratives(
        { driver: ctx.driver, provider: buildProvider(ctx.config), logger: ctx.logger },
        {
          limit: ctx.config.maintenance.narrativeCleanupBatch,
          model: ctx.config.models.reflect,
          timeoutMs: ctx.config.reflection.narrativeTimeoutMs,
          maxSourceEpisodes: ctx.config.reflection.maxNarrativeEpisodes,
          maxEpisodeChars: ctx.config.reflection.maxNarrativeEpisodeChars,
          now: ctx.now,
        },
      );
      const affected = report.regenerated + report.forgotten;
      return {
        status: affected === 0 ? 'noop' : 'applied',
        itemsProcessed: report.examined,
        itemsAffected: affected,
        detail:
          `${String(report.regenerated)} narrative(s) rewritten from the claims that are open now, ` +
          `${String(report.forgotten)} forgotten for want of a session to ground them, ` +
          `${String(report.failed)} generation failure(s)`,
      };
    },
  };
}
