import {
  blockedAttempts,
  reconsiderableBlockedAttempts,
  type BlockedAttempt,
} from '../../../infrastructure/sqlite/chunk-nomination.js';
import {
  clearRevisionBlock,
  CHUNK_REVISION_FAMILY,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import {
  memberScopesCounted,
  scopesCounted,
} from '../../../reflection/application/chunk-evidence.js';
import {
  CENSUS_BLOCK_REASON,
  POLICY_BLOCK_REASONS,
  SUPPRESSION_BLOCK_REASONS,
} from '../../../reflection/domain/chunk-outcome.js';
import type { OperationContext } from '../../domain/operation.js';

/**
 * Clears the blocks whose recorded prerequisite no longer holds.
 *
 * Each reason is rechecked against the record its own prerequisite lives in. A suppression block
 * clears on a member that was proved forgotten and is not now; a census block clears when the
 * scopes it could not count are counted. Sharing one test between them would have done both
 * wrongs at once — leaving a censused chunk blocked forever, and offering a budget refusal that
 * merely shares a reason word with a suppression as though a forget had cleared.
 *
 * Clearing is not attempting: the revision goes back into the ordinary enumeration and takes its
 * turn there by capture position, so a reconsidered attempt cannot jump the older backlog either.
 */
export function reconsiderBlockedAttempts(
  ctx: OperationContext,
  limit: number,
  inForce: Record<string, number>,
): number {
  const suppression = reconsiderableBlockedAttempts(ctx.db, {
    reasons: SUPPRESSION_BLOCK_REASONS,
    limit,
  });
  const census = blockedAttempts(ctx.db, { reasons: [CENSUS_BLOCK_REASON], limit }).filter(
    (attempt: BlockedAttempt) =>
      attempt.uncountedScopes.length > 0
        ? scopesCounted(ctx.db, attempt.uncountedScopes)
        : memberScopesCounted(ctx.db, attempt.members),
  );
  const policy = blockedAttempts(ctx.db, { reasons: POLICY_BLOCK_REASONS, limit }).filter(
    (attempt: BlockedAttempt) => policyMoved(attempt.policy, inForce),
  );
  let cleared = 0;
  const seen = new Set<string>();
  for (const attempt of [...suppression, ...census, ...policy]) {
    const key = `${attempt.chunkId}:${String(attempt.revisionNo)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (clearRevisionBlock(ctx.db, CHUNK_REVISION_FAMILY, attempt.chunkId, attempt.revisionNo)) {
      cleared += 1;
      ctx.logger.info(
        { chunkId: attempt.chunkId, revisionNo: attempt.revisionNo, reason: attempt.reason },
        'narrative seal reconsidered a blocked attempt whose prerequisite moved',
      );
    }
  }
  return cleared;
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
