import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { NEO4J_DEFAULT_USER, waitForBoltReady } from '../provision.js';

const execFileAsync = promisify(execFile);

/**
 * Kept in lockstep with compose.yaml's neo4j service by hand; nothing generates one from the other.
 * `TEST_NEO4J_IMAGE` runs a file against another pairing, which is how a procedure census of a
 * series the compose file does not pin is taken (`provision.ts`'s `VERIFIED_PAIRINGS`).
 */
const NEO4J_TEST_IMAGE = process.env.TEST_NEO4J_IMAGE ?? 'neo4j:2026.07.1-community';
const NEO4J_TEST_PASSWORD = 'aion-test-harness-password';
const READY_TIMEOUT_MS = 60_000;

/**
 * Every name this process has handed to `docker run` and not yet taken back.
 *
 * A hook that times out mid-boot is not a rejection. The promise is abandoned, the `catch`
 * below never runs, and the name the container was created under never reaches the caller, so
 * teardown is handed `undefined` and removes nothing. One 60-second hook left a container
 * running for two hours that way. This set is the only place the name still exists. It is
 * module state, which vitest's per-file isolation scopes to the file that started them.
 */
const started = new Set<string>();

export type Neo4jTestContainer = {
  readonly containerName: string;
  readonly uri: string;
  readonly password: string;
};

export type Neo4jContainerOptions = {
  /**
   * How long to poll Bolt before giving up. The default suits a warm image on an idle host; a
   * cold boot under load is measured in minutes, and the caller that pays for one says so.
   */
  readonly readyTimeoutMs?: number;
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
export async function startNeo4jContainer(
  options: Neo4jContainerOptions = {},
): Promise<Neo4jTestContainer> {
  const containerName = `aion-test-neo4j-${randomUUID()}`;
  // Recorded before the run rather than after it, so a timeout during `docker run` itself
  // still leaves a reclaimable name.
  started.add(containerName);

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
    await waitForBoltReady(
      { uri, password: NEO4J_TEST_PASSWORD },
      { timeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS },
    );
    return { containerName, uri, password: NEO4J_TEST_PASSWORD };
  } catch (err) {
    await removeNeo4jContainer(containerName);
    throw err;
  }
}

/** Force-removes the container and its anonymous volumes in one step. */
export async function removeNeo4jContainer(containerName: string): Promise<void> {
  started.delete(containerName);
  await runDocker(['rm', '-f', '-v', containerName]);
}

/**
 * Removes whatever this process started and never took back, and answers with what it removed.
 *
 * Teardown calls this unconditionally, including the teardown of a `beforeAll` that timed out
 * before it could name anything. A name Docker has already forgotten is not worth failing a
 * teardown over, so each removal is taken on its own.
 */
export async function removeStartedNeo4jContainers(): Promise<string[]> {
  const orphans = [...started];
  for (const containerName of orphans) {
    try {
      await removeNeo4jContainer(containerName);
    } catch {
      started.delete(containerName);
    }
  }
  return orphans;
}
