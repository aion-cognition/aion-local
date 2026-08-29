import type { Vector } from '../../infrastructure/providers/types.js';
import { hashContent } from '../../reflection/domain/content.js';
import { bucketFor } from './pack.js';

/**
 * The ordering machinery, split out of `fusion.ts` so that file holds the
 * admission decision alone. Nothing here admits or refuses an item: by the time a list
 * reaches these functions the floors have already run, and reordering or capping a set is a
 * question about what the reader sees first, never about what the reader may see at all.
 */

export function cosineSimilarity(left: Vector, right: Vector): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** The minimum an item must carry to be ordered, capped, or diversified. */
export type RankableItem = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly content: string;
  readonly score: number;
};

/**
 * Sixteen characters is `"restart burst 0/"`, the measured burst-record shape: a
 * one-line template that varies only in a trailing count. Long enough to be a real coincidence
 * for two unrelated short memories to share verbatim, short enough that the template's fixed
 * part survives even when the whole record is barely longer than the prefix itself; a longer
 * prefix would swallow the varying suffix on records this short and stop clustering them at
 * all. Case-folded so a casing variant of the same template still keys the same.
 */
const CLUSTER_PREFIX_CHARS = 16;

/** Cosine above which two items are the same content by vector rather than by text. */
const CLUSTER_COSINE_THRESHOLD = 0.95;

function clusterPrefixKey(content: string): string {
  return hashContent(content.trim().toLowerCase().slice(0, CLUSTER_PREFIX_CHARS));
}

/**
 * Union-find over the post-dedupe set, grouped by pack bucket first: a Concept and an
 * Episode never share a cluster even if their content coincidentally collided, since they
 * were never competing for the same slot to begin with (`pack.ts`'s bucket caps are per
 * bucket already). Within a bucket, two items join a cluster when their content shares the
 * prefix key above, or (only when the caller already fetched embeddings for MMR) when
 * their vectors clear `CLUSTER_COSINE_THRESHOLD`. A run with no vectors in hand (the
 * default RRF reranker) relies on the prefix leg alone, which is what the burst repro needs:
 * the records it measured are one-line and share their opening verbatim.
 */
function clusterRoots<T extends RankableItem>(
  items: readonly T[],
  vectors: ReadonlyMap<string, Vector> | undefined,
): ReadonlyMap<string, string> {
  const parent = new Map<string, string>();
  for (const item of items) {
    parent.set(item.id, item.id);
  }

  function find(id: string): string {
    let root = id;
    let next = parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = parent.get(root);
    }
    parent.set(id, root);
    return root;
  }

  function union(left: string, right: string): void {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  }

  const byBucket = new Map<string, T[]>();
  for (const item of items) {
    const bucket = bucketFor(item.labels) ?? '';
    const grouped = byBucket.get(bucket) ?? [];
    grouped.push(item);
    byBucket.set(bucket, grouped);
  }

  for (const grouped of byBucket.values()) {
    const byPrefix = new Map<string, string>();
    for (const item of grouped) {
      const key = clusterPrefixKey(item.content);
      const first = byPrefix.get(key);
      if (first === undefined) {
        byPrefix.set(key, item.id);
        continue;
      }
      union(first, item.id);
    }

    if (vectors === undefined) {
      continue;
    }
    for (let i = 0; i < grouped.length; i += 1) {
      const left = grouped[i];
      const leftVector = left === undefined ? undefined : vectors.get(left.id);
      if (left === undefined || leftVector === undefined) {
        continue;
      }
      for (let j = i + 1; j < grouped.length; j += 1) {
        const right = grouped[j];
        const rightVector = right === undefined ? undefined : vectors.get(right.id);
        if (right === undefined || rightVector === undefined) {
          continue;
        }
        if (cosineSimilarity(leftVector, rightVector) > CLUSTER_COSINE_THRESHOLD) {
          union(left.id, right.id);
        }
      }
    }
  }

  const roots = new Map<string, string>();
  for (const item of items) {
    roots.set(item.id, find(item.id));
  }
  return roots;
}

/**
 * The floor keeps noise out; this keeps one shape from crowding out everything else that
 * cleared it. Items arrive best-first, so the first member of a cluster this loop keeps is
 * already its best-ranked one. `keptByRoot` enforces the cap and the caller counts what it
 * declined, so the report can say why a bucket held fewer distinct memories than it admitted
 * candidates for.
 */
export function applyClusterCap<T extends RankableItem>(
  items: readonly T[],
  cap: number,
  vectors: ReadonlyMap<string, Vector> | undefined,
): T[] {
  if (items.length <= 1) {
    return [...items];
  }

  const roots = clusterRoots(items, vectors);
  const keptByRoot = new Map<string, number>();
  const survivors: T[] = [];

  for (const item of items) {
    const root = roots.get(item.id) ?? item.id;
    const kept = keptByRoot.get(root) ?? 0;
    if (kept >= cap) {
      continue;
    }
    keptByRoot.set(root, kept + 1);
    survivors.push(item);
  }

  return survivors;
}

function redundancy<T extends RankableItem>(
  candidate: T,
  selected: readonly T[],
  vectors: ReadonlyMap<string, Vector> | undefined,
): number {
  const candidateVector = vectors?.get(candidate.id);
  if (candidateVector === undefined) {
    return 0;
  }
  let worst = 0;
  for (const chosen of selected) {
    const chosenVector = vectors?.get(chosen.id);
    if (chosenVector === undefined) {
      continue;
    }
    worst = Math.max(worst, cosineSimilarity(candidateVector, chosenVector));
  }
  return worst;
}

/**
 * The diversity-aware alternative: `lambda * relevance - (1 - lambda) *
 * redundancy`, selected greedily. Redundancy is cosine distance between content vectors
 * rather than Jaccard word overlap, because word overlap needs a tokenizer and text
 * machinery stays out of the cognitive path entirely. The embedding is the redundancy
 * signal the substrate already holds.
 *
 * Relevance is normalized against the top fused score first. Raw RRF sums cluster near
 * `1/k` while cosine similarity spans [0,1], so mixing them unnormalized would make lambda
 * meaningless and hand every ordering to the diversity term.
 */
export function mmrOrder<T extends RankableItem>(
  items: readonly T[],
  lambda: number,
  vectors: ReadonlyMap<string, Vector> | undefined,
): T[] {
  const top = items[0]?.score ?? 0;
  if (items.length <= 1 || top <= 0) {
    return [...items];
  }

  const remaining = [...items];
  const selected: T[] = [];
  const first = remaining.shift();
  if (first !== undefined) {
    selected.push(first);
  }

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate === undefined) {
        continue;
      }
      const score =
        lambda * (candidate.score / top) -
        (1 - lambda) * redundancy(candidate, selected, vectors);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen !== undefined) {
      selected.push(chosen);
    }
  }

  return selected;
}
