import type { Config } from '../../../infrastructure/config/schema.js';
import { rollUpNarratives } from '../../../reflection/application/narrative-rollup.js';
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
 */

export const DAY_ROLLUP_OPERATION = 'narrative_rollup_day';
export const WEEK_ROLLUP_OPERATION = 'narrative_rollup_week';

/**
 * The kill switch both scopes read, by name because the config schema does not carry it yet:
 * `maintenance.narrativeRollup` (`AION_MAINTENANCE_NARRATIVE_ROLLUP`). On by default, which is
 * what acting from day one means for an operation whose whole risk is reversible: every rollup
 * is a supersession, and `aion unsupersede` reopens any member it closed.
 */
export const NARRATIVE_ROLLUP_KNOB = 'narrativeRollup';
export const NARRATIVE_ROLLUP_ENV = 'AION_MAINTENANCE_NARRATIVE_ROLLUP';
const NARRATIVE_ROLLUP_DEFAULT = true;

/**
 * Windows one run compresses, standing in for `AION_MAINTENANCE_NARRATIVE_ROLLUP_WINDOWS`. Two
 * is a backlog that drains at a steady pace: each window is a model call and its review, and a
 * substrate with a month of unrolled days works through them a tick at a time.
 */
const ROLLUP_WINDOW_LIMIT = 2;

/**
 * No gauge in the snapshot counts windows waiting to be rolled up, so both scopes reach the
 * urgency threshold on waiting time, the standing cadence `narrative_cleanup` documents.
 */
export const NARRATIVE_ROLLUP_STANDING_RELEVANCE = 0.12;

function armed(config: Config): boolean {
  const maintenance = config.maintenance as unknown as Record<string, unknown>;
  const value = maintenance[NARRATIVE_ROLLUP_KNOB];
  return typeof value === 'boolean' ? value : NARRATIVE_ROLLUP_DEFAULT;
}

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
      if (!armed(ctx.config)) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: `narrative rollups disabled by ${NARRATIVE_ROLLUP_ENV}; no window examined`,
        };
      }

      const report = await rollUpNarratives(
        { driver: ctx.driver, provider: ctx.provider, logger: ctx.logger },
        {
          scope,
          model: ctx.config.models.reflect,
          timeoutMs: ctx.config.reflection.stageTimeoutMs,
          maxMemberChars: ctx.config.reflection.maxNarrativeEpisodeChars,
          windowLimit: ROLLUP_WINDOW_LIMIT,
          now: ctx.now,
          signal: ctx.signal,
        },
      );

      return {
        status: report.created === 0 ? 'noop' : 'applied',
        itemsProcessed: report.windows,
        itemsAffected: report.created,
        detail:
          `${String(report.windows)} closed ${scope} window(s): ${String(report.created)} rolled up ` +
          `over ${String(report.absorbed)} member narrative(s), ${String(report.skipped)} already covered, ` +
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
