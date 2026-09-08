import { readRelationScope } from './dependencies.js';
import { eligibilityAt } from './sources.js';
import {
  committedIncidenceForNodes,
  committedIncidenceForNodesAt,
  type CommittedIncidence,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { OWNERSHIP_SCOPES, type OwnershipSummary } from '../domain/ownership.js';
import { durableRoleScope } from '../domain/scopes.js';

/**
 * Who a memory belongs to, derived from the incidence records rather than from graph hops.
 *
 * Currency and suppression are honored here. A closed incidence no longer holds, and a forgotten
 * source may not be quoted, so neither one carries a session into the verdict. Uncertainty is its
 * own answer: it keeps the memory eligible without asserting that anybody outside the session
 * wrote it.
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
 * The incidence a serving read is entitled to, at the vantage the request named. A knowledge-time
 * question reads the link version chain, because the projection rows say what is carried now.
 */
export function ownershipIncidence(
  db: SqliteHandle,
  nodeIds: readonly string[],
  context: CheckedReadContext,
): readonly CommittedIncidence[] {
  const { knownAt } = context.mode;
  return knownAt === undefined
    ? committedIncidenceForNodes(db, nodeIds)
    : committedIncidenceForNodesAt(db, nodeIds, knownAt);
}

/**
 * One node's ownership, from the rows that carry it.
 *
 * A node that is its own source carries the session that captured it, which is the direct
 * ownership a Turn, an Episode or a session Narrative holds without any incidence at all.
 */
export function ownershipSummaryFor(
  db: SqliteHandle,
  nodeId: string,
  rows: readonly CommittedIncidence[],
  context: CheckedReadContext,
  /** The census a caller already read, when it read the same scopes for its own dependency set. */
  options: { readonly censusEstablished?: boolean } = {},
): OwnershipSummary {
  const sessions = new Set<string>();
  let unknownAttribution = false;
  const own = readSourceRecord(db, nodeId);
  if (own !== undefined) {
    sessions.add(own.sessionId);
  }
  for (const row of rows) {
    if (!OWNERSHIP_ROLES.has(row.role) || row.currency === 'closed') {
      continue;
    }
    const eligibility = eligibilityAt(db, row.sourceId, context);
    if (eligibility.status === 'suppressed') {
      continue;
    }
    // A vantage the state chain cannot answer for and a source with no record are the same
    // answer here: something carries this node and nobody can say which session it belongs to.
    const record = readSourceRecord(db, row.sourceId);
    if (eligibility.status === 'unproved' || record === undefined) {
      unknownAttribution = true;
      continue;
    }
    sessions.add(record.sessionId);
  }
  return {
    sessions: [...sessions].sort(),
    unknownAttribution,
    censusEstablished: options.censusEstablished ?? ownershipCensusEstablished(db, nodeId),
  };
}

/**
 * The bound a nomination may trust a stored summary up to: this substrate's identity and the
 * sequence it has acknowledged.
 *
 * Conservative by construction. The cursor names the last acknowledgment, so a summary written by
 * an operation still in flight sits above it and certifies nothing. An old bound only preserves
 * extra candidates, which is why a stale reading is safe and a missing one withholds no answer.
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
