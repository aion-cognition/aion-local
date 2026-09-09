import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  publishedScopeToken,
  scopeSupportsVerifiedEmpty,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { nodeScopeDirection } from '../../reflection/domain/legacy-materialization.js';
import { durableRoleScope, type DurableRole } from '../domain/scopes.js';

/**
 * The C8 §4 counter populations, read from the incidence records rather than from a stored number.
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
 * A source is logically current when nothing committed has forgotten or suppressed it.
 *
 * `NOT EXISTS` over the newest committed state rather than a scalar comparison: a source with no
 * state row has no newest state, and comparing that absent value would make the whole predicate
 * null and quietly drop every source that was never forgotten.
 */
const CURRENT_SOURCE = `NOT EXISTS (
    SELECT 1 FROM source_state_versions v2
    JOIN publication_intents i2 ON i2.operation_id = v2.operation_id AND i2.state = 'acknowledged'
    WHERE v2.source_id = s.source_id AND v2.known_from IS NOT NULL
      AND v2.state_kind IN ('forgotten', 'suppressed')
      AND v2.version = (
        SELECT MAX(v3.version) FROM source_state_versions v3
        JOIN publication_intents i3
          ON i3.operation_id = v3.operation_id AND i3.state = 'acknowledged'
        WHERE v3.source_id = v2.source_id AND v3.known_from IS NOT NULL
      )
  )`;

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
 * occurrences that mention the node, counted once whatever the direction or the alias.
 */
export function countCurrentMentionSources(db: SqliteHandle, nodeId: string): LogicalCount {
  const token = gate(db, nodeId, 'mention');
  if (token === undefined) {
    return unavailable(nodeId, 'mention');
  }
  const row = db
    .prepare(
      `SELECT count(DISTINCT s.source_id) AS n ${COMMITTED_ROWS}
       WHERE s.node_id = ? AND s.role = 'mention' AND s.currency = 'open' AND ${CURRENT_SOURCE}`,
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

/** The generic role count for the subject-family, co-extraction and ownership joins. */
export function countRoleIncidence(
  db: SqliteHandle,
  nodeId: string,
  role: DurableRole,
): LogicalCount {
  const token = gate(db, nodeId, role);
  if (token === undefined) {
    return unavailable(nodeId, role);
  }
  const row = db
    .prepare(
      `SELECT count(DISTINCT s.source_id) AS n ${COMMITTED_ROWS}
       WHERE s.node_id = ? AND s.role = ? AND s.currency = 'open'`,
    )
    .get(nodeId, role) as { n: number };
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

function mentionSources(db: SqliteHandle, nodeId: string): readonly DatedSource[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.source_id AS source_id, r.occurred_at AS occurred_at
       ${COMMITTED_ROWS}
       LEFT JOIN source_records r ON r.source_id = s.source_id
       WHERE s.node_id = ? AND s.role = 'mention' AND s.currency = 'open' AND ${CURRENT_SOURCE}`,
    )
    .all(nodeId) as { source_id: string; occurred_at: string | null }[];
  return rows.map((row) => {
    const parsed = row.occurred_at === null ? Number.NaN : Date.parse(row.occurred_at);
    return {
      sourceId: row.source_id,
      occurredAt: Number.isNaN(parsed) ? undefined : parsed,
    };
  });
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
): PairOverlapReading {
  for (const nodeId of [leftId, rightId]) {
    if (gate(db, nodeId, 'mention') === undefined) {
      return { status: 'unavailable', reason: uncountedReason(nodeId, 'mention') };
    }
  }
  const left = mentionSources(db, leftId);
  const right = mentionSources(db, rightId);
  const rightIds = new Set(right.map((entry) => entry.sourceId));
  const intersection = left.filter((entry) => rightIds.has(entry.sourceId)).length;
  const union = new Set([...left, ...right].map((entry) => entry.sourceId)).size;
  const undated = [...left, ...right].filter((entry) => entry.occurredAt === undefined).length;
  let minimumGapMs: number | undefined;
  for (const one of left) {
    for (const other of right) {
      if (one.occurredAt === undefined || other.occurredAt === undefined) {
        continue;
      }
      const gap = Math.abs(one.occurredAt - other.occurredAt);
      minimumGapMs = minimumGapMs === undefined ? gap : Math.min(minimumGapMs, gap);
    }
  }
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
 * The clock comes off the recorded values, never off the acknowledgment. A backfill acknowledges
 * every legacy mention on the day it runs, and reading that as the mention's own age would make
 * the whole corpus look freshly mentioned and defer every close by the full decay window.
 */
export function openMentionRecency(db: SqliteHandle, nodeId: string): MentionRecencyReading {
  const token = gate(db, nodeId, 'mention');
  if (token === undefined) {
    return { status: 'unavailable', reason: uncountedReason(nodeId, 'mention') };
  }
  const rows = db
    .prepare(
      `SELECT s.source_id AS source_id,
              COALESCE(json_extract(v.recorded_values_json, '$.updated_at'),
                       json_extract(v.recorded_values_json, '$.valid_from')) AS recorded_at
       ${COMMITTED_ROWS}
       WHERE s.node_id = ? AND s.role = 'mention' AND s.currency = 'open' AND ${CURRENT_SOURCE}`,
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
