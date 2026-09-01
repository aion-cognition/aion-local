import neo4j, { type Driver } from 'neo4j-driver';

import { NEO4J_DEFAULT_USER } from '../provision.js';
import {
  removeNeo4jContainer,
  startNeo4jContainer,
  type Neo4jTestContainer,
} from './neo4j-container.fixture.js';
import {
  claimPooledNeo4j,
  publishedPool,
  releaseNeo4jLease,
  type Neo4jLease,
} from './neo4j-lease.fixture.js';

/**
 * A warm container a developer keeps running across iterations (scripts/test-neo4j.mjs
 * maintains one). When these are set the global setup boots no pool, vitest.config.ts drops
 * to serial so two files cannot wipe the one database out from under each other, and every
 * file leases this container directly. All three are absent in a normal run.
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
  /** Held while this file owns a pool container; teardown releases it for the next file. */
  lease?: Neo4jLease;
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
 * The database a test file runs against: claim a container the run's pool has free, clear
 * whatever the previous holder left, and hand back the same shape a file used to get from a
 * container of its own. The claim is exclusive, so files running in parallel each hold a
 * database of their own and never see each other's writes.
 *
 * With no pool published this leases the developer's warm container instead (the config runs
 * serial in that mode, so exclusivity holds there too), and with neither it falls back to
 * starting a container outright. Detection, not a requirement: `npx vitest run <one file>`
 * outside the integration project still works.
 */
export async function startNeo4jHarness(): Promise<Neo4jHarness> {
  const published = publishedPool();
  if (published !== undefined) {
    const lease = await claimPooledNeo4j(published.pool, published.leaseDir);
    try {
      return {
        ...(await leaseContainer(lease.container, 'this file holds the only lease on it')),
        lease,
      };
    } catch (err) {
      await releaseNeo4jLease(lease);
      throw err;
    }
  }

  const shared = sharedContainer();
  if (shared === undefined) {
    return startDedicatedNeo4jHarness();
  }
  return leaseContainer(shared, 'it outlives every run until scripts/test-neo4j.mjs stops it');
}

async function leaseContainer(
  container: Neo4jTestContainer,
  lifetime: string,
): Promise<Neo4jHarness> {
  const driver = neo4j.driver(
    container.uri,
    neo4j.auth.basic(NEO4J_DEFAULT_USER, container.password),
    { connectionTimeout: SHARED_CONNECT_TIMEOUT_MS },
  );
  try {
    await driver.verifyConnectivity();
    await resetDatabase(driver);
  } catch (err) {
    await driver.close();
    throw new Error(
      `the leased Neo4j (${container.containerName}, ${container.uri}) did not answer, and ${lifetime}.`,
      { cause: err },
    );
  }

  return {
    driver,
    uri: container.uri,
    containerName: container.containerName,
    password: container.password,
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
 * Closes the driver, releases the pool lease if this file held one, and force-removes the
 * container and its anonymous volumes if this file started it. A pooled or warm container is
 * left running for the file that comes next.
 *
 * Undefined is a normal argument: `afterAll` still runs when `beforeAll` threw, and a teardown
 * that throws on the missing harness reports a second failure that buries the first one.
 */
export async function stopNeo4jHarness(harness: Neo4jHarness | undefined): Promise<void> {
  if (harness === undefined) {
    return;
  }
  await harness.driver.close();
  if (harness.lease !== undefined) {
    await releaseNeo4jLease(harness.lease);
  }
  if (harness.shared) {
    return;
  }
  await removeNeo4jContainer(harness.containerName);
}
