import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  publishedScopeToken,
  scopeSupportsVerifiedEmpty,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { durableRoleScope, nodeScopeDirection, type DurableRole } from '../domain/scopes.js';

/**
 * The counter populations, read from the incidence records rather than from a stored number.
 *
 * Every count here is over the committed logical population: which SOURCE OCCURRENCES stand behind
 * a node, not which graph edges survive next to it. That is the whole point of the cut. An evicted
 * source still counts, a duplicate edge does not count twice, and a node whose raw containers are
 * gone reads exactly as one whose containers are resident.
 *
 * A missing census is never zero. Each population is gated on the scope the count is derived from
 * carrying an established census, and a scope nobody has counted returns `unavailable` with the
 * reason. An empty certified union may be zero; an uncounted one may not.
 *
 * The counter policies are deliberately different from one another and the differences are the
 * contract: the seed count filters to logically current sources, description growth does not, and
 * identifier decay adds the edge-currency filter and its own recorded clock. Collapsing them into
 * one query is what made the old graph counts disagree with each other.
 */

export type LogicalCount =
  | {
      readonly status: 'counted';
      readonly count: number;
      /** The published scope token the count rests on, for a writer that fences on it. */
      readonly token: string;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * The newest committed state of ONE family, and whether it is the closing one.
 *
 * Forget and suppression are separate chains with separate reversals. Reading the newest event
 * across both would let an unsuppress cancel an independent forget, which is a source coming back
 * because somebody undid a different statement about it.
 *
 * `NOT EXISTS` over the newest row of the family rather than a scalar comparison: a source with no
 * state row has no newest state, and comparing that absent value would make the whole predicate
 * null and quietly drop every source that was never forgotten.
 */
function familyIsOpen(closing: string, opening: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM source_state_versions f
    JOIN publication_intents fi ON fi.operation_id = f.operation_id AND fi.state = 'acknowledged'
    WHERE f.source_id = s.source_id AND f.known_from IS NOT NULL
      AND f.state_kind = '${closing}'
      AND f.version = (
        SELECT MAX(g.version) FROM source_state_versions g
        JOIN publication_intents gi
          ON gi.operation_id = g.operation_id AND gi.state = 'acknowledged'
        WHERE g.source_id = f.source_id AND g.known_from IS NOT NULL
          AND g.state_kind IN ('${closing}', '${opening}')
      )
  )`;
}

/** A source is logically current when neither of its two state chains is closed. */
const CURRENT_SOURCE = `${familyIsOpen('forgotten', 'unforgotten')}
    AND ${familyIsOpen('suppressed', 'unsuppressed')}`;

const COMMITTED_ROWS = `FROM source_incidence s
  JOIN evidence_link_versions v ON v.link_id = s.link_id AND v.version = s.link_version
  JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'`;

/** The scope a node's count of one role is derived from, at the direction the registry keys it. */
export function countScope(role: DurableRole): string {
  return durableRoleScope(role, nodeScopeDirection(role));
}

function gate(db: SqliteHandle, nodeId: string, role: DurableRole): string | undefined {
  const key = { endpointId: nodeId, relationClass: countScope(role) };
  if (!scopeSupportsVerifiedEmpty(db, key)) {
    return undefined;
  }
  return publishedScopeToken(db, key);
}

function uncountedReason(nodeId: string, role: DurableRole): string {
  return `no established census for ${countScope(role)} on ${nodeId}`;
}

function unavailable(nodeId: string, role: DurableRole): LogicalCount {
  return { status: 'unavailable', reason: uncountedReason(nodeId, role) };
}

/**
 * Seed mention_count and canonical entity selection: distinct logically current source
 * OCCURRENCES that mention the node, counted once whatever the direction or the alias.
 *
 * The filter is the source's currency and nothing else. A retired mention edge is still a source
 * occurrence that mentions the entity, and adding an edge-currency filter here would answer a
 * different question than the one seed selection asks.
 */
export function countCurrentMentionSources(db: SqliteHandle, nodeId: string): LogicalCount {
  const token = gate(db, nodeId, 'mention');
  if (token === undefined) {
    return unavailable(nodeId, 'mention');
  }
  const row = db
    .prepare(
      `SELECT count(DISTINCT s.source_id) AS n ${COMMITTED_ROWS}
       WHERE s.node_id = ? AND s.role = 'mention' AND ${CURRENT_SOURCE}`,
    )
    .get(nodeId) as { n: number };
  return { status: 'counted', count: row.n, token };
}

/**
 * Description growth and the curiosity mention floor: the RECORDED mention population, with no
 * current-source filter. Closed source history is preserved on purpose — a description grew
 * because those mentions happened, and dropping them would report growth from a baseline that
 * describes a different population.
 */
export function countRecordedMentionSources(db: SqliteHandle, nodeId: string): LogicalCount {
  const token = gate(db, nodeId, 'mention');
  if (token === undefined) {
    return unavailable(nodeId, 'mention');
  }
  const row = db
    .prepare(
      `SELECT count(DISTINCT s.source_id) AS n ${COMMITTED_ROWS}
       WHERE s.node_id = ? AND s.role = 'mention'`,
    )
    .get(nodeId) as { n: number };
  return { status: 'counted', count: row.n, token };
}

/**
 * The generic role count for the subject-family, co-extraction and ownership joins: the FULL
 * directed role-qualified set. A caller whose own population is narrower names its edge currency;
 * imposing one here would answer every consumer's question with one consumer's filter.
 */
export function countRoleIncidence(
  db: SqliteHandle,
  nodeId: string,
  role: DurableRole,
  options: { readonly currency?: 'open' | 'closed' } = {},
): LogicalCount {
  const token = gate(db, nodeId, role);
  if (token === undefined) {
    return unavailable(nodeId, role);
  }
  const currency = options.currency === undefined ? '' : 'AND s.currency = ?';
  const row = db
    .prepare(
      `SELECT count(DISTINCT s.source_id) AS n ${COMMITTED_ROWS}
       WHERE s.node_id = ? AND s.role = ? ${currency}`,
    )
    .get(nodeId, role, ...(options.currency === undefined ? [] : [options.currency])) as {
    n: number;
  };
  return { status: 'counted', count: row.n, token };
}

export type PairOverlap = {
  readonly status: 'counted';
  readonly left: number;
  readonly right: number;
  readonly intersection: number;
  readonly union: number;
  /** The smallest gap in milliseconds between a dated source on each side, where both are dated. */
  readonly minimumGapMs?: number;
  /** Sources on either side whose occurrence clock the records never stated. Kept separate. */
  readonly undated: number;
};

export type PairOverlapReading =
  PairOverlap | { readonly status: 'unavailable'; readonly reason: string };

type DatedSource = { readonly sourceId: string; readonly occurredAt: number | undefined };

/** The bound a pair read is charged before it is paid, so neither side is materialized whole. */
export const PAIR_OVERLAP_LIMIT = 4096;

/**
 * One side's source set, ordered by the date the gap is measured on so the merge below is linear.
 * One more row than the bound is read, which is what lets an over-bound population be reported as
 * unavailable rather than as an exact count over part of it.
 */
function mentionSources(db: SqliteHandle, nodeId: string, limit: number): readonly DatedSource[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.source_id AS source_id, r.occurred_at AS occurred_at
       ${COMMITTED_ROWS}
       LEFT JOIN source_records r ON r.source_id = s.source_id
       WHERE s.node_id = ? AND s.role = 'mention' AND ${CURRENT_SOURCE}
       ORDER BY r.occurred_at, s.source_id
       LIMIT ?`,
    )
    .all(nodeId, limit + 1) as { source_id: string; occurred_at: string | null }[];
  return rows.map((row) => {
    const parsed = row.occurred_at === null ? Number.NaN : Date.parse(row.occurred_at);
    return {
      sourceId: row.source_id,
      occurredAt: Number.isNaN(parsed) ? undefined : parsed,
    };
  });
}

/**
 * The smallest distance between two ordered date sets, walked once from both ends.
 *
 * The cross product would compare every pair to find one answer; the sets arrive ordered, so the
 * pointer that is behind is the only one that can improve the gap.
 */
function smallestGap(left: readonly number[], right: readonly number[]): number | undefined {
  let best: number | undefined;
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const one = left[a];
    const other = right[b];
    if (one === undefined || other === undefined) {
      break;
    }
    const gap = Math.abs(one - other);
    best = best === undefined ? gap : Math.min(best, gap);
    if (one <= other) {
      a += 1;
    } else {
      b += 1;
    }
  }
  return best;
}

/**
 * Entity pair source overlap: the two source sets, their intersection and union, and the smallest
 * proved gap between them.
 *
 * The gap is computed over the dates the records actually state. A source whose occurrence clock
 * nobody recorded contributes to the counts and to nothing else, and is reported separately, so a
 * judge asking how close two entities are is never handed a distance derived from a date the
 * substrate invented.
 */
export function entityPairSourceOverlap(
  db: SqliteHandle,
  leftId: string,
  rightId: string,
  limit: number = PAIR_OVERLAP_LIMIT,
): PairOverlapReading {
  for (const nodeId of [leftId, rightId]) {
    if (gate(db, nodeId, 'mention') === undefined) {
      return { status: 'unavailable', reason: uncountedReason(nodeId, 'mention') };
    }
  }
  const left = mentionSources(db, leftId, limit);
  const right = mentionSources(db, rightId, limit);
  for (const [nodeId, side] of [
    [leftId, left],
    [rightId, right],
  ] as const) {
    if (side.length > limit) {
      // An incomplete required statistic is unavailable, not a partial count called exact.
      return { status: 'unavailable', reason: `${nodeId} holds more mentions than the bound` };
    }
  }
  const rightIds = new Set(right.map((entry) => entry.sourceId));
  const intersection = left.filter((entry) => rightIds.has(entry.sourceId)).length;
  const union = new Set([...left, ...right].map((entry) => entry.sourceId)).size;
  const undated = [...left, ...right].filter((entry) => entry.occurredAt === undefined).length;
  const dated = (side: readonly DatedSource[]): readonly number[] =>
    side.map((entry) => entry.occurredAt).filter((value): value is number => value !== undefined);
  const minimumGapMs = smallestGap(dated(left), dated(right));
  return {
    status: 'counted',
    left: left.length,
    right: right.length,
    intersection,
    union,
    ...(minimumGapMs === undefined ? {} : { minimumGapMs }),
    undated,
  };
}

export type MentionRecency = {
  readonly status: 'counted';
  readonly sources: number;
  /** The newest clock the mention records themselves state, in ISO form. */
  readonly newestRecordedAt?: string;
  /**
   * False when an open mention carries no recorded clock. A recency-based close may not run on
   * it: the missing proof is not evidence of silence.
   */
  readonly clockProved: boolean;
};

export type MentionRecencyReading =
  MentionRecency | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Identifier decay's population: distinct occurrences holding an OPEN mention, and the newest
 * clock those mentions recorded for themselves.
 *
 * This path's filter is the EDGE's currency and nothing else. A forgotten source's open mention is
 * still an open mention, and dropping it would age an identifier on a silence that is really a
 * suppression somebody else applied.
 *
 * The clock is the mention's own `updated_at` and no substitute. A backfill acknowledges every
 * legacy mention on the day it runs, and a world start says when the relationship began rather
 * than when it was last touched: reading either as the last mention would age the whole corpus
 * wrongly, in opposite directions. Missing proof stays missing.
 */
export function openMentionRecency(db: SqliteHandle, nodeId: string): MentionRecencyReading {
  const token = gate(db, nodeId, 'mention');
  if (token === undefined) {
    return { status: 'unavailable', reason: uncountedReason(nodeId, 'mention') };
  }
  const rows = db
    .prepare(
      `SELECT s.source_id AS source_id,
              json_extract(v.recorded_values_json, '$.updated_at') AS recorded_at
       ${COMMITTED_ROWS}
       WHERE s.node_id = ? AND s.role = 'mention' AND s.currency = 'open'`,
    )
    .all(nodeId) as { source_id: string; recorded_at: string | null }[];
  const sources = new Set(rows.map((row) => row.source_id)).size;
  const stated = rows.map((row) => row.recorded_at).filter((value) => value !== null);
  const newest = stated.length === 0 ? undefined : stated.reduce((a, b) => (a > b ? a : b));
  return {
    status: 'counted',
    sources,
    ...(newest === undefined ? {} : { newestRecordedAt: newest }),
    clockProved: rows.length > 0 && stated.length === rows.length,
  };
}
