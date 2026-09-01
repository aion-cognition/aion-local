import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  removeNeo4jContainer,
  startNeo4jContainer,
  type Neo4jTestContainer,
} from './neo4j-container.fixture.js';
import { SHARED_NEO4J_URI_ENV } from './neo4j-harness.fixture.js';
import { integrationPoolSize, NEO4J_LEASE_DIR_ENV, NEO4J_POOL_ENV } from './neo4j-lease.fixture.js';

/**
 * A pool of Neo4j containers for the whole integration run, one per worker, in place of the
 * container every file used to boot and throw away. Booting is the expensive part at roughly
 * twenty seconds a file, and the pool boots in parallel, so a run pays it once. Files claim a
 * free container through the lease in neo4j-lease.fixture.ts, which is what lets them run
 * concurrently without ever sharing a database.
 *
 * A developer who exported TEST_SHARED_NEO4J_URI (scripts/test-neo4j.mjs keeps such a warm
 * container) gets no pool at all: vitest.config.ts sees the same variable and drops to serial,
 * every file leases the warm container directly, and the run starts with zero boots.
 *
 * Containers are handed over blank rather than migrated. Files declare their own schema at
 * their own vector dimension and they do not agree on one, so a schema created here is dropped
 * by the first file to take the lease anyway. Each file's own `runGraphMigrations` call is what
 * builds the schema it needs, exactly as it did against a container of its own.
 *
 * This runs in the vitest main process, before any worker starts, so the pool it writes to
 * the environment is inherited by every file. Teardown runs after the last file.
 */
let pool: Neo4jTestContainer[] | undefined;
let leaseDir: string | undefined;

export async function setup(): Promise<void> {
  if (process.env[SHARED_NEO4J_URI_ENV] !== undefined) {
    return;
  }
  const size = integrationPoolSize();
  const containers = await Promise.all(Array.from({ length: size }, () => startNeo4jContainer()));
  const dir = await mkdtemp(join(tmpdir(), 'aion-neo4j-lease-'));
  process.env[NEO4J_POOL_ENV] = JSON.stringify(containers);
  process.env[NEO4J_LEASE_DIR_ENV] = dir;
  pool = containers;
  leaseDir = dir;
}

export async function teardown(): Promise<void> {
  // Cleared before the await, not after: a `setup()` that races this teardown then hands
  // out fresh containers instead of losing its assignment to this function's own cleanup.
  const currentPool = pool;
  const currentLeaseDir = leaseDir;
  pool = undefined;
  leaseDir = undefined;
  if (currentPool !== undefined) {
    await Promise.all(currentPool.map((c) => removeNeo4jContainer(c.containerName)));
  }
  if (currentLeaseDir !== undefined) {
    await rm(currentLeaseDir, { recursive: true, force: true });
  }
}
