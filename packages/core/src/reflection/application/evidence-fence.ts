import {
  withheldWorkFor,
  type JudgmentEvidenceOutcome,
  type WithheldWork,
} from '../../evidence/application/judgment.js';
import { idAddress } from '../../evidence/domain/address.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { StageContext } from '../domain/stage.js';

/**
 * Whether the evidence a judgment ran on still stands, asked between the answer and the write.
 *
 * A correction, a resolved reference or a changed required source that arrived while the passes
 * were answering is new evidence, and the answer is not about it. Applying it anyway would close
 * a claim on a reading nobody holds any more, so the pair goes back to being owed instead.
 *
 * Every decision that discharges the pair asks it, an affirmative one and a negative one alike:
 * a refusal recorded on a reading nobody holds any more is as much this pair's answer as a
 * closure would be, and a stage that reports it as settled has lost the work.
 */
export function evidenceMoved(
  ctx: StageContext,
  evidence: JudgmentEvidenceOutcome,
): string | undefined {
  if (evidence.status !== 'ready' || ctx.evidence === undefined) {
    return undefined;
  }
  const check = ctx.evidence.confirm(evidence.revision);
  return check.status === 'current' ? undefined : check.status;
}

/**
 * What a decision made on moved evidence leaves behind: the same pair, the reading it lost, and
 * a disposition saying a rerun can decide it. A counter here would say a pair went unanswered
 * and nothing about which one or against what.
 */
export function movedWork(
  nodeIds: readonly string[],
  revision: EvidenceRevision | undefined,
  moved: string,
): WithheldWork | undefined {
  if (revision === undefined) {
    return undefined;
  }
  return withheldWorkFor(nodeIds, {
    kind: 'retryable',
    reason: `evidence_${moved}`,
    addresses: nodeIds.map((nodeId) => idAddress(nodeId)),
    revision,
  });
}
