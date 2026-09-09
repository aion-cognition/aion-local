import { ownershipIncidence, ownershipSummaryFor } from '../../evidence/application/ownership.js';
import { ownershipEvidenceVersion } from '../../evidence/domain/ownership.js';
import { projectOwnershipSummary } from '../../infrastructure/graph/ownership-summary-queries.js';
import type { PublicationContext } from '../../infrastructure/publication/types.js';
import type { CommittedIncidence } from '../../infrastructure/sqlite/committed-evidence.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';

/**
 * Writes one node's ownership summary as it will stand once the caller's operation lands.
 *
 * The committed view cannot see a row the operation prepared, so the summary is derived from
 * both. `censusEstablished` is what the scopes will say after the acknowledgment: a source pass
 * establishes nothing and reports what the seal has already counted, and the seal reports the
 * count it is about to make.
 */
export async function projectLegacyOwnership(
  context: PublicationContext,
  nodeId: string,
  rows: readonly CommittedIncidence[],
  censusEstablished: boolean,
): Promise<boolean> {
  const pairing = readSubstratePairing(context.db);
  if (pairing === undefined || context.sequence === null) {
    throw new Error('the ownership projection needs a paired substrate and a sequence');
  }
  const check = checkPresentCoverage(context.db, context.now);
  if (check.status !== 'checked') {
    throw new Error(`the ownership projection cannot read under ${check.refusal.reason}`);
  }
  const merged = [...ownershipIncidence(context.db, [nodeId], check.context)];
  for (const row of rows) {
    if (row.nodeId !== nodeId) {
      continue;
    }
    if (!merged.some((held) => held.sourceId === row.sourceId && held.role === row.role)) {
      merged.push(row);
    }
  }
  const summary = ownershipSummaryFor(context.db, nodeId, merged, check.context, {
    censusEstablished,
  });
  return projectOwnershipSummary(context.graph, {
    nodeId,
    sessions: summary.sessions,
    unknownAttribution: summary.unknownAttribution,
    censusEstablished: summary.censusEstablished,
    evidenceVersion: ownershipEvidenceVersion(summary),
    sequence: context.sequence,
    substrateId: pairing.substrateId,
  });
}
