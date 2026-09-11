import type { SqliteHandle } from './database.js';

/**
 * Whether an endpoint still owes a link version somebody prepared.
 *
 * Split out of `evidence-links.ts` because that file sits at the 500-line lint cap, the way the
 * maintenance knobs are split out of the knob table. It is one read over the same two tables and
 * belongs to the same contract; nothing about the version chain is decided here.
 */

/**
 * The version classes one endpoint holds that are durable and not yet acknowledged.
 *
 * A caller deciding whether something is still owed has to know WHICH kind of record is waiting:
 * a statement somebody made, a legacy relationship a backfill recorded, and a retirement a merge
 * appended are three different obligations with three different owners, and one reason naming all
 * of them would name the wrong cause for two. Distinct and ordered, so a caller's answer does not
 * depend on how many rows of one class happen to exist.
 */
export function unsettledLinkStates(db: SqliteHandle, fromId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT v.state AS state
       FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.from_id = ? AND v.known_from IS NULL
       ORDER BY v.state`,
    )
    .all(fromId) as { state: string }[];
  return rows.map((row) => row.state);
}
