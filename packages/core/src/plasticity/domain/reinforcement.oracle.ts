/**
 * The reinforcement rule's test oracle: the same arithmetic the flush's Cypher applies
 * (`edge-weights.ts`), in pure TS, so a test can state an expected weight without a server.
 * Nothing in production imports it.
 */

/**
 * The rule itself. The floor is a lower bound on the result, which reinforcement can only
 * reach by starting under it: a step raises the weight whenever eta is positive and the
 * weight is under 1.
 */
export function expectedBoundedReinforcement(
  weight: number,
  learningRate: number,
  weightFloor: number,
): number {
  const raw = weight + learningRate * (1 - weight);
  if (raw < weightFloor) {
    return weightFloor;
  }
  if (raw > 1) {
    return 1;
  }
  return raw;
}
