import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { NEO4J_DEFAULT_USER, waitForBoltReady } from '../provision.js';

const execFileAsync = promisify(execFile);

/** Kept in lockstep with compose.yaml's neo4j service by hand; nothing generates one from the other. */
const NEO4J_TEST_IMAGE = 'neo4j:2026.07.1-community';
const NEO4J_TEST_PASSWORD = 'aion-test-harness-password';
const READY_TIMEOUT_MS = 60_000;

export type Neo4jTestContainer = {
  readonly containerName: string;
  readonly uri: string;
  readonly password: string;
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
 * A bare `docker run`, not compose: a uniquely named container bound to an OS-assigned host
 * port, so two test runs on one machine never collide. No named volume is attached, so
 * `removeNeo4jContainer` leaves nothing behind for a caller to separately clean up, verified
 * by the accompanying integration test.
 *
 * Booting one of these takes roughly twenty seconds, which is why a run starts one and the
 * files share it rather than each starting its own.
 */
export async function startNeo4jContainer(): Promise<Neo4jTestContainer> {
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

  // Everything after `docker run` is inside the guard: a port lookup can fail as readily as
  // readiness can, and either way the container is already up and must not be left behind.
  try {
    const boltPort = await resolveMappedPort(containerName, 7687);
    const uri = `bolt://127.0.0.1:${boltPort}`;
    await waitForBoltReady({ uri, password: NEO4J_TEST_PASSWORD }, { timeoutMs: READY_TIMEOUT_MS });
    return { containerName, uri, password: NEO4J_TEST_PASSWORD };
  } catch (err) {
    await runDocker(['rm', '-f', '-v', containerName]);
    throw err;
  }
}

/** Force-removes the container and its anonymous volumes in one step. */
export async function removeNeo4jContainer(containerName: string): Promise<void> {
  await runDocker(['rm', '-f', '-v', containerName]);
}
