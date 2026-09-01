/**
 * The pipeline's own version, stamped into every reflection ledger key and onto every archived
 * experience. Bump it when a stage's prompt or extraction rule changes.
 *
 * Bumping forks the ledger key space rather than resetting it: the keys the old version wrote
 * stay where they are, so an episode enriched under the old rules is still recorded as enriched
 * under them, and the same episode re-enters every stage under the new ones. A version carried
 * beside the key instead of inside it would not do that, since two versions would still collide
 * on one gate and the second would short-circuit.
 */
export const PIPELINE_VERSION = 'v1';
