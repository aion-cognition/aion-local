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

/** The version class a reference delivery writes. The read below answers for this one alone. */
const STATED = 'stated';

/**
 * Every version one DELIVERY still holds outside the committed view, at whatever address it wrote
 * them under.
 *
 * Scoped to the delivery rather than to a list of addresses, because the address is not stable. A
 * stated link id is derived from what the target turned out to be, and that classification is
 * re-read from the graph on every attempt: a target the substrate started holding between a
 * discarded attempt and its retry is classified differently, so the retry writes a different link
 * and the first attempt's row keeps this delivery's key under an address nobody names again. A
 * question asked about the current attempt's addresses cannot see that row; a question asked about
 * the delivery can.
 *
 * A stated version's key is the delivery, a colon and the link, so membership is an EQUALITY against
 * that key rebuilt from the row's own link id. Written that way rather than as a prefix test on
 * purpose: delivery keys are not prefix-free by construction, and a prefix test would claim another
 * delivery's rows whenever one key happened to start with another. No pattern is involved either,
 * so a delivery key carrying a wildcard character means nothing here.
 *
 * The class is a predicate rather than an assumption. A delivery key is caller text and the
 * materialization and retirement writers key their own rows by the same colon shape, so a delivery
 * named to collide with one of theirs would otherwise put a row of another class in front of a
 * caller that releases what it finds. Narrowing to `stated` here makes the guarantee structural:
 * the only rows this can return are the ones the reference delivery itself wrote, which is what
 * the caller's refusal already says it counted.
 */
export function heldDeliveryLinkVersions(
  db: SqliteHandle,
  fromId: string,
  deliveryKey: string,
): readonly LinkVersionKey[] {
  const rows = db
    .prepare(
      `SELECT v.link_id AS link_id, v.operation_key AS operation_key
       FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.from_id = ? AND v.known_from IS NULL AND v.state = ?
         AND v.operation_key = ? || v.link_id
       ORDER BY v.link_id`,
    )
    .all(fromId, STATED, `${deliveryKey}:`) as { link_id: string; operation_key: string }[];
  return rows.map((row) => ({ linkId: row.link_id, operationKey: row.operation_key }));
}

/**
 * Drops named versions that are still outside the committed view.
 *
 * The caller decides which: the one case is a delivery whose retry no longer names the address a
 * discarded attempt wrote, where the old row is owed by an operation that will never acknowledge
 * and addressed by a link nothing will name again. Nothing was in the committed view and no
 * projection points at it, so dropping it returns the records to the state before that attempt.
 *
 * Returns how many were released.
 */
export function releaseLinkVersions(db: SqliteHandle, keys: readonly LinkVersionKey[]): number {
  const statement = db.prepare(
    `DELETE FROM evidence_link_versions
     WHERE link_id = ? AND operation_key = ? AND known_from IS NULL`,
  );
  let released = 0;
  for (const key of keys) {
    released += statement.run(key.linkId, key.operationKey).changes;
  }
  return released;
}

/**
 * Drops the versions one rejected operation prepared and nothing can ever adopt.
 *
 * A version keyed on the operation that wrote it cannot be found again: the retry carries a new
 * operation id, so it takes a new key and leaves the old row owed by an operation that will never
 * acknowledge. Nothing was in the committed view and no projection points at it, so releasing it
 * is a return to the state before the attempt rather than a correction of a recorded fact. A
 * delivery-keyed version is NOT released here; that one is re-adopted by its own retry.
 *
 * Returns how many were released.
 */
export function releasePreparedLinkVersions(db: SqliteHandle, operationId: string): number {
  return db
    .prepare('DELETE FROM evidence_link_versions WHERE operation_id = ? AND known_from IS NULL')
    .run(operationId).changes;
}
