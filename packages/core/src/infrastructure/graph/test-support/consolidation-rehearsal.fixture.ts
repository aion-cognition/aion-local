import {
  SHARED_NEO4J_URI_ENV,
  startDedicatedNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './neo4j-harness.fixture.js';
import { publishedPool } from './neo4j-lease.fixture.js';
import {
  checkRehearsalTarget,
  IN_MEMORY_SQLITE,
  normalizeEndpoint,
  sharesDataRoot,
  type IsolationVerdict,
  type SubstrateTarget,
} from '../../../introspection/domain/campaign-isolation.js';
import { SQLITE_PATH_ENV_VAR, DEFAULT_SQLITE_PATH } from '../../sqlite/database.js';

/**
 * The substrate a rehearsal is allowed to run against.
 *
 * A rehearsal loads fixtures, injects faults, and tears the store down, so nothing here may
 * touch a database before it is known to be disposable. Clearing a leased container is itself a
 * destructive act, so the admission runs in two steps: every endpoint this environment could
 * hand back is checked while nothing is connected, and only then is a container created.
 *
 * The container is created by this run and removed by it. That is what proves ownership. A name
 * read out of the environment names a container somebody else may be using, and a pooled or
 * warm container is cleared on acquisition, which is a write to a store nobody here owns.
 */

export const PRODUCTION_URI_ENV = 'AION_NEO4J_URI';

export class RehearsalTargetRefused extends Error {
  readonly verdict: IsolationVerdict;

  constructor(verdict: IsolationVerdict) {
    super(
      verdict.status === 'rejected'
        ? `rehearsal target refused: ${verdict.reason}, ${verdict.detail}`
        : 'rehearsal target refused',
    );
    this.name = 'RehearsalTargetRefused';
    this.verdict = verdict;
  }
}

/** What the service runs on, as the environment describes it. Defaults match the shipped knobs. */
export function productionTarget(env: NodeJS.ProcessEnv = process.env): SubstrateTarget {
  return {
    graphUri: env[PRODUCTION_URI_ENV] ?? 'bolt://neo4j:7687',
    sqlitePath: env[SQLITE_PATH_ENV_VAR] ?? DEFAULT_SQLITE_PATH,
  };
}

/**
 * Every graph endpoint this environment could hand a test file: the run's container pool and
 * the developer's warm container. A dedicated container's endpoint is not knowable in advance,
 * and it does not need to be, since it does not exist until this run makes it.
 */
export function declaredEndpoints(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const shared = env[SHARED_NEO4J_URI_ENV];
  const pool = publishedPool()?.pool.map((container) => container.uri) ?? [];
  return [...pool, ...(shared === undefined ? [] : [shared])];
}

/**
 * Refuses before anything connects when the environment names the running server anywhere.
 * A machine whose test wiring points at production is a machine where the next acquisition
 * could clear it, and an uncertain identity refuses rather than reasons about which path a
 * helper would have taken.
 */
export function preflightVerdict(
  production: SubstrateTarget,
  sqlitePath: string,
  env: NodeJS.ProcessEnv = process.env,
): IsolationVerdict | undefined {
  for (const uri of declaredEndpoints(env)) {
    if (normalizeEndpoint(uri) === normalizeEndpoint(production.graphUri)) {
      return {
        status: 'rejected',
        reason: 'production_graph_endpoint',
        detail: 'this environment offers the running endpoint as a test target',
      };
    }
  }
  if (sharesDataRoot(sqlitePath, production.sqlitePath)) {
    return {
      status: 'rejected',
      reason: 'production_data_root',
      detail: 'the rehearsal file would sit in the running substrate data directory',
    };
  }
  return undefined;
}

export type RehearsalSubstrate = {
  readonly harness: Neo4jHarness;
  readonly sqlitePath: string;
  readonly verdict: IsolationVerdict;
};

export type RehearsalRequest = {
  /** Where the rehearsal will put its own SQLite file. `:memory:` is disposable by construction. */
  readonly sqlitePath?: string;
  readonly production?: SubstrateTarget;
};

/**
 * Starts a container of this run's own and admits it only if it is not the running one. The
 * verdict comes back with the substrate so a caller can report which rule admitted it.
 */
export async function startRehearsalSubstrate(
  request: RehearsalRequest = {},
): Promise<RehearsalSubstrate> {
  const sqlitePath = request.sqlitePath ?? IN_MEMORY_SQLITE;
  const production = request.production ?? productionTarget();

  const refusedEarly = preflightVerdict(production, sqlitePath);
  if (refusedEarly !== undefined) {
    throw new RehearsalTargetRefused(refusedEarly);
  }

  const harness = await startDedicatedNeo4jHarness();
  const verdict = checkRehearsalTarget({
    target: { graphUri: harness.uri, sqlitePath },
    production,
    declaration: {
      kind: 'harness',
      containerName: harness.containerName,
      createdByThisRun: !harness.shared,
    },
  });

  if (verdict.status === 'rejected') {
    await stopNeo4jHarness(harness);
    throw new RehearsalTargetRefused(verdict);
  }
  return { harness, sqlitePath, verdict };
}

export async function stopRehearsalSubstrate(
  substrate: RehearsalSubstrate | undefined,
): Promise<void> {
  await stopNeo4jHarness(substrate?.harness);
}
