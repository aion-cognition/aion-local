/**
 * The decay sweep's test oracle: the bell curve against staleness and the floor clamp, in
 * pure TS. The sweep applies this arithmetic in Cypher (`edge-weights.ts`); tests import this
 * mirror to state an expected weight without a server. Nothing in production imports it.
 *
 * The curve is `decay = exp(-((t - peak)^2) / (2 * sigma^2))`, where `t` is days
 * since an edge was last touched. It peaks at `t = peak` and falls off symmetrically
 * on both sides: an edge touched yesterday and an edge idle for a year both sit in a tail and
 * decay slowly, one because it may still be relevant, the other because it has already
 * settled near the floor and further decay buys little. An edge idle for exactly the peak
 * window decays fastest, which is the point in an edge's disuse where trimming it does the
 * most for signal-to-noise.
 *
 * The clamp is `w' = min(w, max(floor, w - eta_decay * decay))`. Decay only ever subtracts,
 * so `w'` never exceeds `w`, and the floor stops it reaching zero: an edge faded to the floor
 * stays traversable if spreading activation ever reaches it again. The outer `min` is what
 * keeps the floor from working as a lift. An edge can be stored under it, since a semantic
 * relationship writes its confidence as its strength with no clamp, and raising such an edge
 * to the floor would make the sweep the reason recall can traverse it.
 *
 * Edges carry no access-time property of their own. Recall stamps
 * `last_accessed` on the nodes a pack surfaces, never on the edges between them, so an edge's
 * `updated_at` (set by the merge policy on every write and by reinforcement's own bounded
 * step) is what stands in for "last touched" here. Decay must not write it: an input the
 * sweep refreshes is an input that never grows, and the peak the curve is built around then
 * sits past anything an edge can reach. The sweep keeps its own cursor for scan order
 * (`edge-weights.ts`'s `decayed_at`) so the two never have to be one property.
 */

/**
 * `exp(-((daysSinceAccess - peakDays)^2) / (2 * sigma^2))`, in `[0, 1]` and maximal at
 * `daysSinceAccess === peakDays`. Symmetric around the peak: `expectedDecayFactor(peak - x, ...)`
 * equals `expectedDecayFactor(peak + x, ...)` for any `x`. Far enough out in a tail the exponent
 * underflows to exactly zero, which is a decay run's honest answer for an edge nowhere near
 * the peak.
 */
export function expectedDecayFactor(daysSinceAccess: number, peakDays: number, sigma: number): number {
  const offset = daysSinceAccess - peakDays;
  return Math.exp(-(offset * offset) / (2 * sigma * sigma));
}

/**
 * The rule itself. A weight only ever moves toward the floor, never past it and never up. An
 * edge already under the floor stays where it is.
 */
export function expectedBoundedDecay(
  weight: number,
  decayRate: number,
  factor: number,
  weightFloor: number,
): number {
  const raw = weight - decayRate * factor;
  if (raw < weightFloor) {
    return Math.min(weight, weightFloor);
  }
  return raw;
}
