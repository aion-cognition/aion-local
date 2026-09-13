import { createHash } from 'node:crypto';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import type { GraphTransaction } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL } from './labels.js';
import { lockGroupInTransaction } from './locks.js';
import { toGraphInteger } from './values.js';

/**
 * What a pass read, in the words it read, and whether that is still what the graph holds.
 *
 * Generation takes seconds to minutes and everything it read stays writable throughout, so a
 * writer handed only the ids a model cited knows nothing about the state they were cited at. This
 * is the triple that closes that gap, checked inside the publishing transaction so nothing can
 * move between the check and the write it guards.
 *
 * Split out of `synthesis-queries.ts` to keep that file inside the repository's line cap.
 */

/**
 * One node the pass read, at the revision and in the words it stood in.
 *
 * All three parts are the statement. An id alone says the node exists. The revision beside it
 * catches the lifecycle steps that renumber it. The digest catches the writers that rewrite a
 * node's words without touching its lifecycle at all: the redaction residue purge rewrites
 * `text` to `[REDACTED]` in place, and identity and revision both survive that.
 */
export type ReadAtRevision = {
  readonly id: string;
  readonly revision: number;
  /** sha256 of the node's text exactly as the pass was shown it. */
  readonly digest: string;
};

/** The digest both sides of the comparison are taken over: one function, so they cannot drift. */
function readingDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * One read row, bound to the words it was read in.
 *
 * The only way to build one, so a caller cannot hand the writer a revision without the text it
 * belongs to. Takes the row the pass itself holds, which is the row it showed the model.
 */
export function readAtRevision(row: {
  readonly id: string;
  readonly revision: number;
  readonly text: string;
}): ReadAtRevision {
  return { id: row.id, revision: row.revision, digest: readingDigest(row.text) };
}

const SELECTED_READING_NOW = [
  'UNWIND $reading AS row',
  `OPTIONAL MATCH (n:${BASE_NODE_LABEL} { id: row.id })`,
  'WITH row, n',
  'RETURN row.id AS id,',
  `       (n IS NOT NULL AND ${currentOnly('n')}`,
  `        AND coalesce(n.${BITEMPORAL_PROPERTIES.lifecycleRevision}, 1) = row.revision) AS standing,`,
  `       coalesce(n.${MEMORY_PROPERTIES.text}, '') AS text`,
  'ORDER BY id',
].join('\n');

/**
 * Which of these nodes are no longer what the pass read, with the rest held still until the
 * caller's transaction commits.
 *
 * Gone, closed, forgotten, moved on by a lifecycle step and rewritten in place all answer the
 * same way, because the question is whether the reading still holds rather than what became of it.
 *
 * The group lock is half the answer and cannot be separated from it. Neo4j reads take no lock and
 * its isolation is read-committed (`locks.ts`), so on its own this check only says the reading held
 * at the instant it ran: a retirement committing a moment later still lands ahead of the write this
 * guards. Locking the whole reading first, in the sorted order every other group lock uses, makes
 * the check and the write it protects one serialized step. The lock belongs here rather than at the
 * call site so a second caller cannot take the check without it.
 */
export async function movedSinceRead(
  tx: GraphTransaction,
  reading: readonly ReadAtRevision[],
  now: Date = new Date(),
): Promise<readonly string[]> {
  if (reading.length === 0) {
    return [];
  }
  await lockGroupInTransaction(
    tx,
    reading.map((row) => row.id),
    now,
  );
  const digests = new Map(reading.map((row) => [row.id, row.digest]));
  const rows = await tx.run(
    SELECTED_READING_NOW,
    { reading: reading.map((row) => ({ id: row.id, revision: toGraphInteger(row.revision) })) },
    (row) => ({
      id: row.id as string,
      standing: row.standing === true,
      text: (row.text as string | null) ?? '',
    }),
  );
  return rows
    .filter((row) => !row.standing || readingDigest(row.text) !== digests.get(row.id))
    .map((row) => row.id);
}
