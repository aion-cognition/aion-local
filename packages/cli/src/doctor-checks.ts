import {
  acceptsHookCapture,
  describePairing,
  Neo4jPairingError,
  queueLagSnapshot,
  readCoverageState,
  readNeo4jPairing,
  readOllamaVersion,
  resolveProviderRouting,
  scanHorizonIntegrity,
  type Config,
  type CoverageStateReport,
  type HorizonIntegrity,
  type SqliteHandle,
} from '@aion/core';
import { runningInContainer } from '@aion/mcp';
import type { Driver } from 'neo4j-driver';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CheckResult } from './doctor.js';
import {
  describeInstallProfile,
  readStorePairing,
  storeDropCommands,
  type StorePairing,
} from './install-profile.js';

/**
 * The checks that read a substrate and answer with a verdict, kept apart from the file that
 * orders them and prints the report. `doctor.ts` composes; each function here owns one
 * invariant and the sentence it reports it in.
 */

const execFileAsync = promisify(execFile);

/** Which substrate this install runs on. Informational, and the first thing a report needs. */
export function installProfileCheck(config: Config): CheckResult {
  return { ok: true, detail: describeInstallProfile(config) };
}

/**
 * The browser console beside the Bolt address, because they are the same server and nobody
 * remembers the second port.
 *
 * On the docker profile the Bolt URI names the compose service, which resolves on compose's own
 * network and nowhere a browser can reach; the console is published to the host's loopback, so
 * that is the address to print. Any other host is one an operator gave us, and the console is on
 * the same host as the Bolt port.
 */
export function neo4jBrowserUrl(boltUri: string): string {
  const host = /^[a-z+]+:\/\/([^:/]+)/i.exec(boltUri)?.[1];
  const reachable = host === undefined || host === 'neo4j' ? '127.0.0.1' : host;
  return `http://${reachable}:7474`;
}

/**
 * Server version, plugin version and the verdict on the pairing. The docker profile pins both
 * through the image, so this only ever warns where somebody assembled the server themselves;
 * missing GDS fails on either profile, and the failure prints the install steps, because a
 * substrate without gds procedures loses community detection and node similarity outright.
 */
export async function graphPairingCheck(driver: Driver, uri: string): Promise<CheckResult> {
  try {
    const pairing = await readNeo4jPairing(driver, uri);
    const detail = describePairing(pairing);
    if (!pairing.matched) {
      return { ok: false, detail };
    }
    return pairing.verified ? { ok: true, detail } : { ok: true, warn: true, detail };
  } catch (err) {
    if (!(err instanceof Neo4jPairingError)) {
      throw err;
    }
    return { ok: false, detail: [err.message, ...err.remedy].join('\n        ') };
  }
}

/** The verdict in one sentence, with the drops named for the profile that owns the stores. */
export function storePairingDetail(pairing: StorePairing, config: Config): CheckResult {
  if (pairing === 'paired') {
    return { ok: true, detail: 'graph backbone and schema history are the same substrate' };
  }
  if (pairing === 'fresh') {
    return { ok: true, warn: true, detail: 'no substrate in either store yet; run `aion init`' };
  }
  const kept = pairing === 'graph-without-database' ? 'the graph' : 'the database';
  return {
    ok: false,
    detail: [
      `only ${kept} holds a substrate: this is a half reset, and the service refuses at its next`,
      'start rather than serving a graph its receipts do not describe. Drop both, then init:',
      ...storeDropCommands(config.install.profile, config.operational.dataDir).map(
        (line) => `  ${line}`,
      ),
    ].join('\n        '),
  };
}

/** The same verdict over a live substrate, which is how `aion doctor` reaches it. */
export async function storePairingCheck(
  driver: Driver,
  db: SqliteHandle,
  config: Config,
): Promise<CheckResult> {
  return storePairingDetail(await readStorePairing(driver, db), config);
}

/**
 * The two daemon-level settings the local generation route was measured with. Neither is an
 * Ollama config setting: they are environment variables of the `ollama serve` process, so the
 * HTTP API cannot report them and a restart or an upgrade of the daemon silently drops them —
 * which is the whole reason this check exists rather than a note in a runbook.
 */
export const OLLAMA_TUNING_VARS = ['OLLAMA_FLASH_ATTENTION', 'OLLAMA_KV_CACHE_TYPE'] as const;

