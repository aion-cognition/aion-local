import { rollUpNarratives } from '../../../reflection/application/narrative-rollup.js';
import { rollUpOverviews } from '../../../reflection/application/overview-rollup.js';
import type { RollupScope } from '../../../reflection/domain/rollup.js';
import { HEALTH_COLLECTORS, type HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * The two scopes above a session, as maintenance. A session narrative is written by the close
 * that ends the session; nothing before this compressed the day those sessions made up, or the
 * week those days made up, so a month of work reached recall as a hundred separate stories.
 *
 * Each scope rolls up the one below it and closes what it absorbed, which is the same act a
 * second session narrative already performs over the first. Both find nothing on a young
 * substrate: a day rollup needs a day that has ended with narratives in it. That is the designed
 * answer rather than a reason to hold the operation back, and it starts working the moment the
 * history exists.
 *
 * Acting from day one, gated by the `narrativeRollup` kill switch both scopes read. The risk is
 * reversible either way: every rollup is a supersession, and `aion unsupersede` reopens any
 * member it closed.
 */

export const DAY_ROLLUP_OPERATION = 'narrative_rollup_day';
export const WEEK_ROLLUP_OPERATION = 'narrative_rollup_week';

/**
 * No gauge in the snapshot counts windows waiting to be rolled up, so both scopes reach the
 * urgency threshold on waiting time, the standing cadence `narrative_cleanup` documents.
 */
export const NARRATIVE_ROLLUP_STANDING_RELEVANCE = 0.12;

function rollupRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  return NARRATIVE_ROLLUP_STANDING_RELEVANCE;
}

function narrativeRollupOperation(
  name: string,
  scope: RollupScope,
  bucket: 'hour' | 'day',
): IntrospectionOperation {
  return {
    name,
    bucket,
    relevance: rollupRelevance,
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.narrativeRollup) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail:
            'narrative rollups disabled by AION_MAINTENANCE_NARRATIVE_ROLLUP; no window examined',
        };
      }

      // The signed family first: windows the manifest names, published through the coordinator.
      // The legacy pass below still serves the whole-session family until its cutover retires it.
      const overviews =
        ctx.narratives === undefined
          ? undefined
          : await rollUpOverviews(
              {
                driver: ctx.driver,
                db: ctx.db,
                provider: ctx.provider,
                publications: ctx.narratives.publications,
                logger: ctx.logger,
              },
              {
                scope,
                now: ctx.now,
                windowLimit: ctx.config.maintenance.narrativeRollupWindows,
                renderedInputAllowance: ctx.config.maintenance.chunkRenderedInputAllowance,
                model: ctx.config.models.reflect,
                timeoutMs: ctx.config.reflection.stageTimeoutMs,
                signal: ctx.signal,
              },
            );

      const report = await rollUpNarratives(
        { driver: ctx.driver, db: ctx.db, provider: ctx.provider, logger: ctx.logger },
        {
          scope,
          model: ctx.config.models.reflect,
          timeoutMs: ctx.config.reflection.stageTimeoutMs,
          reflection: ctx.config.reflection,
          windowLimit: ctx.config.maintenance.narrativeRollupWindows,
          renderedInputAllowance: ctx.config.maintenance.chunkRenderedInputAllowance,
          now: ctx.now,
          signal: ctx.signal,
        },
      );

      const overviewDetail =
        overviews === undefined
          ? 'no publisher composed for the overview family'
          : `${String(overviews.published)} of ${String(overviews.windows)} closed ${scope} ` +
            `window(s) published, ${String(overviews.settled)} already settled, ` +
            `${String(overviews.blocked)} refused, ${String(overviews.reconsidered)} ` +
            `reconsidered, ${String(overviews.failed)} failed, ` +
            `${String(overviews.unplaceable)} chunk(s) no window could be derived for`;
      const published = overviews?.published ?? 0;
      return {
        status: report.created + published === 0 ? 'noop' : 'applied',
        itemsProcessed: report.windows + (overviews?.windows ?? 0),
        itemsAffected: report.created + published,
        detail:
          `${overviewDetail}; legacy: ` +
          `${String(report.windows)} closed ${scope} window(s): ${String(report.created)} rolled up ` +
          `over ${String(report.absorbed)} member narrative(s), ${String(report.skipped)} already covered, ` +
          `${String(report.blocked)} blocked for capacity or incomplete membership, ` +
          `${String(report.vetoed)} vetoed by review, ${String(report.failed)} generation failure(s)`,
      };
    },
  };
}

/** Hourly, so a day that closed while the substrate was busy is compressed on the next quiet tick. */
export function dayNarrativeRollupOperation(): IntrospectionOperation {
  return narrativeRollupOperation(DAY_ROLLUP_OPERATION, 'day', 'hour');
}

/** Daily: a week closes once a week, and looking for one more often buys nothing. */
export function weekNarrativeRollupOperation(): IntrospectionOperation {
  return narrativeRollupOperation(WEEK_ROLLUP_OPERATION, 'week', 'day');
}
