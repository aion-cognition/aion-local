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

/**
 * The server and plugin this build is verified against. `compose.yaml` pins the image to the
 * same pairing and records what was measured on it; an install that assembles Neo4j by hand has
 * no image to pin, so it is checked against these two constants instead. A patch release inside
 * the series is accepted, which is why the comparison is on the series rather than the version.
 */
export const PINNED_NEO4J_SERIES = '2026.07';
export const PINNED_GDS_SERIES = '2026.07';
export const VERIFIED_GDS_VERSION = '2026.07.0';

export type Neo4jPairing = {
  readonly serverVersion: string;
  readonly gdsVersion: string;
  /**
   * Server and plugin on the same CalVer series, which is the requirement rather than a
   * preference: GDS is compiled against the kernel it ships beside, and a mismatched pair is
   * where a procedure signature moves under the substrate. False is a refusal.
   */
  readonly matched: boolean;
  /**
   * That pair is also the one this build was measured on. False is a warning and not a refusal:
   * a matched pair on a later series is a working substrate that nobody has run the procedure
   * census against, and the operator who has one deserves to be told which it is.
   */
  readonly verified: boolean;
};

/**
 * A Neo4j this build cannot use, with what to do about it. The remedy is carried rather than
 * only formatted into the message: the CLI prints it as its own block, and a message that ran
 * four numbered steps into one line is a message nobody follows.
 */
export class Neo4jPairingError extends Error {
  readonly remedy: readonly string[];

  constructor(message: string, remedy: readonly string[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'Neo4jPairingError';
    this.remedy = remedy;
  }
}

/** `2026.07.1` and `2026.07` both read as `2026.07`; anything unparseable stays as it came. */
function versionSeries(version: string): string {
  const parts = version.split('.');
  return parts.length < 2 ? version : `${parts[0] ?? ''}.${parts[1] ?? ''}`;
}

/**
 * What an operator has to do to put GDS on a server they run themselves. The plugins directory
 * is read off the server when it will answer, because the one on this machine beats a path from
 * a manual: a Homebrew install, a tarball and a package install each keep it somewhere else.
 */
export function gdsRemedyLines(pluginsDir: string | undefined): readonly string[] {
  return [
    `1. Download the graph-data-science jar for the ${PINNED_GDS_SERIES} series (the open-gds jar,`,
    '   github.com/neo4j/graph-data-science/releases; neo4j.com/deployment-center is the other source).',
    `2. Put it in this server's plugins directory: ${pluginsDir ?? '$NEO4J_HOME/plugins'}`,
    '3. Add both lines to neo4j.conf. The first lets the procedures run unsandboxed, the second',
    '   admits them to the procedure allowlist, and GDS needs each of them:',
    '     dbms.security.procedures.unrestricted=gds.*',
    '     dbms.security.procedures.allowlist=gds.*',
    '4. Restart Neo4j and run this command again.',
  ];
}

/** Best effort: the setting read needs privileges an install may not grant, and is never fatal. */
async function readPluginsDirectory(driver: Driver): Promise<string | undefined> {
  try {
    const result = await driver.executeQuery(
      "SHOW SETTINGS 'server.directories.plugins' YIELD value RETURN value",
    );
    const value = result.records[0]?.get('value') as string | undefined;
    return value === undefined || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * The version the handshake already carries, so no procedure has to be callable for it to be
 * read: the driver reports `Neo4j/2026.07.1` as its agent, which is the same string
 * `GraphConnection.health()` prints. A server that answers in another shape reads as unknown and
 * fails the series comparison, which is the safe direction.
 */
async function readServerVersion(driver: Driver): Promise<string> {
  const info = await driver.getServerInfo();
  const agent = info.agent ?? '';
  const slash = agent.lastIndexOf('/');
  return slash === -1 ? 'unknown' : agent.slice(slash + 1);
}

/**
 * Server and GDS version together, with the verdict on whether the two are the pairing this
 * build was measured on. Missing GDS throws with the install steps; a mismatched pairing is
 * reported rather than thrown, because what to do about it differs by install profile: a managed
 * image pins it, and only a hand-assembled server can act on it.
 */
export async function readNeo4jPairing(driver: Driver, uri: string): Promise<Neo4jPairing> {
  const serverVersion = await readServerVersion(driver);
  let gdsVersion: string;
  try {
    gdsVersion = await verifyGdsAvailable(driver, uri);
  } catch (err) {
    throw new Neo4jPairingError(
      `graph-data-science is not installed on the Neo4j at ${uri} (server ${serverVersion}). ` +
        'The substrate needs it: community detection and node similarity both run as gds procedures.',
      gdsRemedyLines(await readPluginsDirectory(driver)),
      { cause: err },
    );
  }
  const series = versionSeries(serverVersion);
  return {
    serverVersion,
    gdsVersion,
    matched: series === versionSeries(gdsVersion),
    verified: series === PINNED_NEO4J_SERIES && versionSeries(gdsVersion) === PINNED_GDS_SERIES,
  };
}

const VERIFIED_PAIRING = `${PINNED_NEO4J_SERIES} with graph-data-science ${VERIFIED_GDS_VERSION}`;

/** One line for a report: what is running, and how far it is from the pairing that was measured. */
export function describePairing(pairing: Neo4jPairing): string {
  const verdict = verdictFor(pairing);
  return `neo4j ${pairing.serverVersion}, graph-data-science ${pairing.gdsVersion}: ${verdict}`;
}

function verdictFor(pairing: Neo4jPairing): string {
  if (pairing.verified) {
    return `the verified pairing (${VERIFIED_PAIRING})`;
  }
  if (pairing.matched) {
    return `matched, and past the verified pairing (${VERIFIED_PAIRING}): nobody has run the procedure census on this one`;
  }
  return 'MISMATCHED: the plugin is compiled against another kernel series';
}

/**
 * The same read as a refusal, for the install that has to act on it. A mismatched pair is where a
 * procedure signature moves under the substrate, so a native install stops rather than migrating
 * a graph it may not be able to read back. A matched pair past the verified series is returned,
 * and the caller reports it.
 */
export async function verifyNeo4jPairing(driver: Driver, uri: string): Promise<Neo4jPairing> {
  const pairing = await readNeo4jPairing(driver, uri);
  if (!pairing.matched) {
    throw new Neo4jPairingError(`${uri}: ${describePairing(pairing)}`, [
      `Install the graph-data-science release for the ${versionSeries(pairing.serverVersion)} series,`,
      "or a server on the plugin's series. The two move together by design.",
      ...gdsRemedyLines(await readPluginsDirectory(driver)),
    ]);
  }
  return pairing;
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
