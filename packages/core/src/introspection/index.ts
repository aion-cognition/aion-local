/**
 * The introspection layer's public surface: the health snapshot, the decision engine, the
 * operation contract every maintenance operation implements, and the loop that runs them.
 */

export { operationBucketKey, OPERATION_LEDGER_PREFIX } from './domain/buckets.js';

export type { IntrospectionOperation } from './domain/operation.js';

export { wouldAutoApply } from './domain/merge-shadow.js';

export { observeHealth } from './application/observe.js';

export { decide } from './domain/decide.js';
export type { Decision, OperationCandidate } from './domain/decide.js';

export type { HealthSnapshot, OperationEffectiveness } from './domain/health.js';

export type { Tier3Proposal, Tier3Request } from './domain/tier3.js';

export {
  adviseTier3,
  DEFAULT_TIER3_MODE,
  modelAdvisor,
  reviewTier3Proposal,
} from './application/tier3-advisor.js';

export { Introspector } from './application/engine.js';

export { introspectionOperations } from './application/catalog.js';

/**
 * The self-probe's isolated recall, built where the real recall deps live. It is exported for
 * the caller that wires the loop, since only that caller holds them.
 */
export { probeRecall } from './application/operations/recall-probe.js';

/**
 * The repair the loop never selects. A person names the merge to reverse; `unmerge.ts` says why
 * it has no measurable trigger.
 */
export { listUnmergeableRecords, runEntityUnmerge } from './application/operations/unmerge.js';
export type { UnmergedDecision } from './application/operations/unmerge.js';
