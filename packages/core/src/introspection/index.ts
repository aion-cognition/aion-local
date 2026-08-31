/**
 * The introspection layer's public surface: the health snapshot, the decision engine, the
 * operation contract every maintenance operation implements, and the loop that runs them.
 */

export { operationBucketKey, OPERATION_LEDGER_PREFIX } from './domain/buckets.js';

export type { IntrospectionOperation } from './domain/operation.js';

export {
  AUTO_MERGE_METHOD,
  MERGE_SHADOW_LEDGER_PREFIX,
  mergeShadowLedgerKey,
  readMergeShadowVerdict,
  summarizeMergeShadowAgreement,
  verdictAgrees,
  verdictOf,
  wouldAutoApply,
} from './domain/merge-shadow.js';
export type {
  MergeShadowAgreement,
  MergeShadowResolvedJudgment,
  MergeShadowVerdict,
} from './domain/merge-shadow.js';

export { observeHealth } from './application/observe.js';

export { decide } from './domain/decide.js';
export type { Decision, OperationCandidate } from './domain/decide.js';

export type { HealthSnapshot, OperationEffectiveness } from './domain/health.js';

export {
  acceptTier3Proposal,
  proposeOnlyAdvisor,
  TIER3_ACTABLE_OPERATIONS,
} from './domain/tier3.js';
export type {
  Tier3Acceptance,
  Tier3Advisor,
  Tier3Outcome,
  Tier3Proposal,
  Tier3Request,
} from './domain/tier3.js';

export {
  adviseTier3,
  DEFAULT_TIER3_MODE,
  modelAdvisor,
  reviewTier3Proposal,
  TIER3_NO_OPERATION,
} from './application/tier3-advisor.js';
export type { Tier3CallOptions, Tier3Mode, Tier3Review } from './application/tier3-advisor.js';

export { Introspector } from './application/engine.js';

export { introspectionOperations } from './application/catalog.js';

/**
 * The repair the loop never selects on its own. It is exported beside the catalog because it
 * has the same shape as an operation and belongs to the same layer; what it does not have is a
 * measurable trigger, so a person names the merge to reverse.
 */
export { listUnmergeableRecords, runEntityUnmerge } from './application/operations/unmerge.js';
