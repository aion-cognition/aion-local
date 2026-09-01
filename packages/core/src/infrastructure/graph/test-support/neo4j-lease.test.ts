import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimPooledNeo4j,
  integrationPoolSize,
  NEO4J_POOL_SIZE_ENV,
  publishedPool,
  releaseNeo4jLease,
  type PooledNeo4j,
} from './neo4j-lease.fixture.js';

const POOL: readonly PooledNeo4j[] = [
  { containerName: 'aion-test-neo4j-a', uri: 'bolt://127.0.0.1:1', password: 'a' },
  { containerName: 'aion-test-neo4j-b', uri: 'bolt://127.0.0.1:2', password: 'b' },
];

describe('claiming a pooled container', () => {
  let leaseDir: string;

  beforeEach(async () => {
    leaseDir = await mkdtemp(join(tmpdir(), 'aion-lease-test-'));
  });

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true });
  });

  it('hands two racing claims two different containers', async () => {
    const [first, second] = await Promise.all([
      claimPooledNeo4j(POOL, leaseDir),
      claimPooledNeo4j(POOL, leaseDir),
    ]);
    expect(first.container.containerName).not.toBe(second.container.containerName);
  });

  it('makes a claim on a full pool wait for a release rather than fail or double-book', async () => {
    const first = await claimPooledNeo4j(POOL, leaseDir);
    const second = await claimPooledNeo4j(POOL, leaseDir);

    let settled = false;
    const third = claimPooledNeo4j(POOL, leaseDir).then((lease) => {
      settled = true;
      return lease;
    });

    await delay(100);
    expect(settled).toBe(false);

    await releaseNeo4jLease(first);
    const lease = await third;
    expect(lease.container.containerName).toBe(first.container.containerName);
    expect(lease.container.containerName).not.toBe(second.container.containerName);
  });

  it('frees a container for the next claim once released', async () => {
    const first = await claimPooledNeo4j(POOL, leaseDir);
    await releaseNeo4jLease(first);
    const again = await claimPooledNeo4j(POOL, leaseDir);
    expect(again.container.containerName).toBe(first.container.containerName);
  });

  it('tolerates releasing the same lease twice', async () => {
    const lease = await claimPooledNeo4j(POOL, leaseDir);
    await releaseNeo4jLease(lease);
    await expect(releaseNeo4jLease(lease)).resolves.toBeUndefined();
  });
});

describe('sizing the pool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to three containers', () => {
    vi.stubEnv(NEO4J_POOL_SIZE_ENV, undefined);
    expect(integrationPoolSize()).toBe(3);
  });

  it('honors the override', () => {
    vi.stubEnv(NEO4J_POOL_SIZE_ENV, '5');
    expect(integrationPoolSize()).toBe(5);
  });

  it('refuses a size that is not a positive integer', () => {
    vi.stubEnv(NEO4J_POOL_SIZE_ENV, '0');
    expect(() => integrationPoolSize()).toThrow(NEO4J_POOL_SIZE_ENV);
    vi.stubEnv(NEO4J_POOL_SIZE_ENV, 'many');
    expect(() => integrationPoolSize()).toThrow(NEO4J_POOL_SIZE_ENV);
  });
});

describe('reading the published pool', () => {
  it('reports no pool when the runner published none', () => {
    expect(publishedPool()).toBeUndefined();
  });
});
