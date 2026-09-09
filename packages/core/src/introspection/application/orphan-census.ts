import type { Driver } from 'neo4j-driver';
import { z } from 'zod';

import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import { GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import {
  findOrphanNodes,
  findOrphanRelinkTargets,
  type OrphanNode,
  type OrphanRelinkTarget,
} from '../../infrastructure/graph/topology-queries.js';
import { committedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { findEntityMergeProposalsForNode } from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { readScopeMirror } from '../../infrastructure/sqlite/evidence-scope.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  clearQualificationsOutside,
  lastExaminedAt,
  recordOrphanQualification,
} from '../../infrastructure/sqlite/orphan-observations.js';
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
  /**
   * Whether the graph's enumeration ran out before the window did.
   *
   * It describes the ENUMERATION and nothing else. Every candidate it returned was listed; only
   * the page inside it was evaluated, so this cannot certify a global zero and a caller must not
   * read it as one.
   */
  readonly enumerationComplete: boolean;
  readonly entries: readonly OrphanCensusEntry[];
};

const EMPTY: OrphanCensus = {
  disconnected: 0,
  actionable: 0,
  unsupportedYoung: 0,
  unknownSupport: 0,
  enumerationComplete: true,
  entries: [],
};

/** Where the next read starts, so a bounded window advances instead of repeating its front. */
const POSITION_KEY = 'orphan-census:position';

const PositionSchema = z.object({ skip: z.number().int().nonnegative() });

function readPosition(db: SqliteHandle): number {
  const parsed = PositionSchema.safeParse(getLedgerEntry(db, POSITION_KEY)?.summary);
  return parsed.success ? parsed.data.skip : 0;
}

function writePosition(db: SqliteHandle, skip: number): void {
  markLedgerApplied(db, POSITION_KEY, { skip });
}

/**
 * How many candidates one read enumerates for every node it will examine.
 *
 * The graph orders oldest first, so a bound taken at the limit hands back the same held node
 * forever. Choosing within a window on how long ago each node was last examined rotates the front
 * of that window; the persisted position below is what moves the window itself, so a population
 * larger than one window is still reached. A bigger window would only move the wall.
 */
const NOMINATION_WINDOW = 10;

/** How many unresolved proposals hold this node up, which is a dependency of the qualification. */
export function pendingProposals(db: SqliteHandle, nodeId: string): number {
  const merges = findEntityMergeProposalsForNode(db, nodeId).filter(
    (proposal) => proposal.resolvedAt === null,
  );
  const supersessions = findSupersessionProposalsForNode(db, nodeId).filter(
    (proposal) => proposal.resolvedAt === null,
  );
  return merges.length + supersessions.length;
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
  const window = options.limit * NOMINATION_WINDOW;
  // The read resumes where the last one stopped. The enumeration is ordered and bounded, so the
  // position is how far into that order this read starts; without it the same front page comes
  // back forever and a population larger than one window is never examined.
  const skip = readPosition(deps.db);
  const enumerated = await findOrphanNodes(deps.driver, skip + window);
  const enumerationComplete = enumerated.length < skip + window;
  const candidates = enumerated.slice(skip);
  // Back to the front once the enumeration ran out, so the walk cycles rather than running off
  // the end of a population that is shorter than the position it reached.
  writePosition(deps.db, enumerationComplete || candidates.length === 0 ? 0 : skip + window);
  if (enumerationComplete) {
    // The whole population was read, so a node that carries a qualification and is not in it has
    // left the population. Its window is void: the node was connected, or supported, or gone for
    // some part of the interval, and none of that is continuous certification.
    clearQualificationsOutside(
      deps.db,
      enumerated.map((orphan) => orphan.id),
    );
  }
  if (candidates.length === 0) {
    return EMPTY;
  }
  const disconnected = leastRecentlyExamined(deps.db, candidates).slice(0, options.limit);
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
    const pending = pendingProposals(deps.db, orphan.id);
    // The node's own semantic state is a graph fact, and the mirror is the only record of what
    // the graph said and when. Without one there is no reading to qualify against: the node may
    // have been superseded, reopened or rewritten inside the window, and a qualification taken
    // over that interval would be a certification of an interval nobody observed.
    const state = readScopeMirror(deps.db, {
      endpointId: orphan.id,
      relationClass: GRAPH_NODE_SCOPE,
    });
    const support = state === undefined ? 'unknown' : reading.support;
    const reason =
      state === undefined ? 'no mirrored node state to qualify against' : reading.reason;
    const target = certifiedRelinkTarget(deps.db, orphan.id, targets.get(orphan.id));
    const observation = recordOrphanQualification(deps.db, {
      nodeId: orphan.id,
      evidenceRevision: {
        ...qualificationEvidence(reading.evidenceRevision, pending),
        [GRAPH_NODE_SCOPE]:
          state === undefined ? 'absent' : `${String(state.mirroredRevision)}@${state.mirroredAt}`,
        'graph:disconnected_since': orphan.txFrom?.toISOString() ?? 'unknown',
      },
      policyRevision: options.policyRevision,
      disposition: support,
      reason,
      now: options.now,
    });
    const candidate: OrphanCandidate = {
      nodeId: orphan.id,
      support,
      relinkTarget: target?.targetId,
      protectedByPendingWork: pending > 0,
      qualifiedSince: support === 'unsupported' ? new Date(observation.firstVerifiedAt) : undefined,
    };
    const decision = decideOrphan(candidate, {
      now: options.now,
      forgetAfterDays: options.forgetAfterDays,
    });
    if (support === 'unknown') {
      unknownSupport += 1;
    }
    if (support === 'unsupported' && decision.action === 'hold') {
      unsupportedYoung += 1;
    }
    entries.push({ nodeId: orphan.id, decision, relinkTarget: target });
  }

  return {
    disconnected: candidates.length,
    actionable: entries.filter((entry) => entry.decision.actionable).length,
    unsupportedYoung,
    unknownSupport,
    enumerationComplete,
    entries,
  };
}

