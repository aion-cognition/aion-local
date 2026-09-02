import type { GraphTransaction } from './connection.js';
import { GraphNodeNotFoundError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { toGraphDateTime } from './values.js';

/**
 * Written only to take the lock, never read as a fact about the node. It is a substrate
 * artifact, so it carries no bitemporal stamp and no supersession: overwriting it is not
 * a knowledge change.
 */
export const LOCK_PROPERTY = 'locked_at';

/**
 * Neo4j reads take no lock and its isolation is read-committed, so a transaction that
 * reads graph state and then writes a decision derived from it can be overtaken between
 * the two: two concurrent session creations each miss the other and fork the FOLLOWS
 * chain, two concurrent identical reflections each miss the other's episode and store it
 * twice. Without APOC the only way to take a node's exclusive lock is to write to it, and
 * the lock is then held until the transaction commits.
 *
 * Lock the node that scopes the decision (the Member whose chain is being extended, the
 * Session whose episodes are being deduped) before the read. Whichever transaction gets
 * the lock second sees everything the first committed, so the two serialize instead of
 * racing. Callers must already be inside `inWriteTransaction`; a lock taken by a statement
 * that commits on its own is released immediately and protects nothing.
 *
 * An id that names no node throws. A MATCH that bound nothing takes no lock, and a caller
 * that read the silence as a lock would run its read-then-write unserialized while believing
 * the opposite.
 */
export async function lockNodeInTransaction(
  tx: GraphTransaction,
  id: string,
  now: Date,
): Promise<void> {
  const locked = await tx.run(
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) SET n.${LOCK_PROPERTY} = $now RETURN n.id AS id`,
    { id, now: toGraphDateTime(now) },
    (row) => row.id as string,
  );
  if (locked.length === 0) {
    throw new GraphNodeNotFoundError([id], 'lockNode');
  }
}

/**
 * A whole group locked in one pass, sorted by id so two overlapping groups request the same two
 * nodes in the same order and cannot deadlock on each other.
 *
 * The ids that name no node come back rather than raising. A caller locking one node it just
 * read has nothing to say about a miss and wants the throw above; a caller locking a group it
 * decided off an older snapshot does, since a side the graph no longer answers for is the same
 * answer as a side that has since lost currency and belongs in the same refusal.
 */
export async function lockGroupInTransaction(
  tx: GraphTransaction,
  ids: readonly string[],
  now: Date,
): Promise<readonly string[]> {
  const unknown: string[] = [];
  for (const id of [...ids].sort()) {
    try {
      await lockNodeInTransaction(tx, id, now);
    } catch (err) {
      if (!(err instanceof GraphNodeNotFoundError)) {
        throw err;
      }
      unknown.push(id);
    }
  }
  return unknown;
}
