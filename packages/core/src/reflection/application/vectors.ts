import type { Driver } from 'neo4j-driver';

import {
  findPendingVectorNodes,
  findPendingVectorNodesForSource,
  writeContentVectors,
  type ContentVectorEntry,
  type PendingVectorNode,
} from '../../infrastructure/graph/pending-vectors.js';
import type { Embedder } from '../../infrastructure/providers/types.js';
import { vectorInputHash } from '../domain/vector-input.js';

export {
  findPendingVectorNodes,
  findPendingVectorNodesForSource,
  type PendingVectorNode,
} from '../../infrastructure/graph/pending-vectors.js';

/**
 * The embed-and-write half of the write path, split out because it runs in three places: the
 * queued vector job for one accepted source, the worker's startup drain over whatever an
 * earlier outage left pending, and the `vector_backfill` operation. All three are the same
 * operation: the only difference is who found the nodes.
 *
 * The provider call is not guarded here. The job treats a failure as a retry and the startup
 * drain treats it as a backlog to pick up next time. Swallowing it in the middle would take
 * that choice away from both.
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
  provider: Embedder,
  nodes: readonly PendingVectorNode[],
): Promise<string[]> {
  if (nodes.length === 0) {
    return [];
  }
  const vectors = await provider.embed(nodes.map((node) => node.text));
  return writeContentVectors(driver, pair(nodes, vectors));
}

export type PendingVectorDrainDeps = {
  readonly driver: Driver;
  readonly provider: Embedder;
  readonly logger: { warn: (fields: Record<string, unknown>, message: string) => void };
};

/**
 * Everything an accepted source still owes a vector, embedded and written in one pass. This is
 * what the queued `attach_vectors` job runs. It throws on a provider failure, so the job retries
 * with the queue's own backoff rather than reporting a source as vectorized that is not.
 *
 * The set is read at run time rather than carried in the payload: by the time the job is
 * claimed another writer may have vectorized the episode already, and a payload naming nodes
 * would re-embed them.
 */
export async function attachSourceVectors(
  deps: PendingVectorDrainDeps,
  sourceId: string,
): Promise<number> {
  const pending = await findPendingVectorNodesForSource(deps.driver, sourceId);
  const written = await attachContentVectors(deps.driver, deps.provider, pending);
  return written.length;
}

/**
 * What an inference outage left behind, oldest first. A batch that comes back short of what was
 * asked for, or that writes fewer vectors than it read, is the end of the drain: the rest is
 * still pending and the next start or the `vector_backfill` operation takes it.
 */
export async function drainPendingVectors(
  deps: PendingVectorDrainDeps,
  batchSize: number,
): Promise<number> {
  let attached = 0;
  try {
    for (;;) {
      const batch = await findPendingVectorNodes(deps.driver, batchSize);
      if (batch.length === 0) {
        return attached;
      }
      const written = await attachContentVectors(deps.driver, deps.provider, batch);
      attached += written.length;
      if (written.length < batch.length || batch.length < batchSize) {
        return attached;
      }
    }
  } catch (err) {
    deps.logger.warn({ err, attached }, 'pending content vectors deferred; the drain continues');
    return attached;
  }
}
