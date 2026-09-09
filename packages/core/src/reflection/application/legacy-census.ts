import {
  censusCoverage,
  endpointCensusScopes,
  isNodeEndpoint,
  pageUncountedEndpoints,
  type CensusCoverage,
  type ScopeProof,
} from './legacy-records.js';
import {
  durableRoleScope,
  nodeScopeDirection,
  DURABLE_ROLES,
} from '../../evidence/domain/scopes.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { readEndpointContributions } from '../../infrastructure/graph/legacy-evidence-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { endpointPopulation } from '../domain/legacy-materialization.js';

/**
 * What one page of the census seal may establish, and what proves each scope of it.
 *
 * A cohort finishing is not a census. The seal's claim is per scope: "this is the whole population
 * behind this counter", and the only thing that supports it is having walked that population. So
 * every candidate scope on every nominated endpoint is checked against the graph's own view of who
 * contributes to it, and a scope with one contributor this cohort did not verify is left uncounted
 * — the endpoint stays nominated for whoever covers it later, and the seal moves on.
 */

/** The scope names filed at the SOURCE's end of a role, which its own walk proves. */
const SOURCE_SIDE_SCOPES = new Set<string>(
  DURABLE_ROLES.map((role) =>
    durableRoleScope(role, nodeScopeDirection(role) === 'in' ? 'out' : 'in'),
  ),
);

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
  const scopes: string[] = [];
  const proof: ScopeProof[] = [];
  for (const scope of endpointCensusScopes(context.db, endpointId)) {
    const contributors = SOURCE_SIDE_SCOPES.has(scope)
      ? [endpointId]
      : (population.scopes.get(scope) ?? []);
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
