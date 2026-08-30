/**
 * A context vector is the strength-weighted mean of a node's neighbors' content vectors.
 * Pure math, no graph access: the graph read supplies the rows, this module turns them into
 * one vector per affected node.
 */

export type WeightedVector = {
  readonly vector: readonly number[];
  readonly weight: number;
};

/**
 * `undefined` when nothing qualifies: no entries, every weight non-positive, or a vector of
 * the wrong dimension throughout. A single qualifying neighbor returns exactly its own
 * vector, since `(w * v) / w = v` for any positive `w`.
 */
export function weightedMeanVector(
  entries: readonly WeightedVector[],
): readonly number[] | undefined {
  const dimension = entries.find((entry) => entry.weight > 0 && entry.vector.length > 0)?.vector
    .length;
  if (dimension === undefined) {
    return undefined;
  }

  const qualifying = entries.filter(
    (entry) => entry.weight > 0 && entry.vector.length === dimension,
  );
  const totalWeight = qualifying.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    return undefined;
  }

  const sums = qualifying.reduce<number[]>(
    (acc, entry) =>
      acc.map((componentSum, i) => componentSum + (entry.vector[i] ?? 0) * entry.weight),
    new Array<number>(dimension).fill(0),
  );
  return sums.map((sum) => sum / totalWeight);
}

export type NeighborContentVector = {
  /** The affected node this row's neighbor belongs to. */
  readonly nodeId: string;
  readonly neighborId: string;
  readonly strength: number;
  readonly vector: readonly number[];
};

export type ComputedContextVector = {
  readonly id: string;
  readonly vector: readonly number[];
  /** Rows that fed the mean, including repeats when two edges connect the same pair. */
  readonly neighborCount: number;
};

/**
 * One row per (affected node, neighbor edge), not deduplicated by neighbor, so a node
 * reachable by two relationships contributes twice, weighted by each edge's own strength.
 * A node absent from the result had no positively-weighted vectored neighbor. Nodes with no
 * vectored neighbors skip cleanly because this function returns nothing for them, rather
 * than the caller special-casing an empty vector.
 */
export function computeContextVectors(
  neighbors: readonly NeighborContentVector[],
): readonly ComputedContextVector[] {
  const grouped = new Map<string, NeighborContentVector[]>();
  for (const row of neighbors) {
    const bucket = grouped.get(row.nodeId);
    if (bucket === undefined) {
      grouped.set(row.nodeId, [row]);
    } else {
      bucket.push(row);
    }
  }

  const results: ComputedContextVector[] = [];
  for (const [nodeId, rows] of grouped) {
    const mean = weightedMeanVector(
      rows.map((row) => ({ vector: row.vector, weight: row.strength })),
    );
    if (mean !== undefined) {
      results.push({ id: nodeId, vector: mean, neighborCount: rows.length });
    }
  }
  return results;
}