/** What an operator runs where this process cannot see the daemon's process table. */
export const OLLAMA_ENV_PROBE = 'ps eww $(pgrep -f "ollama serve")';

function daemonSetting(daemonEnv: string, name: string): string | undefined {
  const token = daemonEnv
    .split(/\s+/)
    .find((entry) => entry.startsWith(`${name}=`) && entry.length > name.length + 1);
  return token?.slice(name.length + 1);
}

export type OllamaRuntime = {
  readonly version: string;
  /** The daemon's process environment as one blob, or undefined where it cannot be read. */
  readonly daemonEnv: string | undefined;
};

export function ollamaRuntimeCheck(runtime: OllamaRuntime): CheckResult {
  const version = `ollama ${runtime.version}`;
  if (runtime.daemonEnv === undefined) {
    return {
      ok: true,
      detail: `${version}; ${OLLAMA_TUNING_VARS.join(' and ')} are process environment and are not visible from here: ${OLLAMA_ENV_PROBE}`,
    };
  }
  const readings = OLLAMA_TUNING_VARS.map((name) => ({
    name,
    value: daemonSetting(runtime.daemonEnv ?? '', name),
  }));
  const missing = readings.filter((reading) => reading.value === undefined);
  const set = readings
    .filter((reading) => reading.value !== undefined)
    .map((reading) => `${reading.name}=${reading.value ?? ''}`);
  if (missing.length === 0) {
    return { ok: true, detail: `${version}, ${set.join(' ')}` };
  }
  return {
    ok: true,
    warn: true,
    detail:
      `${version}; ${missing.map((reading) => reading.name).join(', ')} unset on the running ` +
      `daemon (an upgrade or a service restart drops them)${set.length === 0 ? '' : `, ${set.join(' ')}`}`,
  };
}

/**
 * Reads the daemon's environment from the process table, which is the only place it is written
 * down. A CLI run inside the container is asking about a process on another machine as far as
 * the kernel is concerned, so it does not ask.
 */
export async function readOllamaDaemonEnv(): Promise<string | undefined> {
  if (runningInContainer()) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', OLLAMA_ENV_PROBE]);
    return stdout.trim() === '' ? undefined : stdout;
  } catch {
    // No pgrep, no daemon of its own on this host, or a process table this user cannot read.
    return undefined;
  }
}

/** The same verdict over a live daemon, which is how `aion doctor` reaches it. */
export async function ollamaRuntimeProbe(baseUrl: string): Promise<CheckResult> {
  const [version, daemonEnv] = await Promise.all([
    readOllamaVersion(baseUrl),
    readOllamaDaemonEnv(),
  ]);
  return ollamaRuntimeCheck({ version, daemonEnv });
}

/**
 * Pure SQLite, no Neo4j: `aion doctor` printed "8 checks passed" with 4,000+ jobs pending,
 * and again with one permanently wedged job. Warn, never fail: a backlog is a thing that is
 * behind, not a thing that is broken.
 */
export function queueLagCheck(
  db: SqliteHandle,
  config: Config,
  now: Date = new Date(),
): CheckResult {
  const snapshot = queueLagSnapshot(db, config.operational.workerMaxAttempts, now);
  const { interactive, bulk } = snapshot.depthByLane;
  const depth = interactive + bulk;
  const oldest = snapshot.oldestUnclaimedMs;
  const detail = [
    `depth ${String(depth)} (interactive ${String(interactive)}, bulk ${String(bulk)})`,
    `${String(snapshot.indexDepth)} source-index rows pending`,
    `oldest unclaimed ${oldest === undefined ? 'none' : `${String(Math.round(oldest / 1000))}s`}`,
    `${String(snapshot.exhausted)} exhausted`,
    `${String(snapshot.reinforcementDropped)} reinforcement rows dropped`,
    snapshot.p95EnrichmentLagMs === undefined
      ? 'no enrichment lag samples yet'
      : `p95 enrichment lag ${String(Math.round(snapshot.p95EnrichmentLagMs / 1000))}s`,
    snapshot.cueDegradedRate === undefined
      ? 'no recalls measured yet'
      : `${(snapshot.cueDegradedRate * 100).toFixed(1)}% of recent recalls degraded on cues`,
  ].join(', ');

  const stale = oldest !== undefined && oldest > config.operational.lagOldestUnclaimedWarnMs;
  // Either backlog past the threshold earns the warning. Scoping `depth` to the reflection rows
  // would otherwise have taken the index rows out of the gauge entirely, and an index backlog
  // nothing counts is how every source behind it stays eviction-pinned unnoticed.
  const deep =
    depth > config.operational.lagQueueDepthWarnThreshold ||
    snapshot.indexDepth > config.operational.lagQueueDepthWarnThreshold;
  if (stale || deep) {
    return { ok: true, warn: true, detail };
  }
  return { ok: true, detail };
}

