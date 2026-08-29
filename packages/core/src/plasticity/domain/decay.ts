/**
 * The pure Hebbian decay: the bell curve against staleness, and the floor clamp. No SQLite,
 * no Cypher.
 *
 * **The bell curve.** `decay = exp(-((t - peak)^2) / (2 * sigma^2))`, where `t` is days
 * since an edge was last touched. The curve peaks at `t = peak` and falls off symmetrically
 * on both sides: an edge touched yesterday and an edge idle for a year both sit in a tail and
 * decay slowly, one because it may still be relevant, the other because it has already
 * settled near the floor and further decay buys little. An edge idle for exactly the peak
 * window decays fastest, which is the point in an edge's disuse where trimming it does the
 * most for signal-to-noise.
 *
 * **The floor clamp.** `w' = max(floor, w - eta_decay * decay)`. Decay only ever subtracts,
 * so `w'` never exceeds `w`, and the floor stops it reaching zero: an edge faded to the floor
 * stays traversable if spreading activation ever reaches it again.
 *
 * **Staleness source.** Edges carry no access-time property of their own. Recall stamps
 * `last_accessed` on the nodes a pack surfaces, never on the edges between them, so an edge's
 * `updated_at` (set by the merge policy on every write and by reinforcement's own bounded
 * step) is what stands in for "last touched" here. That choice is stated plainly rather than
 * left implicit: `application/decay.ts` bumps `updated_at` on every edge it decays, which is
 * also what lets a bounded run's own writes advance the next run past what it already
 * touched, with no separate cursor.
 */

/**
 * `exp(-((daysSinceAccess - peakDays)^2) / (2 * sigma^2))`, in `(0, 1]` and maximal at
 * `daysSinceAccess === peakDays`. Symmetric around the peak: `decayFactor(peak - x, ...)`
 * equals `decayFactor(peak + x, ...)` for any `x`.
 */
export function decayFactor(daysSinceAccess: number, peakDays: number, sigma: number): number {
  const offset = daysSinceAccess - peakDays;
  return Math.exp(-(offset * offset) / (2 * sigma * sigma));
}

/**
 * The rule itself, and the same arithmetic the Cypher applies, so a test can state the
 * expected weight without a server. A weight only ever moves toward the floor, never past it
 * and never up: a factor of zero, the curve's deep tails, is a decay run's honest answer for
 * an edge nowhere near the peak.
 */
export function boundedDecay(
  weight: number,
  decayRate: number,
  factor: number,
  weightFloor: number,
): number {
  const raw = weight - decayRate * factor;
  if (raw < weightFloor) {
    return weightFloor;
  }
  return raw;
}
