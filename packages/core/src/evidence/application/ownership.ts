import { readRelationScope, sourcePartsDependency, sourceStateDependency } from './dependencies.js';
import { eligibilityAt, locateAddress } from './source-gate.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNodes,
  committedIncidenceForNodesAt,
  type CommittedIncidence,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { idAddress } from '../domain/address.js';
import { evaluateInterval, type IntervalAxis, type IntervalProof } from '../domain/interval.js';
import { OWNERSHIP_SCOPES, type OwnershipSummary } from '../domain/ownership.js';
import { durableRoleScope } from '../domain/scopes.js';

/**
 * Who a memory belongs to, derived from the incidence records rather than from graph hops.
 *
 * Every contribution is judged the same way: the recorded interval decides whether it held at the
 * vantage the request named, and the source's own state chain decides whether it may be quoted at
 * all. That holds for the sources incidence names and for the node's own identity, so forgetting
 * a capture removes it from the verdict wherever it entered.
 *
 * Uncertainty is its own answer. A bound the records never stated, a source with no record and an
 * uncounted scope all leave ownership unknown, which keeps the memory eligible without asserting
 * that anybody outside the session wrote it.
 */

const OWNERSHIP_ROLES = new Set<string>(OWNERSHIP_SCOPES.map((entry) => entry.role));

/** Whether every ownership scope on this node has an established census and a published token. */
export function ownershipCensusEstablished(db: SqliteHandle, nodeId: string): boolean {
  return OWNERSHIP_SCOPES.every(
    ({ role, direction }) =>
      readRelationScope(db, {
        kind: 'node',
        endpointId: nodeId,
        scope: durableRoleScope(role, direction),
        empty: false,
      }).status === 'verified',
  );
}

/**
 * The incidence a serving read is entitled to, at the vantage the request named.
 *
 * A question pinned in either timeline reads the version chain. The present projection carries
 * neither the sources the node had then nor the recorded intervals that say so, and a world-only
 * question needs those intervals exactly as much as a knowledge-time one does.
 */
export function ownershipIncidence(
  db: SqliteHandle,
  nodeIds: readonly string[],
  context: CheckedReadContext,
): readonly CommittedIncidence[] {
  return isTimeTravel(context.mode)
    ? committedIncidenceForNodesAt(db, nodeIds, context.mode.knownAt)
    : committedIncidenceForNodes(db, nodeIds);
}

/** One incidence row's interval as the records stated it, for the one evaluator that judges it. */
function proofOf(row: CommittedIncidence): IntervalProof {
  return {
    closed: row.currency === 'closed',
    ...(row.validFrom === undefined ? {} : { validFrom: row.validFrom }),
    ...(row.validUntil === undefined ? {} : { validUntil: row.validUntil }),
    ...(row.txFrom === undefined ? {} : { txFrom: row.txFrom }),
    ...(row.txUntil === undefined ? {} : { txUntil: row.txUntil }),
  };
}

/** What one ownership derivation decided, could not place, and read to decide it. */
export type OwnershipReading = {
  readonly summary: OwnershipSummary;
  /** Axes a recorded proof could not place, so nothing reports the remainder as the whole set. */
  readonly unplaced: readonly IntervalAxis[];
  /** Every state and mapping scope the derivation consulted, for the revision a writer fences on. */
  readonly dependencies: readonly EvidenceDependency[];
};

/** What one source contributed, and the scopes the answer was read from. */
type Contribution = {
  /** The session it carries, or nothing when it is suppressed or nobody can attribute it. */
  readonly sessionId?: string;
  /** True when the records cannot say whose it is, which is neither own nor another session's. */
  readonly unknown: boolean;
  readonly dependencies: readonly EvidenceDependency[];
};

const NO_CONTRIBUTION: Contribution = { unknown: false, dependencies: [] };

/**
 * One source's contribution, once its state chain has answered for it.
 *
 * The chain is read whatever the verdict, and its version travels with the answer: a source
 * excluded because it is forgotten today is a source whose unforgetting changes the set.
 */
