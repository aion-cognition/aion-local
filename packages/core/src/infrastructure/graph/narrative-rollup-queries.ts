import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { NARRATIVE_PROPERTIES, SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphDateTime, toGraphInteger, type Row } from './values.js';

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
  // Where the last page stopped, in the order this query returns. A fixed front page reads the
  // same members every run, so a window behind a page of members nothing can compress is never
  // reached however many times the pass runs.
  `  AND ($afterOccurredAt IS NULL`,
  `       OR n.${BITEMPORAL_PROPERTIES.occurredAt} > $afterOccurredAt`,
  `       OR (n.${BITEMPORAL_PROPERTIES.occurredAt} = $afterOccurredAt AND n.id > $afterId))`,
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

/** Where a member page resumes, in the order the query returns. */
export type RollupMemberCursor = {
  readonly occurredAt: Date;
  readonly id: string;
};

export type RollupMemberInput = {
  /** The scope being rolled up, which is the one below the rollup's own. */
  readonly scope: string;
  /** The rollup's own scope, which is what tells an absorbed member from a re-versioned one. */
  readonly rollupScope: string;
  readonly limit: number;
  readonly after?: RollupMemberCursor;
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
      afterOccurredAt: input.after === undefined ? null : toGraphDateTime(input.after.occurredAt),
      afterId: input.after?.id ?? null,
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

/**
 * How far the representation ancestry of a window member is walked.
 *
 * A calendar summary holds the narratives it compressed, and the scope below it holds theirs, so
 * two hops reach the session narratives underneath a week's day summaries. The hop after that
 * lands on episodes, which carry no representation family of their own.
 */
const LINEAGE_DEPTH = 2;

export type RollupLineage = {
  readonly id: string;
  readonly ancestors: readonly string[];
  /** The walk stopped at the caller's proof bound, so these are not all of them. */
  readonly bounded: boolean;
};

/**
 * The narratives a member compressed, which is what a reader has to ask about before that member
 * is published into something new or absorbed.
 *
 * Membership is the summarization edge rather than the stored citation list: a citation names
 * what the prose quoted, and a member the renderer did not quote is still one the summary covers.
 * Currency is deliberately not filtered. An absorbed member stays part of what its summary rests
 * on, and a walk that skipped the closed ones would report a calendar summary as resting on
 * nothing at all.
 */
const FIND_ROLLUP_LINEAGE = [
  'UNWIND $ids AS wanted',
  'MATCH (n:Narrative { id: wanted })',
  'CALL { WITH n',
  `  MATCH (a:Narrative)-[:${SUMMARIZED_BY_TYPE}*1..${String(LINEAGE_DEPTH)}]->(n)`,
  '  WITH DISTINCT a.id AS id ORDER BY id LIMIT $limit',
  '  RETURN collect(id) AS ancestors',
  '}',
  'RETURN n.id AS id, ancestors',
].join('\n');

/** Reads the complete ancestry of each member, or one sentinel past the caller's bound. */
export async function findRollupLineage(
  driver: Driver,
  ids: readonly string[],
  bound: number,
): Promise<readonly RollupLineage[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || bound <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_ROLLUP_LINEAGE,
    { ids: unique, limit: toGraphInteger(bound + 1) },
    (row: Row) => {
      const ancestors = Array.isArray(row.ancestors) ? (row.ancestors as string[]) : [];
      return {
        id: row.id as string,
        ancestors: ancestors.slice(0, bound),
        bounded: ancestors.length > bound,
      };
    },
  );
}

export type NarrativeBody = {
  readonly id: string;
  readonly text: string;
  readonly summary?: string;
  readonly occurredAt?: Date;
};

/**
 * The prose of named revisions, for a render whose MEMBERSHIP came from the manifest.
 *
 * Two stores, two questions. Which revisions a window is made of is a question about the records
 * and is answered there; what those revisions SAY is held on the node, and this is the only thing
 * the graph is asked. A member the graph cannot produce is absent from the answer rather than
 * rendered empty, so a caller can refuse the window instead of publishing a hole in it.
 */
const FIND_NARRATIVE_BODIES = [
  'UNWIND $ids AS id',
  'MATCH (n:Narrative { id: id })',
  `WHERE n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  'RETURN',
  '  n.id AS id,',
  `  n.${MEMORY_PROPERTIES.text} AS text,`,
  `  n.${MEMORY_PROPERTIES.summary} AS summary,`,
  `  n.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at`,
].join('\n');

export async function findNarrativeBodies(
  driver: Driver,
  ids: readonly string[],
): Promise<Map<string, NarrativeBody>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await runRead(driver, FIND_NARRATIVE_BODIES, { ids: unique }, (row: Row) => {
    const summary = asOptionalText(row.summary);
    const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : undefined;
    return {
      id: row.id as string,
      text: typeof row.text === 'string' ? row.text : '',
      ...(summary === undefined ? {} : { summary }),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    };
  });
  return new Map(rows.map((row) => [row.id, row] as const));
}
