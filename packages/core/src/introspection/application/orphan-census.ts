import type { Driver } from 'neo4j-driver';

import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import {
  findOrphanNodes,
  findOrphanRelinkTargets,
  type OrphanRelinkTarget,
} from '../../infrastructure/graph/topology-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { findEntityMergeProposalsForNode } from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { recordOrphanQualification } from '../../infrastructure/sqlite/orphan-observations.js';
import { findSupersessionProposalsForNode } from '../../infrastructure/sqlite/supersession-proposals.js';
import {
  decideOrphan,
  type OrphanCandidate,
  type OrphanDecision,
} from '../domain/orphan-policy.js';

/**
 * One reading of the disconnected population, and the qualification clock it keeps.
 *
 * The clock belongs here rather than inside the repair run: what it measures is CONTINUOUS
 * certification, so it has to be taken on the observation cadence, not on the cadence of a repair
 * that only runs when there is something to repair. A run that started its own clock would find
 * every node young on its first visit and could never reach the threshold it is scored against.
 *
 * Nothing here suppresses anything. It certifies, records what it certified, and counts the
 * demand a run could act on now; the run re-derives all of it under the guard before it writes.
 */

export type OrphanCensusDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
};

export type OrphanCensusOptions = {
  readonly limit: number;
  readonly now: Date;
  readonly forgetAfterDays: number;
  readonly policyRevision: number;
};

export type OrphanCensusEntry = {
  readonly nodeId: string;
  readonly decision: OrphanDecision;
  readonly relinkTarget: OrphanRelinkTarget | undefined;
};

export type OrphanCensus = {
  /** Nodes the graph reported as disconnected on this page. */
  readonly disconnected: number;
  /** Demand a repair run could act on now: due relinks and mature qualified forgets. */
  readonly actionable: number;
  /** Certified unsupported and still inside its qualification window. */
  readonly unsupportedYoung: number;
  /** Nothing has counted the scopes that would carry their support. */
  readonly unknownSupport: number;
  readonly entries: readonly OrphanCensusEntry[];
};

const EMPTY: OrphanCensus = {
  disconnected: 0,
  actionable: 0,
  unsupportedYoung: 0,
  unknownSupport: 0,
  entries: [],
};

function protectedByPendingWork(db: SqliteHandle, nodeId: string): boolean {
  const merges = findEntityMergeProposalsForNode(db, nodeId);
  if (merges.some((proposal) => proposal.resolvedAt === null)) {
    return true;
  }
  return findSupersessionProposalsForNode(db, nodeId).some(
    (proposal) => proposal.resolvedAt === null,
  );
}

/**
 * Reads the page, certifies each node against the records, records what it certified, and
 * returns the demand.
 *
 * A node that certifies as supported or as unknown keeps a qualification row of its own with its
 * clock reset, so a later loss of support starts a fresh window rather than inheriting one that
 * was running while the node was still held up.
 */
export async function readOrphanCensus(
  deps: OrphanCensusDeps,
  options: OrphanCensusOptions,
): Promise<OrphanCensus> {
  const disconnected = await findOrphanNodes(deps.driver, options.limit);
  if (disconnected.length === 0) {
    return EMPTY;
  }
  const targets = new Map(
    (
      await findOrphanRelinkTargets(
        deps.driver,
        disconnected.map((orphan) => orphan.id),
      )
    ).map((target) => [target.orphanId, target]),
  );

  const entries: OrphanCensusEntry[] = [];
  let unsupportedYoung = 0;
  let unknownSupport = 0;
  for (const orphan of disconnected) {
    const reading = certifyNodeSupport(deps.db, orphan.id);
    const observation = recordOrphanQualification(deps.db, {
      nodeId: orphan.id,
      evidenceRevision: reading.evidenceRevision,
      policyRevision: options.policyRevision,
      disposition: reading.support,
      reason: reading.reason,
      now: options.now,
    });
    const candidate: OrphanCandidate = {
      nodeId: orphan.id,
      support: reading.support,
      relinkTarget: targets.get(orphan.id)?.targetId,
      protectedByPendingWork: protectedByPendingWork(deps.db, orphan.id),
      qualifiedSince:
        reading.support === 'unsupported' ? new Date(observation.firstVerifiedAt) : undefined,
    };
    const decision = decideOrphan(candidate, {
      now: options.now,
      forgetAfterDays: options.forgetAfterDays,
    });
    if (reading.support === 'unknown') {
      unknownSupport += 1;
    }
    if (reading.support === 'unsupported' && decision.action === 'hold') {
      unsupportedYoung += 1;
    }
    entries.push({ nodeId: orphan.id, decision, relinkTarget: targets.get(orphan.id) });
  }

  return {
    disconnected: disconnected.length,
    actionable: entries.filter((entry) => entry.decision.actionable).length,
    unsupportedYoung,
    unknownSupport,
    entries,
  };
}
