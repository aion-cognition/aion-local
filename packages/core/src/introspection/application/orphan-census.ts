import type { Driver } from 'neo4j-driver';
import { z } from 'zod';

import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import { GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import {
  findOrphanNodes,
  findOrphanRelinkTargets,
  nodeAssociationHistory,
  type OrphanNode,
  type OrphanPosition,
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
   * Whether this page reached the end of the graph's enumeration.
   *
   * It describes the ENUMERATION and nothing else, for one page of a resumable walk. Only the
   * nodes inside the page were evaluated, and a page that started mid-walk says nothing about
   * what came before it, so this cannot certify a global zero and a caller must not read it as
   * one.
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

/** Where the next read resumes, so a bounded page advances instead of repeating its front. */
const POSITION_KEY = 'orphan-census:position';

const PositionSchema = z.object({
  id: z.string().min(1),
  txFrom: z.string().nullable(),
});

function readPosition(db: SqliteHandle): OrphanPosition | undefined {
  const parsed = PositionSchema.safeParse(getLedgerEntry(db, POSITION_KEY)?.summary);
  if (!parsed.success) {
    return undefined;
  }
  return {
    id: parsed.data.id,
    txFrom: parsed.data.txFrom === null ? undefined : new Date(parsed.data.txFrom),
  };
}

function writePosition(db: SqliteHandle, position: OrphanPosition | undefined): void {
  markLedgerApplied(
    db,
    POSITION_KEY,
    position === undefined
      ? null
      : { id: position.id, txFrom: position.txFrom?.toISOString() ?? null },
  );
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

/** What a reader records where a history it needs cannot be read at all. */
export const UNKNOWN_HISTORY = 'unknown';

/**
 * Why this node cannot be qualified at all, or nothing when every history it rests on reads.
 *
 * Both answers are about intervals rather than about the present: a node with no mirrored state,
 * and a node whose associations nobody can read, are both nodes whose last months are unaccounted
 * for. Unknown here can neither start a window nor preserve one, because the alternative is a
 * suppression with no reopen path resting on an interval nobody observed.
 */
function missingHistory(state: string, associations: string | undefined): string | undefined {
  if (state === 'absent') {
    return 'no mirrored node state to qualify against';
  }
  if (associations === undefined) {
    return 'no association history to qualify against';
  }
  return undefined;
}

/** What the proposal records say about one node: what holds it up now, and what has moved. */
export type ProposalStanding = {
  /** Unresolved rows, which are what protects the node from a repair right now. */
  readonly pending: number;
  /** Rows naming it at all, resolved ones included. */
  readonly rows: number;
  /** Lifecycle transitions those rows have been through, summed. */
  readonly revisions: number;
};

/**
 * Both readings from one pass over the rows that name this node.
 *
 * The protection and the history are two questions about the same records, and asking them
 * separately read the same rows twice per node per page.
 */
export function proposalStanding(db: SqliteHandle, nodeId: string): ProposalStanding {
  const rows = [
    ...findEntityMergeProposalsForNode(db, nodeId),
    ...findSupersessionProposalsForNode(db, nodeId),
  ];
  return {
    pending: rows.filter((proposal) => proposal.resolvedAt === null).length,
    rows: rows.length,
    revisions: rows.reduce((total, proposal) => total + proposal.lifecycleRev, 0),
  };
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
  // The read resumes where the last one stopped, as a keyset the QUERY carries. Every page costs
  // the same bounded read; fetching a longer prefix and discarding its head would read the whole
  // backlog to reach its tail, which is the bound this exists to hold.
  const after = readPosition(deps.db);
  const candidates = await findOrphanNodes(deps.driver, window, after);
  const enumerationComplete = candidates.length < window;
  const last = candidates[candidates.length - 1];
  // Back to the front once the enumeration ran out, so the walk cycles rather than stalling at
  // the end of a population shorter than the position it reached.
  writePosition(
    deps.db,
    enumerationComplete || last === undefined ? undefined : { id: last.id, txFrom: last.txFrom },
  );
  // Only a page that started at the front AND ended short saw the whole population. Absence from
  // one page in the middle of a walk is not absence from the population, and clearing on it
  // would void a window because the read happened to stop before reaching the node.
  if (after === undefined && enumerationComplete) {
    // A node that carries a qualification and is not in the population has left it. Its window is
    // void: the node was connected, or supported, or gone for some part of the interval, and
    // none of that is continuous certification.
    clearQualificationsOutside(
      deps.db,
      candidates.map((orphan) => orphan.id),
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

  // The association history of the whole page in one read, because what an open-edge reading
  // cannot see is exactly what the window has to survive: an association that arrived and left
  // between two observations.
  const history = await nodeAssociationHistory(
    deps.driver,
    disconnected.map((orphan) => orphan.id),
  );

  const entries: OrphanCensusEntry[] = [];
  let unsupportedYoung = 0;
  let unknownSupport = 0;
  for (const orphan of disconnected) {
    const reading = certifyNodeSupport(deps.db, orphan.id);
    const standing = proposalStanding(deps.db, orphan.id);
    // The node's own semantic state is a graph fact, and the mirror is the only record of what
    // the graph said and when. Without one there is no reading to qualify against: the node may
    // have been superseded, reopened or rewritten inside the window, and a qualification taken
    // over that interval would be a certification of an interval nobody observed.
    const state = nodeStateToken(deps.db, orphan.id);
    const associations = history.get(orphan.id);
    const missing = missingHistory(state, associations);
    const support = missing === undefined ? reading.support : 'unknown';
    const reason = missing ?? reading.reason;
    const target = certifiedRelinkTarget(deps.db, orphan.id, targets.get(orphan.id));
    const observation = recordOrphanQualification(deps.db, {
      nodeId: orphan.id,
      evidenceRevision: {
        ...qualificationEvidence(deps.db, orphan.id, reading.evidenceRevision, {
          proposals: proposalHistoryToken(standing),
          associations: associations ?? UNKNOWN_HISTORY,
        }),
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
      protectedByPendingWork: standing.pending > 0,
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
export function certifiedRelinkTarget(
  db: SqliteHandle,
  orphanId: string,
  target: OrphanRelinkTarget | undefined,
): OrphanRelinkTarget | undefined {
  if (target === undefined) {
    return undefined;
  }
  const behindOrphan = new Set(currentSourcesBehind(db, orphanId));
  if (behindOrphan.size === 0) {
    return undefined;
  }
  return currentSourcesBehind(db, target.targetId).some((sourceId) => behindOrphan.has(sourceId))
    ? target
    : undefined;
}

/**
 * The sources whose incidence on a node is CURRENT.
 *
 * A closed row is a record that a source once stood behind this node and no longer does. It is
 * conservative support for keeping the node, and it is not a present-tense relation: authorizing
 * a new edge on it would write today's claim out of a relationship somebody ended.
 */
function currentSourcesBehind(db: SqliteHandle, nodeId: string): readonly string[] {
  return committedIncidenceForNode(db, nodeId)
    .filter((row) => row.currency === 'open')
    .map((row) => row.sourceId);
}

/**
 * Every proposal that has ever named this node, whether or not one is open now.
 *
 * A count of the open ones is not a version, and neither are the stamps: a proposal that resolves,
 * reopens and resolves again under one supplied clock puts both the count and every timestamp back
 * where they started, and the interval it ran in is one where somebody was deciding whether this
 * node survives at all. What the token carries is the rows and the lifecycle counters their own
 * writers advance in the transaction that moves them, so each of those transitions moves it.
 */
export function proposalHistoryToken(standing: ProposalStanding): string {
  if (standing.rows === 0) {
    return 'none';
  }
  return `${String(standing.rows)}@${String(standing.revisions)}`;
}

/**
 * Every dependency a qualification rests on that the records can re-derive: the support scopes
 * the reading rested on, the proposal history, the node's own state and the association history.
 *
 * Versions rather than counts, and negative reads as much as positive ones. A window is a claim
 * about an INTERVAL, so what it rests on has to move whenever anything inside that interval
 * moved: a proposal that opened and closed, or an association that arrived and left, leaves the
 * counts exactly where they were and the history somewhere else.
 *
 * The physical disconnection reading is recorded beside these but is not here: the write
 * re-derives that one from the graph in its own statement, which is stronger than comparing a
 * value read before the batch.
 */
export function qualificationEvidence(
  db: SqliteHandle,
  nodeId: string,
  supportRevision: Readonly<Record<string, string>>,
  history: { readonly proposals: string; readonly associations: string },
): Readonly<Record<string, string>> {
  return {
    ...supportRevision,
    'proposals:history': history.proposals,
    'associations:history': history.associations,
    [GRAPH_NODE_SCOPE]: nodeStateToken(db, nodeId),
  };
}

/**
 * What the graph last said about this node's own state, and when it said it.
 *
 * One producer, because the reader that qualifies a window and the writer that acts on it have to
 * compare the same thing: a proof reconstructed without this key is a proof that never checks it.
 * An absent mirror is a value, not a gap to skip: it says nobody has a reading, and that is a
 * change from having had one.
 */
export function nodeStateToken(db: SqliteHandle, nodeId: string): string {
  const state = readScopeMirror(db, { endpointId: nodeId, relationClass: GRAPH_NODE_SCOPE });
  return state === undefined ? 'absent' : `${String(state.mirroredRevision)}@${state.mirroredAt}`;
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
