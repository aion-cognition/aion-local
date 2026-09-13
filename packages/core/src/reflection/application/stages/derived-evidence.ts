import type { StageContext, StageOutcome } from '../../domain/stage.js';
import { publishDerivedNodeEvidence, type DerivedNode } from '../derived-node-evidence.js';

/**
 * Records the sources behind the nodes a stage just wrote, or the reason the stage failed.
 *
 * Fails closed and loudly, the way narration and the context-vector recomputation do. A pipeline
 * composed without a coordinator cannot record evidence at all, and returning `ok` over that would
 * report nodes whose sources nobody counted as fully extracted. Shared by the two extraction
 * stages so both fail the same way for the same reason.
 *
 * `undefined` means there is nothing to report and the caller's own outcome stands.
 */
export async function recordDerivedEvidence(
  ctx: StageContext,
  stage: string,
  derived: readonly DerivedNode[],
): Promise<StageOutcome | undefined> {
  if (derived.length === 0) {
    return undefined;
  }
  if (ctx.publications === undefined) {
    return { status: 'failed', summary: `${stage} is not composed: no publication coordinator` };
  }
  const outcome = await publishDerivedNodeEvidence(
    { publications: ctx.publications, now: ctx.now },
    { subject: ctx.episodeId, nodes: derived },
  );
  if (outcome.status !== 'published') {
    return {
      status: 'failed',
      summary: `${stage} could not record what its nodes came from: ${outcome.reason}`,
    };
  }
  return undefined;
}
