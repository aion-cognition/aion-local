import { normalizeEntityName } from '../../reflection/domain/entity-extraction.js';

/**
 * The verdict an auto-merge policy would reach on a cross-type entity-merge proposal, judged
 * without ever writing to the graph or resolving the proposal it looks at. A shadow earns
 * trust by being compared against what a person actually decided; only after that comparison
 * holds up does anyone arm the real thing.
 *
 * Measured against the proposals a person has already reviewed: every pair whose names came
 * out equal after normalization was a merge the person went on to approve, and every pair the
 * person turned down had different names and a similarity below 0.91. Type never distinguishes
 * the two groups, because a cross-type proposal only exists once its two sides already matched
 * on name; name is the whole criterion.
 *
 * The comparison is exact equality on the same fold the graph's `(name_norm, type)` uniqueness
 * key is built from, not the character-overlap rule in `entity-identity.ts` that finds merge
 * *candidates*. That rule scores "UserPromptSubmit" against "UserPromptSubmit hook" above its
 * own threshold; a shadow that reused it would auto-apply a pair no reviewer approved.
 */
export function wouldAutoApply(leftName: string, rightName: string): boolean {
  return normalizeEntityName(leftName) === normalizeEntityName(rightName);
}

export type MergeShadowVerdict = 'would_apply' | 'would_queue';

export function verdictOf(wouldApply: boolean): MergeShadowVerdict {
  return wouldApply ? 'would_apply' : 'would_queue';
}

function isMergeShadowVerdict(value: unknown): value is MergeShadowVerdict {
  return value === 'would_apply' || value === 'would_queue';
}

/** Reads a verdict back from a ledger entry's stored payload; `undefined` for anything else. */
export function readMergeShadowVerdict(summary: unknown): MergeShadowVerdict | undefined {
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { verdict } = summary as { verdict?: unknown };
  return isMergeShadowVerdict(verdict) ? verdict : undefined;
}

/**
 * Permanent, not time-bucketed: a proposal is judged once and never revisited once it has a
 * key here. Rows resolved before the shadow existed get judged after the fact, which the
 * deterministic rule makes equivalent; the entry's payload says which order it was. `aion
 * stats` reads the same prefix back to compare every verdict against what actually happened.
 */
export const MERGE_SHADOW_LEDGER_PREFIX = 'merge_shadow:';

export function mergeShadowLedgerKey(proposalId: string): string {
  return `${MERGE_SHADOW_LEDGER_PREFIX}${proposalId}`;
}

/**
 * Whether the verdict matches what a resolved proposal actually became. A person who approved
 * a merge the shadow would also have applied agrees; a person who dismissed a pair the shadow
 * would have left queued for review also agrees. Anything else is a disagreement to look at
 * before arming the policy.
 */
export function verdictAgrees(verdict: MergeShadowVerdict, actuallyMerged: boolean): boolean {
  return (verdict === 'would_apply') === actuallyMerged;
}

export type MergeShadowResolvedJudgment = {
  readonly proposalId: string;
  readonly leftName: string;
  readonly leftType: string;
  readonly rightName: string;
  readonly rightType: string;
  readonly verdict: MergeShadowVerdict;
  /** From the graph: a `SUPERSEDES` edge with signal `entity_merge` between the two ids. */
  readonly actuallyMerged: boolean;
};

export type MergeShadowAgreement = {
  readonly total: number;
  readonly agreeing: number;
  readonly disagreements: readonly MergeShadowResolvedJudgment[];
};

/** The pure half of the stats agreement surface: counts and names, no ledger or graph read. */
export function summarizeMergeShadowAgreement(
  judgments: readonly MergeShadowResolvedJudgment[],
): MergeShadowAgreement {
  const disagreements = judgments.filter(
    (judgment) => !verdictAgrees(judgment.verdict, judgment.actuallyMerged),
  );
  return {
    total: judgments.length,
    agreeing: judgments.length - disagreements.length,
    disagreements,
  };
}
