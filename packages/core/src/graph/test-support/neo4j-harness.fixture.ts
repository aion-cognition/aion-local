import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import neo4j, { type Driver } from 'neo4j-driver';
import { NEO4J_DEFAULT_USER, waitForBoltReady } from '../provision.js';

const execFileAsync = promisify(execFile);

/** Kept in lockstep with compose.yaml's neo4j service by hand; nothing generates one from the other. */
const NEO4J_TEST_IMAGE = 'neo4j:2026.07.1-community';
const NEO4J_TEST_PASSWORD = 'aion-test-harness-password';
const READY_TIMEOUT_MS = 60_000;

export type Neo4jHarness = {
  driver: Driver;
  uri: string;
  containerName: string;
};

async function runDocker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args as string[]);
  return stdout.trim();
}

async function resolveMappedPort(containerName: string, containerPort: number): Promise<number> {
  const output = await runDocker(['port', containerName, `${containerPort}/tcp`]);
  const port = output.split(':')[1];
  if (!port) {
    throw new Error(`could not resolve the mapped host port for ${containerName}:${containerPort}`);
  }
  return Number(port);
}

/**
 * A bare `docker run`, not compose: one throwaway container per call, uniquely named
 * and bound to an OS-assigned host port so parallel test runs never collide. No named
 * volume is attached, so `docker rm -f -v` in `stopNeo4jHarness` leaves nothing behind
 * for a caller to separately clean up, verified by the accompanying integration test.
 */
export async function startNeo4jHarness(): Promise<Neo4jHarness> {
  const containerName = `aion-test-neo4j-${randomUUID()}`;

  await runDocker([
    'run',
    '-d',
    '--name',
    containerName,
    '-e',
    `NEO4J_AUTH=${NEO4J_DEFAULT_USER}/${NEO4J_TEST_PASSWORD}`,
    '-e',
    'NEO4J_PLUGINS=["graph-data-science"]',
    '-e',
    'NEO4J_server_memory_heap_initial__size=512m',
    '-e',
    'NEO4J_server_memory_heap_max__size=1G',
    '-e',
    'NEO4J_server_memory_pagecache_size=512m',
    '-p',
    '127.0.0.1::7687',
    NEO4J_TEST_IMAGE,
  ]);

  const boltPort = await resolveMappedPort(containerName, 7687);
  const uri = `bolt://127.0.0.1:${boltPort}`;
  const endpoint = { uri, password: NEO4J_TEST_PASSWORD };

  try {
    await waitForBoltReady(endpoint, { timeoutMs: READY_TIMEOUT_MS });
  } catch (err) {
    await runDocker(['rm', '-f', '-v', containerName]);
    throw err;
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(NEO4J_DEFAULT_USER, NEO4J_TEST_PASSWORD));
  return { driver, uri, containerName };
}

/** Closes the driver, then force-removes the container and its anonymous volumes in one step. */
export async function stopNeo4jHarness(harness: Neo4jHarness): Promise<void> {
  await harness.driver.close();
  await runDocker(['rm', '-f', '-v', harness.containerName]);
}
