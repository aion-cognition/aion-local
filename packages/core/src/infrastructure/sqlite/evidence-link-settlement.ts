import type { SqliteHandle } from './database.js';

/**
 * Whether an endpoint still owes a link version somebody prepared.
 *
 * Written here rather than added to `evidence-links.ts` because that file sits at the 500-line
 * lint cap. Nothing moved: this is a new read over the same two tables, and it belongs to the
 * same contract; nothing about the version chain is decided here.
 */

/**
 * The version classes one endpoint holds that are durable and not yet acknowledged.
 *
 * A caller deciding whether something is still owed has to know WHICH kind of record is waiting:
 * a statement somebody made, a legacy relationship a producer recorded, and a retirement a merge
 * or a legacy-coverage close appended are three different obligations, and one reason naming all
 * of them would name the wrong cause for two. A class is not one caller: the legacy and retirement
 * classes each have two production writers, so the state names the record that is waiting and the
 * operation that prepared it names who. Distinct and ordered, so a caller's answer does not depend
 * on how many rows of one class happen to exist.
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

/** One prepared version's address: the link it belongs to, and the key its delivery wrote it under. */
export type LinkVersionKey = {
  readonly linkId: string;
  readonly operationKey: string;
};

/**
 * Which of the versions an acknowledgment covers are still outside the committed view.
 *
 * The acknowledgment moves rows by operation, and the row it means to move is addressed by
 * delivery. Those are two identities, so a count of changed rows says how many moved and not
 * whether the ones this settlement named are among them. This asks about exactly those, after
 * the update, and an answer that is not empty is a settlement reporting an effect it did not have.
 */
export function unsettledLinkVersions(
  db: SqliteHandle,
  keys: readonly LinkVersionKey[],
): readonly string[] {
  const statement = db.prepare(
    `SELECT 1 AS owed FROM evidence_link_versions
     WHERE link_id = ? AND operation_key = ? AND known_from IS NULL`,
  );
  return keys
    .filter((key) => statement.get(key.linkId, key.operationKey) !== undefined)
    .map((key) => key.operationKey);
}
