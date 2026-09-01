#!/usr/bin/env node
/**
 * Keeps one warm Neo4j container across integration-test iterations, so a single-file run
 * pays a connect instead of a twenty-second boot. With the three TEST_SHARED_NEO4J_* variables
 * exported, the vitest integration project boots no pool and runs serial, and every file
 * leases this container directly (wiping it on entry, as always).
 *
 *   eval "$(node scripts/test-neo4j.mjs start)"   # boot once, export the address
 *   npx vitest run --project integration <file>   # iterate; starts in seconds now
 *   eval "$(node scripts/test-neo4j.mjs env)"     # re-export in a new shell, container kept
 *   node scripts/test-neo4j.mjs stop              # remove the container when done
 *
 * Image, auth, and memory flags are kept in lockstep with
 * packages/core/src/infrastructure/graph/test-support/neo4j-container.fixture.ts by hand,
 * like that file keeps itself in lockstep with compose.yaml; nothing generates one from the
 * other.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import neo4j from 'neo4j-driver';

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = 'aion-test-neo4j-warm';
const IMAGE = 'neo4j:2026.07.1-community';
const USER = 'neo4j';
const PASSWORD = 'aion-test-harness-password';
const READY_TIMEOUT_MS = 60_000;
const READY_RETRY_MS = 1_000;

async function docker(args) {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

async function mappedBoltPort() {
  const output = await docker(['port', CONTAINER_NAME, '7687/tcp']);
  const port = output.split(':')[1];
  if (!port) {
    throw new Error(`could not resolve the mapped bolt port for ${CONTAINER_NAME}`);
  }
  return Number(port);
}

async function isRunning() {
  try {
    const state = await docker(['inspect', CONTAINER_NAME, '--format', '{{.State.Running}}']);
    return state === 'true';
  } catch {
    return false;
  }
}

async function waitForBolt(uri) {
  const attempts = Math.ceil(READY_TIMEOUT_MS / READY_RETRY_MS);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const driver = neo4j.driver(uri, neo4j.auth.basic(USER, PASSWORD));
    try {
      await driver.verifyConnectivity();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
    } finally {
      await driver.close();
    }
  }
  throw new Error(`${CONTAINER_NAME} did not answer at ${uri} within ${READY_TIMEOUT_MS}ms`, {
    cause: lastError,
  });
}

function printExports(uri) {
  console.log(`export TEST_SHARED_NEO4J_URI=${uri}`);
  console.log(`export TEST_SHARED_NEO4J_PASSWORD=${PASSWORD}`);
  console.log(`export TEST_SHARED_NEO4J_CONTAINER=${CONTAINER_NAME}`);
}

async function start() {
  if (await isRunning()) {
    const uri = `bolt://127.0.0.1:${await mappedBoltPort()}`;
    console.error(`${CONTAINER_NAME} already running at ${uri}`);
    printExports(uri);
    return;
  }
  await docker(['rm', '-f', '-v', CONTAINER_NAME]).catch(() => {});
  await docker([
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-e',
    `NEO4J_AUTH=${USER}/${PASSWORD}`,
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
    IMAGE,
  ]);
  const uri = `bolt://127.0.0.1:${await mappedBoltPort()}`;
  console.error(`waiting for ${CONTAINER_NAME} at ${uri}...`);
  await waitForBolt(uri);
  console.error('ready');
  printExports(uri);
}

async function env() {
  if (!(await isRunning())) {
    throw new Error(
      `${CONTAINER_NAME} is not running; start it with: node scripts/test-neo4j.mjs start`,
    );
  }
  printExports(`bolt://127.0.0.1:${await mappedBoltPort()}`);
}

async function stop() {
  await docker(['rm', '-f', '-v', CONTAINER_NAME]);
  console.error(
    `${CONTAINER_NAME} removed (unset the TEST_SHARED_NEO4J_* variables in shells that exported them)`,
  );
}

const command = process.argv[2];
const commands = { start, env, stop };
const run = commands[command];
if (run === undefined) {
  console.error('usage: node scripts/test-neo4j.mjs <start|env|stop>');
  process.exit(2);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
