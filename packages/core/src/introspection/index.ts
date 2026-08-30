/**
 * The introspection layer's public surface: the health snapshot, the decision engine, the
 * operation contract every maintenance operation implements, and the loop that runs them.
 */

export { operationBucketKey, OPERATION_LEDGER_PREFIX } from './domain/buckets.js';

export type { IntrospectionOperation } from './domain/operation.js';

export { observeHealth } from './application/observe.js';

export { Introspector } from './application/engine.js';

export { introspectionOperations } from './application/catalog.js';

/**
 * The repair the loop never selects on its own. It is exported beside the catalog because it
 * has the same shape as an operation and belongs to the same layer; what it does not have is a
 * measurable trigger, so a person names the merge to reverse.
 */
export { listUnmergeableRecords, runEntityUnmerge } from './application/operations/unmerge.js';