/**
 * A reading's horizon is annotated at read and is never a close, so a node carrying a horizon
 * and a `valid_until` at once is read rather than assumed broken: a reading a later observation
 * corrected carries exactly that pair, and the close records when the correcting experience
 * happened.
 *
 * A close stamped at the horizon itself is the failure. That node left every currency predicate
 * in the tree with nothing having corrected it, and the `coalesce` on the next real close keeps
 * the wrong world time under a live lineage edge. Fails rather than warns: it is a wrong answer
 * the substrate gives now, and `aion unsupersede` is the verb that lifts it.
 */
export function horizonIntegrityCheck(report: HorizonIntegrity): CheckResult {
  if (report.closedAtHorizon === 0) {
    return {
      ok: true,
      detail:
        `${String(report.withHorizon)} readings carry a horizon, ` +
        `${String(report.closed)} of them superseded`,
    };
  }
  return {
    ok: false,
    detail:
      `${String(report.closedAtHorizon)} of ${String(report.withHorizon)} carry a close ` +
      `stamped at their own horizon (${report.sampleIds.join(', ')}); ` +
      '`aion unsupersede <id>` reopens each one',
  };
}

/** The same verdict over a live substrate, which is how `aion doctor` reaches it. */
export async function readingHorizonCheck(driver: Driver): Promise<CheckResult> {
  return horizonIntegrityCheck(await scanHorizonIntegrity(driver));
}

/**
 * What the substrate says it covers.
 *
 * A preparing contract is the state a substrate is in between initialization and the activation
 * the service publishes on its next start. It serves, so this warns rather than fails, and it
 * names what the state costs: no temporal read carries a horizon while it holds. An unreadable
 * record fails, because every covered read refuses against one, present-tense reads included.
 */
export function coverageStateCheck(report: CoverageStateReport): CheckResult {
  if (report.coverageState === 'failed') {
    return { ok: false, detail: 'no servable coverage record; every covered read refuses' };
  }
  if (report.coverageState === 'preparing') {
    return {
      ok: true,
      warn: true,
      detail:
        'contract preparing: temporal reads answer partial with coverage_contract_not_active, ' +
        'and no read carries a history horizon. The service activates it at start',
    };
  }
  return {
    ok: true,
    detail: `contract active, history since ${report.historySince ?? 'unrecorded'}`,
  };
}

/** The same verdict over a live substrate, which is how `aion doctor` reaches it. */
export function coverageCheck(db: SqliteHandle): CheckResult {
  return coverageStateCheck(readCoverageState(db));
}

/**
 * Which route the hooks feed, reported and not judged.
 *
 * This used to fail a substrate that had hooks installed on the local route, and the hook client
 * used to remove itself there. Both came from a build whose local model could not keep up with a
 * capture every turn; the substrate is local-first, a key is optional spend, and hooks are
 * route-agnostic. What is left is worth saying: a capture fires every turn, so an operator
 * deserves to know which model is digesting it and what that costs.
 *
 * Whether hooks are installed is a host fact: the CLI runs in a container that cannot see
 * `~/.claude`, so `bin/aion` computes it and passes it through, and a run reached any other way
 * reports that it cannot see rather than guessing.
 */
export function hooksRouteCheck(config: Config, env: NodeJS.ProcessEnv): CheckResult {
  const installed = (env.AION_HOOKS_INSTALLED ?? '').trim();
  if (installed === '') {
    return { ok: true, detail: 'hook settings not visible here' };
  }
  if (installed !== 'true') {
    return { ok: true, detail: 'no hooks installed' };
  }
  const routing = resolveProviderRouting(config);
  if (acceptsHookCapture(routing)) {
    return {
      ok: true,
      detail: `hooks installed; capture digests on ${routing.roles.reflect.model}`,
    };
  }
  return {
    ok: true,
    detail:
      `hooks installed; capture digests locally on ${routing.roles.reflect.model}. ` +
      'A key plus AION_REFLECT_PROVIDER route it to Anthropic instead; nothing here needs one.',
  };
}
