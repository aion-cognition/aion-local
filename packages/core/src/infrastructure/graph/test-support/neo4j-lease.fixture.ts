import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Published by the integration project's global setup when it boots a container pool: the
 * pool as JSON and the directory holding one lease file per container. Absent when a file
 * runs outside that runner, or when the developer published a warm container instead.
 */
export const NEO4J_POOL_ENV = 'TEST_NEO4J_POOL';
export const NEO4J_LEASE_DIR_ENV = 'TEST_NEO4J_LEASE_DIR';

/** Read by the global setup and by vitest.config.ts, which sizes its worker count to match. */
export const NEO4J_POOL_SIZE_ENV = 'TEST_NEO4J_POOL_SIZE';

/**
 * Three is what the Docker VM holds beside the live stack: each pooled Neo4j reserves about
 * 1.5GB and the VM has ~5GB free with aion-neo4j-1 running. More workers than containers is
 * safe (a claim waits for a release) but buys nothing, so the two numbers come from here.
 */
const DEFAULT_POOL_SIZE = 3;

const CLAIM_RETRY_DELAY_MS = 250;
const CLAIM_MAX_ATTEMPTS = 480;

export type PooledNeo4j = {
  readonly containerName: string;
  readonly uri: string;
  readonly password: string;
};

export type Neo4jLease = {
  readonly container: PooledNeo4j;
  readonly leasePath: string;
};

export function integrationPoolSize(): number {
  const raw = process.env[NEO4J_POOL_SIZE_ENV];
  if (raw === undefined) {
    return DEFAULT_POOL_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${NEO4J_POOL_SIZE_ENV} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export function publishedPool(): { pool: readonly PooledNeo4j[]; leaseDir: string } | undefined {
  const poolJson = process.env[NEO4J_POOL_ENV];
  const leaseDir = process.env[NEO4J_LEASE_DIR_ENV];
  if (poolJson === undefined || leaseDir === undefined) {
    return undefined;
  }
  return { pool: JSON.parse(poolJson) as PooledNeo4j[], leaseDir };
}

/**
 * Takes exclusive ownership of one pool container for the calling test file. The claim is an
 * O_EXCL file create, so two files racing for the same container cannot both win, whatever
 * process or worker the runner put them in. With workers capped at the pool size a container
 * is normally free on the first pass; the retry loop only absorbs a scheduler that briefly
 * runs more files than containers, and a pool wedged longer than two minutes is reported,
 * not waited out.
 */
export async function claimPooledNeo4j(
  pool: readonly PooledNeo4j[],
  leaseDir: string,
): Promise<Neo4jLease> {
  for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt += 1) {
    for (let index = 0; index < pool.length; index += 1) {
      const leasePath = join(leaseDir, `container-${index}.lease`);
      try {
        const handle = await open(leasePath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return { container: pool[index]!, leasePath };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
    }
    await delay(CLAIM_RETRY_DELAY_MS);
  }
  throw new Error(
    `no container in the ${pool.length}-strong Neo4j pool came free in ${(CLAIM_MAX_ATTEMPTS * CLAIM_RETRY_DELAY_MS) / 1000}s. ` +
      `A file that crashed without releasing its lease leaves one behind in ${leaseDir}; the run needs to start over.`,
  );
}

/** Releasing a lease another claim already replaced is a bug worth hearing about, so only a missing file is tolerated. */
export async function releaseNeo4jLease(lease: Neo4jLease): Promise<void> {
  try {
    await unlink(lease.leasePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
