import { INCOMING_STATEMENT_SCOPES } from './chunk-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';

/**
 * The census an acceptance can prove about the source it mints, written where it mints it.
 *
 * A reader asks two negative questions about every member it places: does anything correct this,
 * and does anything confirm it. Both are answerable only where a census says the population behind
 * the counter is whole, and until one does the reader binds nothing and holds the publication. The
 * acceptance is the one writer in a position to settle them for a fresh source: it chooses the
 * identity, and nothing can have stated anything about an id nobody had. So the population is
 * empty, this write is what says so, and no later pass is better placed to.
 *
 * It stays true afterwards. A correction or a confirmation is accepted through the reference
 * writer, which advances these same counters in the transaction that records the statement, so the
 * count keeps covering the population while the token moves under every reader holding the old one.
 *
 * The cohort seal is the other producer and it is not this one: it counts endpoints a migration
 * walked, from the link rows that walk wrote. A source nothing has ever named carries no such row,
 * which is the gap this closes — for the fresh source, at the writer that made it.
 *
 * Only a newly minted source. An acceptance resolving to a source the records already hold has
 * enumerated nothing about it: whatever was stated about that source in between is a question its
 * own acceptance answered, and counting here would publish a number for a population this write
 * never looked at.
 */

/** Parks a number on each scope inside the acceptance's durable prepare. */
export function prepareSourceCensus(
  db: SqliteHandle,
  sourceId: string,
  operationId: string,
  acceptedAt: string,
): void {
  for (const relationClass of INCOMING_STATEMENT_SCOPES) {
    prepareScopeAdvance(db, {
      endpointId: sourceId,
      relationClass,
      operationId,
      updatedAt: new Date(acceptedAt),
    });
  }
}

/**
 * Publishes those numbers and establishes the census, inside the acknowledgment.
 *
 * Establishment waits for the acknowledgment because a prepared advance is durable and invisible: a
 * plan the coordinator goes on to refuse would otherwise leave a counted population behind that no
 * acceptance ever committed. What the count rests on is stored with it, so a later reader can see
 * the claim was about a minted identity rather than about a walk somebody says happened.
 *
 * Returns how many scopes this acknowledgment established.
 */
export function acknowledgeSourceCensus(
  db: SqliteHandle,
  sourceId: string,
  operationId: string,
  knownFrom: string,
): number {
  let established = 0;
  for (const relationClass of INCOMING_STATEMENT_SCOPES) {
    const published = acknowledgeScopeAdvance(db, {
      endpointId: sourceId,
      relationClass,
      operationId,
      updatedAt: new Date(knownFrom),
      censusStatus: 'established',
      coverageJson: JSON.stringify({
        basis: 'source_acceptance',
        sourceId,
        scope: relationClass,
        acceptedAt: knownFrom,
      }),
    });
    if (published !== undefined) {
      established += 1;
    }
  }
  return established;
}

/** Releases the parked numbers. Nothing was published, so no reader's token moved. */
export function discardSourceCensus(
  db: SqliteHandle,
  sourceId: string,
  operationId: string,
  acceptedAt: string,
): void {
  for (const relationClass of INCOMING_STATEMENT_SCOPES) {
    rejectScopeAdvance(db, {
      endpointId: sourceId,
      relationClass,
      operationId,
      updatedAt: new Date(acceptedAt),
    });
  }
}
