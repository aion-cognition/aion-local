import {
  countAutoMergedEntities,
  listEntityMergeProposals,
  wouldAutoApply,
  type GraphConnection,
  type SqliteHandle,
} from '@aion/core';

import type { Writer } from './output.js';

/**
 * What the merge-auto operation has done and would do, read back for `aion stats`. The open
 * counts and the knob state are a live rule evaluation; the auto-merged count is a graph read,
 * only ever as current as the last operation run.
 */
export type MergeShadowSnapshot = {
  readonly openWouldApply: number;
  readonly openWouldQueue: number;
  readonly autoMergeEnabled: boolean;
  /** Absent while Neo4j is down: the count comes from the graph. */
  readonly autoMergedCount?: number;
};

/**
 * The open-proposal counts and the knob state are rule evaluations, always available. The
 * auto-merged count is a graph read, so it is skipped while Neo4j is down rather than reported
 * wrong.
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

  return {
    openWouldApply,
    openWouldQueue,
    autoMergeEnabled,
    autoMergedCount,
  };
}

/**
 * What an auto-merge policy has done and would do next.
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
}
