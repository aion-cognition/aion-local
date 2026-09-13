import { INCOMING_STATEMENT_SCOPES } from './chunk-evidence.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import type { EvidenceScope } from '../../infrastructure/publication/preconditions.js';
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
 *
 * The node side of the same act is the same claim, and it is below. A census says the population
 * behind a counter is whole, which is a statement about the records that has to hold of the graph
 * too: what makes it true of the graph is every relationship the graph currently shows having a
 * record. For a minted episode or turn id nothing shows. The id was drawn here, so no record and
 * no edge can name it yet, and the classification table in `legacy-materialization.ts` is what
 * keeps it that way: every rule that lands a relationship in one of the three ownership scopes
 * refuses an Episode or a Turn at the far end, so a mention, an extraction or a participation can
 * never reach one of these endpoints at all. The emptiness is a property of the shape rather than
 * of what the fresh path happens to record, which is why this is not archaeology about missing
 * machinery.
 *
 * It stays true the same way the source side does: every existing writer of these counters
 * advances both endpoints in the transaction that records the incidence, and passes no census
 * status while doing it, so the number moves without the count being re-claimed.
 *
 * The cohort seal cannot collide with either census while one cohort exists: a freshly minted uuid
 * sits in no frozen membership and carries no link row, so the seal never nominates it. A SECOND
 * cohort id is a different matter and it is a standing footgun rather than a case this writer
 * handles. `aion consolidate` takes any cohort id, and a new one freezes at the CURRENT intake
 * watermark, which sweeps every source accepted since the first freeze into the walk. Once that
 * happens the seal considers all seven support roles on the turns it materialized, and a turn whose
 * only classified edge is its own ordering answers `unsupported` instead of `unknown`. Retiring the
 * seal is what closes it.
 */

/**
 * What this operation's acknowledgment counts, for the affected-scope list its intent records.
 *
 * Declared by the plan that mints the identity and by no other: a reused occurrence counts
 * nothing here, so it has nothing to declare.
 */
export function sourceCensusScopes(sourceId: string): readonly EvidenceScope[] {
  return INCOMING_STATEMENT_SCOPES.map((scope) => ({
    kind: 'relation_scope' as const,
    id: sourceId,
    scope,
  }));
}

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

/**
 * The three counters the ownership reader consults, taken from the reader rather than re-listed.
 *
 * Deliberately not the seven support roles. `certifyNodeSupport` needs a census on every one of
 * them before it answers `unsupported`, so counting three leaves four uncounted and the repair
 * lifecycle keeps answering `unknown` over a fresh turn, which is what it should do: nothing on
 * this path records the incidence those four would be counting. Widening this list would mature
 * every fresh turn toward suppression on populations nothing writes, so it stays at what a reader
 * actually asks for and the incidence writer lands first.
 *
 * Three of the tokens `certifyNodeSupport` stamps still move here, from absent to real, which
 * voids any qualification recorded against them. What those qualifications recorded was `unknown`,
 * and `unknown` authorizes nothing, so the blast radius is a re-read rather than a reversal.
 */
const MINTED_NODE_SCOPES: readonly string[] = OWNERSHIP_SCOPES.map(({ role, direction }) =>
  durableRoleScope(role, direction),
);

/** Every id this acceptance drew: the episode, and one per turn. */
function mintedEndpoints(sourceId: string, turnIds: readonly string[]): readonly string[] {
  return [sourceId, ...turnIds];
}

/**
 * What the acknowledgment publishes on the node side, for the affected-scope list its intent
 * records. Declared by the plan that mints the ids and by no other.
 */
export function mintedNodeCensusScopes(
  sourceId: string,
  turnIds: readonly string[],
): readonly EvidenceScope[] {
  return mintedEndpoints(sourceId, turnIds).flatMap((endpointId) =>
    MINTED_NODE_SCOPES.map((scope) => ({
      kind: 'relation_scope' as const,
      id: endpointId,
      scope,
    })),
  );
}

/**
 * Parks a number on each of those counters, inside the acceptance's durable prepare.
 *
 * Nothing else can be holding one. `prepareScopeAdvance` throws on a pending slot owned by another
 * operation rather than passing, and inside the coordinator's write that throw refuses the whole
 * intake, which would cost the capture. It cannot happen here: every id in the set was drawn from
 * `randomUUID` in this operation's own prepare, under the guard, so no other operation has ever
 * seen one to prepare against.
 *
 * The whole set lands in the one write transaction the coordinator already holds, so the cost is
 * that transaction growing with turn count rather than any extra lock. Batching at a call site
 * changes nothing: this is already inside one, and what grows is the window another writer can
 * meet a busy database in.
 */
export function prepareMintedNodeCensus(
  db: SqliteHandle,
  sourceId: string,
  turnIds: readonly string[],
  operationId: string,
  acceptedAt: string,
): void {
  for (const endpointId of mintedEndpoints(sourceId, turnIds)) {
    for (const relationClass of MINTED_NODE_SCOPES) {
      prepareScopeAdvance(db, {
        endpointId,
        relationClass,
        operationId,
        updatedAt: new Date(acceptedAt),
      });
    }
  }
}

/**
 * Publishes those numbers and establishes the census, inside the acknowledgment, for the same
 * reason the source side waits: a prepared advance a refusal drops must leave no counted
 * population behind.
 *
 * Returns how many scopes this acknowledgment established.
 */
export function acknowledgeMintedNodeCensus(
  db: SqliteHandle,
  sourceId: string,
  turnIds: readonly string[],
  operationId: string,
  knownFrom: string,
): number {
  let established = 0;
  for (const endpointId of mintedEndpoints(sourceId, turnIds)) {
    for (const relationClass of MINTED_NODE_SCOPES) {
      const published = acknowledgeScopeAdvance(db, {
        endpointId,
        relationClass,
        operationId,
        updatedAt: new Date(knownFrom),
        censusStatus: 'established',
        coverageJson: JSON.stringify({
          basis: 'minted_identity',
          endpointId,
          scope: relationClass,
          sourceId,
          acceptedAt: knownFrom,
        }),
      });
      if (published !== undefined) {
        established += 1;
      }
    }
  }
  return established;
}

/** Releases the parked numbers. Nothing was published, so no reader's token moved. */
export function discardMintedNodeCensus(
  db: SqliteHandle,
  sourceId: string,
  turnIds: readonly string[],
  operationId: string,
  acceptedAt: string,
): void {
  for (const endpointId of mintedEndpoints(sourceId, turnIds)) {
    for (const relationClass of MINTED_NODE_SCOPES) {
      rejectScopeAdvance(db, {
        endpointId,
        relationClass,
        operationId,
        updatedAt: new Date(acceptedAt),
      });
    }
  }
}
