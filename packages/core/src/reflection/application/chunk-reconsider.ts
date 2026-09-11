import { memberScopesCounted, scopesCounted } from './chunk-evidence.js';
import {
  suppressionCleared,
  type BlockedAttempt,
} from '../../infrastructure/sqlite/chunk-blocks.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  CENSUS_BLOCK_REASON,
  POLICY_BLOCK_REASONS,
  SUPPRESSION_BLOCK_REASONS,
} from '../domain/chunk-outcome.js';

/** Every reason whose prerequisite one of the tests below can ask the records about. */
export const RECONSIDERABLE_REASONS: readonly string[] = [
  ...new Set([...SUPPRESSION_BLOCK_REASONS, CENSUS_BLOCK_REASON, ...POLICY_BLOCK_REASONS]),
];

/**
 * Whether THIS attempt's own prerequisite has moved.
 *
 * `no_admissible_input` carries two causes and belongs to two sets, so it is asked both questions
 * in turn and an attempt neither can answer stays blocked. The order is the one the separate
 * passes had: a suppression that cleared is a state, and it answers before a bound.
 */
export function chunkBlockPrerequisiteMoved(
  db: SqliteHandle,
  attempt: BlockedAttempt,
  inForce: Record<string, number>,
): boolean {
  if (SUPPRESSION_BLOCK_REASONS.includes(attempt.reason) && suppressionCleared(db, attempt)) {
    return true;
  }
  if (attempt.reason === CENSUS_BLOCK_REASON) {
    return attempt.uncountedScopes.length > 0
      ? scopesCounted(db, attempt.uncountedScopes)
      : memberScopesCounted(db, attempt.members);
  }
  const policy: readonly string[] = POLICY_BLOCK_REASONS;
  return policy.includes(attempt.reason) && policyMoved(attempt.policy, inForce);
}

/**
 * Whether the bounds in force differ from the ones the refusal ran under.
 *
 * Only the numbers the attempt actually recorded are compared: a bound it never wrote down is a
 * bound nothing can say has moved. An attempt with no recorded policy is left blocked rather than
 * reconsidered on every run, which is what a timer would be.
 */
function policyMoved(
  recorded: Record<string, number> | undefined,
  inForce: Record<string, number>,
): boolean {
  if (recorded === undefined) {
    return false;
  }
  return Object.entries(recorded).some(([name, value]) => inForce[name] !== value);
}
