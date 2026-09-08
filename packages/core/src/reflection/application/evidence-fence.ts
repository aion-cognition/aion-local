import type { JudgmentEvidenceOutcome } from '../../evidence/application/judgment.js';
import type { StageContext } from '../domain/stage.js';

/**
 * Whether the evidence a judgment ran on still stands, asked between the answer and the write.
 *
 * A correction, a resolved reference or a changed required source that arrived while the passes
 * were answering is new evidence, and the answer is not about it. Applying it anyway would close
 * a claim on a reading nobody holds any more, so the pair goes back to being owed instead.
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
