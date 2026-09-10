import {
  endpointCensusScopes,
  isNodeEndpoint,
  pageUncountedEndpoints,
  type ScopeProof,
} from './legacy-records.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { readEndpointContributions } from '../../infrastructure/graph/legacy-evidence-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  countMigrationProgress,
  readMigrationCohort,
  readMigrationProgress,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import { endpointPopulation } from '../domain/legacy-materialization.js';

/**
 * What one page of the census seal may establish, and what proves each scope of it.
 *
 * A cohort finishing is not a census. The seal's claim is per scope: "this is the whole population
 * behind this counter", and what supports it is every relationship the graph currently shows in
 * that scope having an acknowledged record, written by a source this cohort proved. So each
 * candidate scope is checked against the graph's own view of what contributes to it, and a scope
 * holding one relationship nobody materialized — or one whose source nobody can name — is left
 * uncounted. The endpoint stays nominated for whoever covers it later, and the seal moves on.
 *
 * A verified member is not the unit of proof. A source proved months ago is still verified today,
 * and the mention it acquired since is not in anybody's records: status answers a question about
 * the walk, and the census asks one about the relationships.
 *
 * Nor is a logical link. Two original relationships can normalize onto one, and the records hold a
 * single version per link, so the match one of them finds says nothing about the other. A scope
 * carrying such a pair is the same unrepresentable set the materializer pins, and it is left
 * uncounted rather than sealed on an older tuple.
 */

/**
 * Which of these links the committed records actually hold.
 *
 * A census is a statement about the RECORDS, and what makes it true of the graph is every current
 * relationship having a record. Membership does not establish that: a source proved months ago is
 * still verified today, and the mention it acquired since was never materialized by anybody. So
 * the proof is per relationship, and it joins through the operation's own acknowledgment — a
 * prepared version is durable and invisible, and counting it would certify a write nobody
 * committed.
 */
