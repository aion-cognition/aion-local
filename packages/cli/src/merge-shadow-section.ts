import {
  countAutoMergedEntities,
  entityMergePairState,
  listEntityMergeProposals,
  listLedgerEntries,
  mergeShadowLedgerKey,
  MERGE_SHADOW_LEDGER_PREFIX,
  readMergeShadowVerdict,
  summarizeMergeShadowAgreement,
  wouldAutoApply,
  type GraphConnection,
  type MergeShadowAgreement,
  type MergeShadowResolvedJudgment,
  type SqliteHandle,
} from '@aion/core';

import { short } from './format.js';
import type { Writer } from './output.js';

/**
 * What the merge-shadow judge and the merge-auto operation have recorded, read back for `aion
 * stats`. The open counts and the knob state are a live rule evaluation; the auto-merged count
 * and the agreement are graph reads, each only ever as current as the last operation run.
 */
export type MergeShadowSnapshot = {
  readonly openWouldApply: number;
  readonly openWouldQueue: number;
  readonly autoMergeEnabled: boolean;
  /** Absent while Neo4j is down: the count comes from the graph, like the agreement below. */
  readonly autoMergedCount?: number;
  /** Absent while Neo4j is down: the actual outcome behind each verdict comes from the graph. */
  readonly agreement?: MergeShadowAgreement;
};

/**
 * The open-proposal counts and the knob state are rule evaluations, always available. The
 * auto-merged count and the agreement are graph reads, so both are skipped while Neo4j is down
 * rather than reported wrong: neither can answer, and guessing would read every gap as the
 * policy's fault.
 */
export async function collectMergeShadow(
  db: SqliteHandle,
  connection: GraphConnection,
  reachable: boolean,
  autoMergeEnabled: boolean,
): Promise<MergeShadowSnapshot> {
  const proposals = listEntityMergeProposals(db);
  const open = proposals.filter((proposal) => proposal.resolvedAt === null);
  const openWouldApply = open.filter((proposal) =>
    wouldAutoApply(proposal.leftName, proposal.rightName),
  ).length;
  const openWouldQueue = open.length - openWouldApply;

  if (!reachable) {
    return { openWouldApply, openWouldQueue, autoMergeEnabled };
  }

  const autoMergedCount = await countAutoMergedEntities(connection.driver);

  const verdicts = new Map(
    listLedgerEntries(db, MERGE_SHADOW_LEDGER_PREFIX).map((entry) => [entry.key, entry.summary]),
  );
  const judgments: MergeShadowResolvedJudgment[] = [];
  for (const proposal of proposals) {
    if (proposal.resolvedAt === null) {
      continue;
    }
    const verdict = readMergeShadowVerdict(verdicts.get(mergeShadowLedgerKey(proposal.id)));
    if (verdict === undefined) {
      continue;
    }
    const pairState = await entityMergePairState(
      connection.driver,
      proposal.leftId,
      proposal.rightId,
    );
    judgments.push({
      proposalId: proposal.id,
      leftName: proposal.leftName,
      leftType: proposal.leftType,
      rightName: proposal.rightName,
      rightType: proposal.rightType,
      verdict,
      actuallyMerged: pairState.merged,
      bothCurrent: pairState.bothCurrent,
    });
  }

  return {
    openWouldApply,
    openWouldQueue,
    autoMergeEnabled,
    autoMergedCount,
    agreement: summarizeMergeShadowAgreement(judgments),
  };
}

/**
 * What an auto-merge policy has done and would have done, next to what people actually decided.
 * Agreement reads honest at zero: a fresh substrate with no shadow-judged resolutions yet says so
 * instead of printing "0 of 0" as if it meant something.
 */
export function renderMergeShadow(snapshot: MergeShadowSnapshot, write: Writer): void {
  write('');
  write('merge shadow');
  write(
    `  open        ${String(snapshot.openWouldApply)} would auto-apply, ` +
      `${String(snapshot.openWouldQueue)} would queue`,
  );
  const autoMergedCount =
    snapshot.autoMergedCount === undefined
      ? 'count unavailable while Neo4j is down'
      : `${String(snapshot.autoMergedCount)} applied to date`;
  write(`  auto-merge  ${snapshot.autoMergeEnabled ? 'on' : 'off'}, ${autoMergedCount}`);
  if (snapshot.agreement === undefined) {
    write('  agreement   unavailable while Neo4j is down');
    return;
  }
  if (snapshot.agreement.total === 0 && snapshot.agreement.staleCleared === 0) {
    write('  agreement   no shadow verdicts yet');
    return;
  }
  const staleNote =
    snapshot.agreement.staleCleared === 0
      ? ''
      : `, ${String(snapshot.agreement.staleCleared)} stale-cleared not scored`;
  write(
    `  agreement   ${String(snapshot.agreement.agreeing)} of ` +
      `${String(snapshot.agreement.total)}${staleNote}`,
  );
  for (const disagreement of snapshot.agreement.disagreements) {
    write(
      `    ${short(disagreement.proposalId)}  ${disagreement.leftName} (${disagreement.leftType}) / ` +
        `${disagreement.rightName} (${disagreement.rightType}): shadow said ${disagreement.verdict}, ` +
        `actual was ${disagreement.actuallyMerged ? 'merged' : 'not merged'}`,
    );
  }
}
