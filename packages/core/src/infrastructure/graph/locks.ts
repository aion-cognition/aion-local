import type { GraphTransaction } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { identityRow, toGraphDateTime } from './values.js';

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
 */
export async function lockNodeInTransaction(
  tx: GraphTransaction,
  id: string,
  now: Date,
): Promise<void> {
  await tx.run(
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) SET n.${LOCK_PROPERTY} = $now`,
    { id, now: toGraphDateTime(now) },
    identityRow,
  );
}
