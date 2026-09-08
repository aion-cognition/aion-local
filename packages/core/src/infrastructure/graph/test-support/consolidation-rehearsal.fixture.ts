import { startNeo4jHarness, stopNeo4jHarness, type Neo4jHarness } from './neo4j-harness.fixture.js';
import {
  checkRehearsalTarget,
  IN_MEMORY_SQLITE,
  type IsolationVerdict,
  type SubstrateTarget,
} from '../../../introspection/domain/campaign-isolation.js';
import { SQLITE_PATH_ENV_VAR, DEFAULT_SQLITE_PATH } from '../../sqlite/database.js';

/**
 * The substrate a rehearsal is allowed to run against.
 *
 * A rehearsal loads fixtures, injects faults, and tears the store down, so the check happens
 * before the caller gets a driver rather than after the first write. A refused target takes the
 * container down with it: leaving it running would invite a second call to use it anyway.
 *
 * The harness that started the container is what makes the target disposable, and the
 * declaration says so outright. An environment variable pointing at a database is not evidence
 * of anything, so nothing here reads one as permission.
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
 * Starts a throwaway graph and admits it only if it is not the running one. The verdict comes
 * back with the substrate so a caller can report which rule admitted it.
 */
export async function startRehearsalSubstrate(
  request: RehearsalRequest = {},
): Promise<RehearsalSubstrate> {
  const sqlitePath = request.sqlitePath ?? IN_MEMORY_SQLITE;
  const harness = await startNeo4jHarness();
  const verdict = checkRehearsalTarget({
    target: { graphUri: harness.uri, sqlitePath },
    production: request.production ?? productionTarget(),
    declaration: { kind: 'harness', containerName: harness.containerName },
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