export function materializedLinks(
  db: SqliteHandle,
  linkIds: readonly string[],
): ReadonlySet<string> {
  if (linkIds.length === 0) {
    return new Set();
  }
  const placeholders = linkIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT DISTINCT v.link_id AS link_id FROM evidence_link_versions v
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
       WHERE v.link_id IN (${placeholders}) AND v.known_from IS NOT NULL`,
    )
    .all(...linkIds) as { link_id: string }[];
  return new Set(rows.map((row) => row.link_id));
}

export type CensusCoverage = {
  readonly cohortId: string;
  readonly cohortDigest: string;
  readonly graphCensusDigest: string;
  readonly intakeWatermark: number;
  readonly archiveRowidLow: number;
  readonly archiveRowidHigh: number;
  readonly members: number;
  readonly verified: number;
};

/**
 * What a seal over this cohort rests on: the frozen record itself, and how much of it was proved.
 *
 * Nothing for a cohort nobody froze: a count with no enumeration behind it has no bounds to
 * record and no membership to have accounted for, and the seal defers on the absence.
 */
export function censusCoverage(db: SqliteHandle, cohortId: string): CensusCoverage | undefined {
  const cohort = readMigrationCohort(db, cohortId);
  if (cohort === undefined) {
    return undefined;
  }
  const counts = countMigrationProgress(db, cohortId);
  return {
    cohortId: cohort.cohortId,
    cohortDigest: cohort.cohortDigest,
    graphCensusDigest: cohort.graphCensusDigest,
    intakeWatermark: cohort.intakeWatermark,
    archiveRowidLow: cohort.archiveRowidLow,
    archiveRowidHigh: cohort.archiveRowidHigh,
    members: counts.accounted + counts.verified + counts.pinned,
    verified: counts.verified,
  };
}

export type CensusEndpoint = {
  readonly endpointId: string;
  readonly scopes: readonly string[];
  readonly node: boolean;
  readonly proof: readonly ScopeProof[];
};

export type CensusPage = {
  readonly endpoints: readonly CensusEndpoint[];
  /**
   * The last endpoint this page LOOKED AT, which is what the next page starts past. It is not the
   * last one sealed: an endpoint nobody can prove would otherwise be handed back forever and the
   * seal would never reach the ones behind it.
   */
  readonly cursor: string;
  readonly coverage?: CensusCoverage;
};

export type CensusPageRequest = {
  readonly cohortId: string;
  readonly endpointLimit: number;
  readonly after: string;
  /** The bound on one endpoint's contribution walk. A walk that fills it proves nothing. */
  readonly relationLimit: number;
};

type CensusContext = {
  readonly graph: GraphTransaction;
  readonly db: SqliteHandle;
};

/** Whether this cohort walked the source and proved it, which is the only membership that counts. */
function verifiedMember(db: SqliteHandle, cohortId: string, sourceId: string): boolean {
  return readMigrationProgress(db, cohortId, sourceId)?.status === 'verified';
}

/**
 * The scopes this cohort can prove for one endpoint, each with the sources behind it.
 *
 * The endpoint's population comes from the graph, classified by the same table the walk used. A
 * node-side scope is proved when every contributing source is a verified member of this cohort —
 * including the ones outside it, which is exactly the case a subset cohort would otherwise certify
 * away. A source-side scope counts the endpoint's OWN outgoing relationships, so what proves it is
 * this cohort having verified the endpoint itself.
 *
 * A walk that filled its bound proves nothing at all: an enumeration cut short and an empty one
 * look identical once the rows are gone.
 */
async function proveEndpoint(
  context: CensusContext,
  request: CensusPageRequest,
  endpointId: string,
): Promise<CensusEndpoint> {
  const node = isNodeEndpoint(context.db, endpointId);
  const walk = await readEndpointContributions(context.graph, endpointId, request.relationLimit);
  if (!walk.complete) {
    return { endpointId, scopes: [], node, proof: [] };
  }
  const population = endpointPopulation({ endpointId, contributions: walk.contributions });
  const recorded = materializedLinks(
    context.db,
    [...population.scopes.values()].flatMap((held) => [...held.links]),
  );
  const scopes: string[] = [];
  const proof: ScopeProof[] = [];
  for (const scope of endpointCensusScopes(context.db, endpointId)) {
    const held = population.scopes.get(scope);
    // No contribution at all, over a walk that finished: a proved zero.
    const contributors = held?.sources ?? [];
    if (held !== undefined && !held.attributed) {
      continue;
    }
    // One recorded link is proof for one original relationship, and only its own. Where two of
    // them normalize onto the same link the records can hold at most one, so the link a match
    // finds may be the older tuple standing in for an edge nobody materialized.
    if (held !== undefined && !held.represented) {
      continue;
    }
    if (held !== undefined && !held.links.every((linkId) => recorded.has(linkId))) {
      continue;
    }
    if (!contributors.every((sourceId) => verifiedMember(context.db, request.cohortId, sourceId))) {
      continue;
    }
    scopes.push(scope);
    proof.push({ scope, contributors });
  }
  return { endpointId, scopes, node, proof };
}

/**
 * One bounded page of the seal.
 *
 * Nothing at all for a cohort nobody froze: a count with no enumeration behind it has no bounds to
 * record and no membership to have accounted for, and the check defers on the absence.
 */
export async function planCensusPage(
  context: CensusContext,
  request: CensusPageRequest,
): Promise<CensusPage> {
  const coverage = censusCoverage(context.db, request.cohortId);
  if (coverage === undefined) {
    return { endpoints: [], cursor: request.after };
  }
  const nominated = pageUncountedEndpoints(
    context.db,
    request.cohortId,
    request.after,
    request.endpointLimit,
  );
  const endpoints: CensusEndpoint[] = [];
  for (const endpointId of nominated) {
    const proved = await proveEndpoint(context, request, endpointId);
    if (proved.scopes.length > 0) {
      endpoints.push(proved);
    }
  }
  return {
    endpoints,
    cursor: nominated[nominated.length - 1] ?? request.after,
    coverage,
  };
}
