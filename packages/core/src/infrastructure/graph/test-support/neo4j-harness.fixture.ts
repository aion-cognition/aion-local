import neo4j, { type Driver } from 'neo4j-driver';

import { NEO4J_DEFAULT_USER } from '../provision.js';
import {
  removeNeo4jContainer,
  startNeo4jContainer,
  type Neo4jTestContainer,
} from './neo4j-container.fixture.js';

/**
 * Published by the integration project's global setup, which starts one container for the
 * whole run. All three are absent when a file runs outside that runner, and the harness
 * falls back to a container of its own so single-file debugging keeps working.
 */
export const SHARED_NEO4J_URI_ENV = 'TEST_SHARED_NEO4J_URI';
export const SHARED_NEO4J_PASSWORD_ENV = 'TEST_SHARED_NEO4J_PASSWORD';
export const SHARED_NEO4J_CONTAINER_ENV = 'TEST_SHARED_NEO4J_CONTAINER';

/** Large enough that a test graph clears in one round trip, small enough to bound the transaction. */
const RESET_BATCH_SIZE = 10_000;

/** A localhost container either answers at once or is gone; waiting the default minute only delays the report. */
const SHARED_CONNECT_TIMEOUT_MS = 10_000;

export type Neo4jHarness = {
  driver: Driver;
  uri: string;
  containerName: string;
  /** For a test that builds its own connection from config rather than reusing `driver`. */
  password: string;
  /** True when the container outlives this file and teardown only closes the driver. */
  shared: boolean;
};

function sharedContainer(): Neo4jTestContainer | undefined {
  const uri = process.env[SHARED_NEO4J_URI_ENV];
  const password = process.env[SHARED_NEO4J_PASSWORD_ENV];
  const containerName = process.env[SHARED_NEO4J_CONTAINER_ENV];
  if (uri === undefined || password === undefined || containerName === undefined) {
    return undefined;
  }
  return { containerName, uri, password };
}

async function schemaObjectNames(driver: Driver, cypher: string): Promise<readonly string[]> {
  const result = await driver.executeQuery(cypher);
  return result.records.map((record) => record.get('name') as string);
}

/**
 * Hands the caller a database indistinguishable from a container that just booted: no nodes,
 * no relationships, and no schema objects beyond the token lookups Neo4j owns. Files declare
 * their own schema and they do not agree on one vector dimension, so a schema left standing
 * from the previous file pins `content_vec_idx` at a width the next file's vectors do not
 * match, and that file's vector reads fail. Deletion runs in batches because the file before
 * this one may have left a large graph behind, and one transaction over all of it holds the
 * whole graph in memory.
 *
 * This is the only Cypher deletion in the workspace, and the repo-wide no-hard-delete scan
 * exempts this file by name. Clearing a test database is not a product write path: no product
 * code can reach this function, and correcting a real fact still supersedes it.
 */
async function resetDatabase(driver: Driver): Promise<void> {
  let deleted: number;
  do {
    const result = await driver.executeQuery(
      `MATCH (n) WITH n LIMIT ${RESET_BATCH_SIZE} DETACH DELETE n`,
    );
    deleted = result.summary.counters.updates().nodesDeleted;
  } while (deleted > 0);

  // Constraints first: dropping a constraint drops the index backing it, so the index pass
  // that follows has only the standalone ones left to look at.
  for (const name of await schemaObjectNames(driver, 'SHOW CONSTRAINTS YIELD name RETURN name')) {
    await driver.executeQuery(`DROP CONSTRAINT \`${name}\` IF EXISTS`);
  }
  const standalone = await schemaObjectNames(
    driver,
    "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name",
  );
  for (const name of standalone) {
    await driver.executeQuery(`DROP INDEX \`${name}\` IF EXISTS`);
  }
}

/**
 * The lease a test file takes on the run's Neo4j: connect, clear whatever the previous file
 * left, and hand back the same shape a file used to get from a container of its own. Only one
 * file may hold the lease at a time, which is what `fileParallelism: false` guarantees.
 *
 * With no shared container published, this falls back to starting one. Detection, not a
 * requirement: `npx vitest run <one file>` outside the integration project still works.
 */
export async function startNeo4jHarness(): Promise<Neo4jHarness> {
  const shared = sharedContainer();
  if (shared === undefined) {
    return startDedicatedNeo4jHarness();
  }

  const driver = neo4j.driver(shared.uri, neo4j.auth.basic(NEO4J_DEFAULT_USER, shared.password), {
    connectionTimeout: SHARED_CONNECT_TIMEOUT_MS,
  });
  try {
    await driver.verifyConnectivity();
    await resetDatabase(driver);
  } catch (err) {
    await driver.close();
    throw new Error(
      `the run's shared Neo4j (${shared.containerName}, ${shared.uri}) did not answer. It starts once per run, so every remaining file fails the same way until the run starts over.`,
      { cause: err },
    );
  }

  return {
    driver,
    uri: shared.uri,
    containerName: shared.containerName,
    password: shared.password,
    shared: true,
  };
}

/**
 * A container this file owns outright, removed when the file ends. The lifecycle test asks for
 * it by name, since it asserts on the removal itself and the lease never removes anything.
 * Everything else reaches it as the fallback, when no shared container is published.
 */
export async function startDedicatedNeo4jHarness(): Promise<Neo4jHarness> {
  const container = await startNeo4jContainer();
  const driver = neo4j.driver(
    container.uri,
    neo4j.auth.basic(NEO4J_DEFAULT_USER, container.password),
  );
  return {
    driver,
    uri: container.uri,
    containerName: container.containerName,
    password: container.password,
    shared: false,
  };
}

/**
 * Closes the driver, then force-removes the container and its anonymous volumes if this file
 * started it. The shared container is left running for the file that comes next.
 *
 * Undefined is a normal argument: `afterAll` still runs when `beforeAll` threw, and a teardown
 * that throws on the missing harness reports a second failure that buries the first one.
 */
export async function stopNeo4jHarness(harness: Neo4jHarness | undefined): Promise<void> {
  if (harness === undefined) {
    return;
  }
  await harness.driver.close();
  if (harness.shared) {
    return;
  }
  await removeNeo4jContainer(harness.containerName);
}
