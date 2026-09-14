import type { Driver } from 'neo4j-driver';

import { readSenseEvidence } from './senses/index.js';
import type { Config } from '../../infrastructure/config/schema.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listRecentInsights } from '../../infrastructure/sqlite/introspection-insights.js';
import { recentModelLessons } from '../../infrastructure/sqlite/introspection-model-lessons.js';

/**
 * Everything `consultTier3` hands the advisor beside the health reading, gathered in one place
 * so `engine.ts` stays about the tick loop rather than about three independent store reads.
 * Every read here is guarded on its own: a store that cannot answer costs the prompt that one
 * section and never the consultation itself.
 */

export type Tier3EvidenceDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
};

export type Tier3Evidence = {
  readonly insights: readonly string[];
  readonly senseEvidence: readonly string[];
  readonly lessons: readonly string[];
};

/** The run ledger's own numbers, restated as lines. Read by the model as a measurement. */
function readInsights(deps: Tier3EvidenceDeps): readonly string[] {
  try {
    return listRecentInsights(deps.db, deps.config.maintenance.tier3InsightCount).map(
      (insight) => `${insight.recordedAt}: ${insight.operation} ${insight.lesson}`,
    );
  } catch (err) {
    deps.logger.warn({ err }, 'introspection insight read failed');
    return [];
  }
}

/**
 * The model's own past interpretations of the sense evidence, oldest first, each carrying the
 * reference that resolves what it was drawn from.
 *
 * The line used to be the lesson text alone, which left the prompt with an interpretation and no
 * way back to its basis: not the cycle's evidence, not the digest, nothing. The row's id, cycle
 * and evidence digest are enough to find the stored snapshot, and the retained-line count says
 * how much of the basis that snapshot holds.
 */
function readModelLessons(deps: Tier3EvidenceDeps): readonly string[] {
  try {
    return recentModelLessons(deps.db, deps.config.maintenance.tier3InsightCount).map((entry) => {
      const basis =
        entry.senseEvidenceDigest === undefined
          ? 'no sense evidence was shown on that cycle'
          : `drawn from sense evidence ${entry.senseEvidenceDigest}, ` +
            `${String(entry.senseEvidence?.length ?? 0)} line(s) retained on the row`;
      return (
        `${entry.recordedAt}: ${entry.operation} ${entry.lesson} ` +
        `[lesson #${String(entry.id)}, cycle ${String(entry.cycle)}; ${basis}]`
      );
    });
  } catch (err) {
    deps.logger.warn({ err }, 'introspection model-lesson read failed');
    return [];
  }
}

export async function gatherTier3Evidence(
  deps: Tier3EvidenceDeps,
  now: Date,
): Promise<Tier3Evidence> {
  let senseEvidence: readonly string[] = [];
  try {
    senseEvidence = await readSenseEvidence(deps.driver, deps.db, now, deps.logger);
  } catch (err) {
    deps.logger.warn({ err }, 'introspection sense evidence read failed');
  }
  return {
    insights: readInsights(deps),
    senseEvidence,
    lessons: readModelLessons(deps),
  };
}
