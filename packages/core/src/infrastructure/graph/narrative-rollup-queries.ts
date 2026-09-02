import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { NARRATIVE_PROPERTIES } from './narrative-queries.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphInteger, type Row } from './values.js';

/**
 * The reads the day and week rollups need: the standing narratives of the scope below, and the
 * versions a window already carries. Both are narrow on purpose. A rollup writes through the
 * ordinary stamped-node, edge-upsert and supersede adapters, exactly as a session narrative
 * does, so nothing here writes anything.
 */

/** The window a rollup covers, as the scope's own key: `2026-04-02` for a day, `2026-W14` for a week. */
export const ROLLUP_WINDOW_PROPERTY = 'window_key';

export type RollupMemberRow = {
  readonly id: string;
  readonly text: string;
  readonly summary?: string;
  readonly occurredAt?: Date;
};

function asOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The narratives of one scope that a window is made of, oldest first. Standing ones, plus the
 * ones a rollup of the scope above already absorbed: a window's membership is what happened in
 * it, so a day that gains a fifth session narrative must re-version over all five rather than
 * over the one the rollup has not seen. A narrative a later version of its own scope superseded
 * is not in the set, because the version that replaced it is.
 */
const FIND_ROLLUP_MEMBERS = [
  'MATCH (n:Narrative)',
  `WHERE n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `  AND n.${NARRATIVE_PROPERTIES.scope} = $scope`,
  `  AND (n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  `       OR EXISTS { (r:Narrative)-[:${SUPERSEDES_TYPE}]->(n)`,
  `                   WHERE r.${NARRATIVE_PROPERTIES.scope} = $rollupScope })`,
  'RETURN',
  '  n.id AS id,',
  `  n.${MEMORY_PROPERTIES.text} AS text,`,
  `  n.${MEMORY_PROPERTIES.summary} AS summary,`,
  `  n.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at`,
  `ORDER BY n.${BITEMPORAL_PROPERTIES.occurredAt}, n.id`,
  'LIMIT $limit',
].join('\n');

export type RollupMemberInput = {
  /** The scope being rolled up, which is the one below the rollup's own. */
  readonly scope: string;
  /** The rollup's own scope, which is what tells an absorbed member from a re-versioned one. */
  readonly rollupScope: string;
  readonly limit: number;
};

export async function findRollupMembers(
  driver: Driver,
  input: RollupMemberInput,
): Promise<RollupMemberRow[]> {
  if (input.limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_ROLLUP_MEMBERS,
    {
      scope: input.scope,
      rollupScope: input.rollupScope,
      limit: toGraphInteger(input.limit),
    },
    (row: Row) => {
      const summary = asOptionalText(row.summary);
      const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : undefined;
      return {
        id: row.id as string,
        text: typeof row.text === 'string' ? row.text : '',
        ...(summary === undefined ? {} : { summary }),
        ...(occurredAt === undefined ? {} : { occurredAt }),
      };
    },
  );
}

export type WindowNarrative = {
  readonly id: string;
  readonly version: number;
  readonly coverageKey: string;
  readonly coverageCount: number;
  /** `valid_until` absent: this version has not been superseded by a later one. */
  readonly open: boolean;
};

/**
 * Every version one window carries, newest first, each marked open or superseded. Currency is
 * deliberately not filtered here, for the reason the session version read does not filter it:
 * the versioning decision turns on whether a version has been closed, which is a fact about the
 * node rather than a judgment against a reference time.
 */
const FIND_WINDOW_ROLLUPS = [
  `MATCH (n:Narrative { ${NARRATIVE_PROPERTIES.scope}: $scope, ${ROLLUP_WINDOW_PROPERTY}: $windowKey })`,
  `WHERE n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  'RETURN',
  '  n.id AS id,',
  `  n.${NARRATIVE_PROPERTIES.version} AS version,`,
  `  n.${NARRATIVE_PROPERTIES.coverageKey} AS coverage_key,`,
  `  n.${NARRATIVE_PROPERTIES.coverageCount} AS coverage_count,`,
  `  n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AS open`,
  `ORDER BY n.${NARRATIVE_PROPERTIES.version} DESC, n.id`,
].join('\n');

export async function findWindowRollups(
  driver: Driver,
  scope: string,
  windowKey: string,
): Promise<WindowNarrative[]> {
  return runRead(driver, FIND_WINDOW_ROLLUPS, { scope, windowKey }, (row: Row) => ({
    id: row.id as string,
    version: typeof row.version === 'number' ? row.version : 0,
    coverageKey: typeof row.coverage_key === 'string' ? row.coverage_key : '',
    coverageCount: typeof row.coverage_count === 'number' ? row.coverage_count : 0,
    open: row.open === true,
  }));
}
