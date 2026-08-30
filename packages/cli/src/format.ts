import { EDGE_WEIGHT_DISTRIBUTION_TYPES, type EdgeWeightDistribution } from '@aion/core';

/** The shapes every command renders values in, so two listings never disagree on one. */

/** `12s` / `4m` / `1h`: one unit and no decimals, because these are read at a glance. */
export function ageOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) {
    return `${String(seconds)}s`;
  }
  if (seconds < 7200) {
    return `${String(Math.round(seconds / 60))}m`;
  }
  return `${String(Math.round(seconds / 3600))}h`;
}

/** Short enough to read in a list, long enough to paste back as an unambiguous id prefix. */
export function short(id: string): string {
  return id.slice(0, 8);
}

/** One line of a node's content, whitespace flattened, with the cut marked where it happens. */
export function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One clause per type, in the fixed order the distribution reports them; a type with no live edge reads as `n=0`. */
export function formatEdgeWeights(distribution: EdgeWeightDistribution): string {
  return EDGE_WEIGHT_DISTRIBUTION_TYPES.map((type) => {
    const stats = distribution[type];
    if (stats === undefined) {
      return `${type} n=0`;
    }
    return `${type} p50=${stats.p50.toFixed(2)} (min=${stats.min.toFixed(2)} max=${stats.max.toFixed(2)}, n=${String(stats.count)})`;
  }).join(', ');
}