/**
 * The target a repair may reach for, or nothing.
 *
 * The two-hop graph rules find a candidate; they do not prove one. What certifies the pair is the
 * records, at the same vantage the orphan's own support was read at: some committed source stands
 * behind BOTH ends, which is the shared-source rule stated logically instead of walked. A target
 * nothing accounts for is a guess, and a guessed edge made out of the same silence a forget would
 * have been made out of is still a claim: the node is preserved and the edge withheld.
 */
function certifiedRelinkTarget(
  db: SqliteHandle,
  orphanId: string,
  target: OrphanRelinkTarget | undefined,
): OrphanRelinkTarget | undefined {
  if (target === undefined) {
    return undefined;
  }
  const behindOrphan = new Set(committedIncidenceForNode(db, orphanId).map((row) => row.sourceId));
  if (behindOrphan.size === 0) {
    return undefined;
  }
  const shared = committedIncidenceForNode(db, target.targetId).some((row) =>
    behindOrphan.has(row.sourceId),
  );
  return shared ? target : undefined;
}

/**
 * Every dependency a qualification rests on that the records can re-derive: the support scopes
 * the reading rested on, and the proposals holding the node up.
 *
 * Positive and negative both, so a proposal arriving is as much a reset as a scope moving. The
 * physical disconnection reading is recorded beside these but is not here: the write re-derives
 * that one from the graph in its own statement, which is stronger than comparing a value read
 * before the batch.
 */
export function qualificationEvidence(
  supportRevision: Readonly<Record<string, string>>,
  pendingProposalCount: number,
): Readonly<Record<string, string>> {
  return { ...supportRevision, 'proposals:pending': String(pendingProposalCount) };
}

/** Whether every dependency the record names still reads the way it did. */
export function qualificationHolds(
  recorded: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(current).every(([scope, token]) => recorded[scope] === token);
}

/**
 * The window, ordered by how long ago each node was last examined, never-examined first.
 *
 * The graph's own order is oldest first and never moves, so a node the records cannot decide
 * sits at the front of every page. Ordering on the examination itself is what makes a bounded
 * read reach the rest of the population.
 */
function leastRecentlyExamined(
  db: SqliteHandle,
  candidates: readonly OrphanNode[],
): readonly OrphanNode[] {
  const examined = new Map(
    lastExaminedAt(
      db,
      candidates.map((orphan) => orphan.id),
    ).map((row) => [row.nodeId, row.updatedAt]),
  );
  return [...candidates].sort((left, right) => {
    const a = examined.get(left.id) ?? '';
    const b = examined.get(right.id) ?? '';
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
}
