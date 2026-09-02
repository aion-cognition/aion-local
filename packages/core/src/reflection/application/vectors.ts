import type { Driver } from 'neo4j-driver';

import {
  writeContentVectors,
  type ContentVectorEntry,
  type PendingVectorNode,
} from '../../infrastructure/graph/pending-vectors.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { vectorInputHash } from '../domain/vector-input.js';

export {
  findPendingVectorNodes,
  type PendingVectorNode,
} from '../../infrastructure/graph/pending-vectors.js';

/**
 * The embed-and-write half of the write path, split out because it runs in two places: at
 * the end of intake, on the nodes that call just committed, and in the worker's startup
 * drain, on whatever an earlier outage left pending. Both are the same operation: the
 * only difference is who found the nodes.
 *
 * The provider call is not guarded here. Intake treats a failure as "vectors stay pending"
 * and answers the caller anyway; the worker treats it as a job to retry. Swallowing it in
 * the middle would take that choice away from both.
 */

/** One node to one vector, by position in the call's own list. */
function pair(
  nodes: readonly PendingVectorNode[],
  vectors: readonly (readonly number[])[],
): ContentVectorEntry[] {
  const entries: ContentVectorEntry[] = [];
  for (const [index, node] of nodes.entries()) {
    const vector = vectors[index];
    // A provider that returns a short list leaves the tail pending rather than mis-pairing
    // it: the node keeps its marker and the next drain picks it up.
    if (vector !== undefined) {
      entries.push({ id: node.id, vector, inputHash: vectorInputHash(node.text) });
    }
  }
  return entries;
}

/** The ids that now carry a content vector. */
export async function attachContentVectors(
  driver: Driver,
  provider: Provider,
  nodes: readonly PendingVectorNode[],
): Promise<string[]> {
  if (nodes.length === 0) {
    return [];
  }
  const vectors = await provider.embed(nodes.map((node) => node.text));
  return writeContentVectors(driver, pair(nodes, vectors));
}
