/**
 * The evidence layer's public surface: the one resolver a process builds.
 *
 * A resolver is the seam every covered read goes through, and it is built once per process. A
 * composition that made a second would answer the same question through a second set of budgets
 * and caches, so the constructor is exported and the compositions share the instance.
 */

export { EvidenceResolver } from './application/resolver.js';

/** The seam the maintenance loop and the reflection pipeline judge through. */
export { CoveredJudgmentEvidence } from './application/covered-judgment.js';
