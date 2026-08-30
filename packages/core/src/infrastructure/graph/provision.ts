import neo4j, { type Driver } from 'neo4j-driver';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { DEFAULTS } from '../config/defaults.js';

/** Compose's in-container service name. Anything else is a bring-your-own Neo4j the CLI must not try to start or stop. */
export const MANAGED_NEO4J_URI = DEFAULTS.neo4j.uri;

/** NEO4J_AUTH in compose.yaml is always `neo4j/<password>`; the build has no multi-user story. */
export const NEO4J_DEFAULT_USER = 'neo4j';

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 1000;
const PASSWORD_BYTE_LENGTH = 24;
const NEO4J_PASSWORD_ENV_KEY = 'AION_NEO4J_PASSWORD';

export class Neo4jNotReadyError extends Error {
  constructor(uri: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`Neo4j at ${uri} did not become ready within ${timeoutMs}ms`, options);
    this.name = 'Neo4jNotReadyError';
  }
}

export class Neo4jGdsUnavailableError extends Error {
  constructor(uri: string, options?: { cause?: unknown }) {
    super(`GDS procedures are unavailable on the Neo4j instance at ${uri}`, options);
    this.name = 'Neo4jGdsUnavailableError';
  }
}

export type Neo4jEndpoint = {
  uri: string;
  password: string;
};

export type ReadinessOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls verifyConnectivity instead of trusting one attempt: a container that accepts
 * TCP before the Bolt handshake is actually ready would otherwise surface as a hard
 * failure rather than the transient state it is.
 */
export async function waitForBoltReady(
  endpoint: Neo4jEndpoint,
  options: ReadinessOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const driver = neo4j.driver(
      endpoint.uri,
      neo4j.auth.basic(NEO4J_DEFAULT_USER, endpoint.password),
    );
    try {
      await driver.verifyConnectivity();
      return;
    } catch (err) {
      lastError = err;
    } finally {
      await driver.close();
    }
    await sleep(pollIntervalMs);
  }

  throw new Neo4jNotReadyError(endpoint.uri, timeoutMs, { cause: lastError });
}

/** The one place the GDS presence check runs; provisioning and `aion doctor` both call it against a live driver. */
export async function verifyGdsAvailable(driver: Driver, uri: string): Promise<string> {
  let version: string | undefined;
  try {
    const result = await driver.executeQuery(
      'CALL gds.version() YIELD gdsVersion RETURN gdsVersion',
    );
    version = result.records[0]?.get('gdsVersion') as string | undefined;
  } catch (err) {
    throw new Neo4jGdsUnavailableError(uri, { cause: err });
  }
  if (!version) {
    throw new Neo4jGdsUnavailableError(uri);
  }
  return version;
}

/**
 * True only for the in-container compose service URI. Anything else is a Neo4j the
 * user already runs themselves, so init validates it instead of managing a service.
 */
export function isManagedNeo4jUri(uri: string): boolean {
  return uri === MANAGED_NEO4J_URI;
}

/**
 * Runs after the compose service is started (managed endpoint) or immediately
 * (external endpoint, per `isManagedNeo4jUri`); the validation is identical either
 * way, only the decision to start a container first differs.
 */
export async function validateNeo4jEndpoint(
  endpoint: Neo4jEndpoint,
  options: ReadinessOptions = {},
): Promise<{ gdsVersion: string }> {
  await waitForBoltReady(endpoint, options);
  const driver = neo4j.driver(
    endpoint.uri,
    neo4j.auth.basic(NEO4J_DEFAULT_USER, endpoint.password),
  );
  try {
    const gdsVersion = await verifyGdsAvailable(driver, endpoint.uri);
    return { gdsVersion };
  } finally {
    await driver.close();
  }
}

export function generateStrongPassword(): string {
  return randomBytes(PASSWORD_BYTE_LENGTH).toString('base64url');
}

function readEnvValue(envPath: string, key: string): string | undefined {
  if (!existsSync(envPath)) {
    return undefined;
  }
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

function upsertEnvVar(envPath: string, key: string, value: string): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
  const index = lines.findIndex((entry) => entry.startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (index === -1) {
    lines.push(entry);
  } else {
    lines[index] = entry;
  }
  writeFileSync(envPath, lines.join('\n'));
}

/**
 * Seeds a missing `.env` from `.env.example` so a fresh install's file carries the full
 * documented catalog. Every init-time writer calls this before touching the file: the
 * first upsert into a missing `.env` would otherwise create a bare file and the seed
 * would never happen.
 */
export function seedEnvFromTemplate(envPath: string, templatePath?: string): void {
  if (!existsSync(envPath) && templatePath && existsSync(templatePath)) {
    copyFileSync(templatePath, envPath);
  }
}

/**
 * Init-time only. A password already present in `.env` is left untouched: re-running
 * init must not rotate credentials out from under a Neo4j container that already
 * trusts the old one.
 */
export function ensureNeo4jPassword(envPath: string, templatePath?: string): string {
  seedEnvFromTemplate(envPath, templatePath);
  const existing = readEnvValue(envPath, NEO4J_PASSWORD_ENV_KEY);
  if (existing) {
    return existing;
  }
  const password = generateStrongPassword();
  upsertEnvVar(envPath, NEO4J_PASSWORD_ENV_KEY, password);
  return password;
}