function contribution(
  db: SqliteHandle,
  sourceId: string,
  context: CheckedReadContext,
  consulted: readonly EvidenceDependency[] = [],
): Contribution {
  const dependencies = [...consulted, sourceStateDependency(db, sourceId)];
  const eligibility = eligibilityAt(db, sourceId, context);
  if (eligibility.status === 'suppressed') {
    return { unknown: false, dependencies };
  }
  // A vantage the state chain cannot answer for and a source with no record are the same answer
  // here: something carries this node and nobody can say which session it belongs to.
  const record = readSourceRecord(db, sourceId);
  if (eligibility.status === 'unproved' || record === undefined) {
    return { unknown: true, dependencies };
  }
  return { sessionId: record.sessionId, unknown: false, dependencies };
}

/**
 * The session a node carries because it is a source, or one of a source's recorded parts.
 *
 * A Turn is a mapped part rather than a record keyed by its own id, so the identity goes through
 * the one locator that knows both shapes. A node neither shape resolves is a node with no direct
 * ownership, which is an ordinary claim rather than a mapping nobody can account for.
 */
function directContribution(
  db: SqliteHandle,
  nodeId: string,
  context: CheckedReadContext,
): Contribution {
  const located = locateAddress(db, idAddress(nodeId));
  if (located === undefined) {
    return NO_CONTRIBUTION;
  }
  const mapping = located.kind === 'part' ? [sourcePartsDependency(db, located.sourceId)] : [];
  return contribution(db, located.sourceId, context, mapping);
}

/**
 * One node's ownership, from the rows that carry it and the identity it holds itself.
 */
export function readOwnership(
  db: SqliteHandle,
  nodeId: string,
  rows: readonly CommittedIncidence[],
  context: CheckedReadContext,
  /** The census a caller already read, when it read the same scopes for its own dependency set. */
  options: { readonly censusEstablished?: boolean } = {},
): OwnershipReading {
  const sessions = new Set<string>();
  const unplaced: IntervalAxis[] = [];
  const dependencies: EvidenceDependency[] = [];
  const contributions: Contribution[] = [directContribution(db, nodeId, context)];
  for (const row of rows) {
    if (!OWNERSHIP_ROLES.has(row.role)) {
      continue;
    }
    const decision = evaluateInterval(proofOf(row), context.mode);
    if (decision.status === 'excluded') {
      continue;
    }
    if (decision.status === 'unknown') {
      // The records say this ended and never say when, on the clock the request pinned. Counting
      // it or dropping it would both answer a question the substrate cannot answer.
      unplaced.push(decision.axis);
      contributions.push({ unknown: true, dependencies: [] });
      continue;
    }
    contributions.push(contribution(db, row.sourceId, context));
  }
  let unknownAttribution = false;
  for (const entry of contributions) {
    dependencies.push(...entry.dependencies);
    unknownAttribution = unknownAttribution || entry.unknown;
    if (entry.sessionId !== undefined) {
      sessions.add(entry.sessionId);
    }
  }
  return {
    summary: {
      sessions: [...sessions].sort(),
      unknownAttribution,
      censusEstablished: options.censusEstablished ?? ownershipCensusEstablished(db, nodeId),
    },
    unplaced,
    dependencies,
  };
}

/** The summary alone, for a caller that projects it and holds no dependency set of its own. */
export function ownershipSummaryFor(
  db: SqliteHandle,
  nodeId: string,
  rows: readonly CommittedIncidence[],
  context: CheckedReadContext,
  options: { readonly censusEstablished?: boolean } = {},
): OwnershipSummary {
  return readOwnership(db, nodeId, rows, context, options).summary;
}

/**
 * The bound a nomination may trust a stored summary up to: this substrate's identity and the
 * sequence it has acknowledged.
 *
 * Conservative by construction. The cursor names the last acknowledgment, so a summary written by
 * an operation still in flight sits above it and certifies nothing. An old or missing bound
 * preserves candidates the ordering would have discounted, which costs a ranking under a finite
 * limit and never removes a candidate on a reading nobody has proved.
 */
export type OwnershipNominationHint = {
  readonly substrateId: string;
  readonly acknowledgedSequence: string;
};

export function ownershipNominationHint(db: SqliteHandle): OwnershipNominationHint | undefined {
  try {
    const pairing = readSubstratePairing(db);
    return pairing === undefined
      ? undefined
      : { substrateId: pairing.substrateId, acknowledgedSequence: pairing.lastAckSequence };
  } catch {
    // An unreadable control record is not a bound. Without one no candidate is discounted, which
    // costs the ranking its ordering and never costs an answer a memory.
    return undefined;
  }
}
