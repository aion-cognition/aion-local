import type { SqliteHandle } from './database.js';

/**
 * Which published revisions a calendar window is made of, decided by the manifest.
 *
 * The rollup this replaces asked the GRAPH which narratives carried a scope property and grouped
 * them by the world time on the node. That is a question about what a write happened to stamp; the
 * signed rule is a question about the records, and the records are what a window has to be
 * complete with respect to. A chunk belongs to exactly one window, the one its span END falls in,
 * and its span is the frozen membership's own newest occurrence — frozen, so the window a chunk
 * belongs to cannot move under a later arrival.
 *
 * Two levels, one shape. A day's members are published chunk revisions; a week's are the published
 * day overviews. Both answer with the node id the graph holds and the revision number the manifest
 * acknowledged, which is what a later run compares against to know the window has changed.
 */

export type OverviewMember = {
  /** The member's own family key: a chunk id, or the child overview's `scope:window`. */
  readonly familyKey: string;
  /** The published revision's graph node, which is what an overview cites. */
  readonly nodeId: string;
  readonly revisionNo: number;
  /** World time the member covers up to, which is the window it belongs to. */
  readonly spanEnd: string;
};

/**
 * Where a member page resumes, in the order these reads return.
 *
 * A fixed front page reads the same members every run, so a window behind a page of members
 * nothing can compress is never reached however often the pass runs.
 */
export type MemberCursor = {
  readonly spanEnd: string;
  readonly familyKey: string;
};

/** `'(scope kind):(window key)'`, the family key the signed DDL names for an overview. */
export function overviewFamilyKey(scope: string, windowKey: string): string {
  return `${scope}:${windowKey}`;
}

/** The window a family key names, or undefined for a key that is not one. */
export function overviewWindowOf(
  familyKey: string,
): { scope: string; windowKey: string } | undefined {
  const split = familyKey.indexOf(':');
  if (split <= 0 || split === familyKey.length - 1) {
    return undefined;
  }
  return { scope: familyKey.slice(0, split), windowKey: familyKey.slice(split + 1) };
}

/**
 * Published chunk revisions with the world time their frozen membership reaches, oldest first.
 *
 * `MAX(occurred_at)` over the frozen members is the span end: the chunk covers up to its newest
 * member's occurrence whatever order they arrived in, which is why a midnight-crossing chunk lands
 * in one window rather than being split across two. A chunk whose members carry no occurrence at
 * all cannot be placed and is left out — named by `unplaceableChunks` rather than dropped quietly.
 */
export function publishedChunkSpans(
  db: SqliteHandle,
  limit: number,
  after?: MemberCursor,
): readonly OverviewMember[] {
  if (limit <= 0) {
    return [];
  }
  const resume = after ?? { spanEnd: '', familyKey: '' };
  const rows = db
    .prepare(
      `SELECT r.chunk_id AS family_key, r.node_id, r.revision_no,
              (SELECT MAX(s.occurred_at) FROM chunk_members m
                 JOIN source_records s ON s.source_id = m.source_id
                WHERE m.chunk_id = r.chunk_id) AS span_end
         FROM chunk_revisions r
        WHERE r.state = 'published'
          AND (? = '' OR span_end > ? OR (span_end = ? AND r.chunk_id > ?))
        ORDER BY span_end, r.chunk_id
        LIMIT ?`,
    )
    .all(resume.spanEnd, resume.spanEnd, resume.spanEnd, resume.familyKey, limit) as {
    family_key: string;
    node_id: string;
    revision_no: number;
    span_end: string | null;
  }[];
  return rows
    .filter((row): row is typeof row & { span_end: string } => row.span_end !== null)
    .map((row) => ({
      familyKey: row.family_key,
      nodeId: row.node_id,
      revisionNo: row.revision_no,
      spanEnd: row.span_end,
    }));
}

/** Published chunks the manifest cannot place in any window, so a caller can say so. */
export function unplaceableChunks(db: SqliteHandle): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM chunk_revisions r
        WHERE r.state = 'published'
          AND (SELECT MAX(s.occurred_at) FROM chunk_members m
                 JOIN source_records s ON s.source_id = m.source_id
                WHERE m.chunk_id = r.chunk_id) IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Published overviews of one scope, as the members of the scope above.
 *
 * The span end of an overview is the window it covers, which is what its own family key names, so
 * a week takes its days from the key rather than from a stamp on a node.
 */
export function publishedOverviewSpans(
  db: SqliteHandle,
  scope: string,
  limit: number,
  after?: MemberCursor,
): readonly OverviewMember[] {
  if (limit <= 0) {
    return [];
  }
  const resume = after ?? { spanEnd: '', familyKey: '' };
  const rows = db
    .prepare(
      `SELECT r.family_key, r.node_id, r.revision_no, r.published_at
         FROM overview_revisions r
        WHERE r.state = 'published' AND r.family_key LIKE ? || ':%'
          AND (? = '' OR r.family_key > ?)
        ORDER BY r.family_key
        LIMIT ?`,
    )
    .all(scope, resume.familyKey, resume.familyKey, limit) as {
    family_key: string;
    node_id: string;
    revision_no: number;
    published_at: string | null;
  }[];
  return rows.map((row) => ({
    familyKey: row.family_key,
    nodeId: row.node_id,
    revisionNo: row.revision_no,
    spanEnd: overviewWindowOf(row.family_key)?.windowKey ?? row.family_key,
  }));
}
