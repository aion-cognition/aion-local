import type { GraphTransaction } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';

/**
 * Which of these ids the graph currently holds.
 *
 * Presence is a fact about storage and nothing else. A source whose raw projection has been
 * removed is still a known source in the durable records, so callers read this to decide whether
 * an edge can be written, never to decide what something is.
 *
 * The read runs inside the caller's transaction because the answer is only good under the lock
 * that produced it: an id that was free a moment ago can be taken by the time an unfenced write
 * lands on it.
 */
const PRESENT_NODE_IDS = [
  'UNWIND $ids AS id',
  `MATCH (n:${BASE_NODE_LABEL} { id: id })`,
  'RETURN n.id AS id',
].join('\n');

export async function presentNodeIds(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await tx.run(
    PRESENT_NODE_IDS,
    { ids: [...new Set(ids)] },
    (row) => row.id as string,
  );
  return new Set(rows);
}
