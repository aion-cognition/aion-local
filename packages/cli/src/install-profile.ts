import {
  hostDataDir,
  parseEnvFile,
  appliedGraphSchemaVersion,
  readMemberName,
  type Config,
  type SqliteHandle,
} from '@aion/core';
import type { Driver } from 'neo4j-driver';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliUsageError } from './args.js';

/**
 * Everything that differs between the two substrates an install can run on, in one place. The
 * profile itself is a config knob (`AION_INSTALL_PROFILE`), because `doctor` and `status` have to
 * know which substrate they are looking at without being told again; what lives here is the
 * consequence of it — the addresses a host install needs, and the refusals that only make sense
 * once you know which two stores are in play.
 *
 * Ordinary commands use the recorded profile; only setup chooses it.
 */

export type InstallProfile = Config['install']['profile'];

export const INSTALL_PROFILE_ENV_VAR = 'AION_INSTALL_PROFILE';

/**
 * The directory a native install keeps both of its own stores and its log under.
 *
 * One definition, in core, because two things reach for it and they have to agree: this writes it
 * into `.env`, and `prepareSubstrateRoots` resolves it at every entry point before config loads —
 * including on the command that runs before there is a `.env` at all.
 */
export function nativeDataDir(home: string): string {
  return hostDataDir(home);
}

/**
 * The five addresses that differ, and the profile knob that records which set is in force.
 * Compose resolves `neo4j` and `host.docker.internal` on its own network and mounts `/data`
 * from a volume; a host process has none of those, so each one becomes a loopback address or a
 * path under the data directory. Written into `.env` at init rather than derived from the
 * profile at load time, so every address stays readable from its own declaration.
 */
export function nativeAddresses(home: string): readonly (readonly [string, string])[] {
  const data = nativeDataDir(home);
  return [
    [INSTALL_PROFILE_ENV_VAR, 'native'],
    ['AION_NEO4J_URI', 'bolt://127.0.0.1:7687'],
    ['AION_OLLAMA_URL', 'http://127.0.0.1:11434'],
    ['AION_DATA_DIR', data],
    ['AION_SQLITE_PATH', join(data, 'aion.sqlite')],
    ['AION_LOG_FILE', join(data, 'logs', 'aion.jsonl')],
  ];
}

export type NativeEnvStep = {
  readonly key: string;
  readonly value: string;
  /** `kept` is a value this install chose for itself, which init must not overwrite. */
  readonly action: 'wrote' | 'kept';
};

export type NativeEnvInput = {
  readonly home: string;
  /** The value `.env` holds now, or undefined when the file does not name the key. */
  readonly current: (key: string) => string | undefined;
  /** The value `.env.example` ships, which is what an untouched install still carries. */
  readonly template: (key: string) => string | undefined;
};

/**
 * What init would write, decided before anything is written. A key still holding the template's
 * compose value (or holding nothing) is converted; a key holding anything else is left alone and
 * reported, because that is an address somebody set on purpose — an external Neo4j, a data
 * directory on another disk — and re-running init must not take it back.
 */
export function planNativeEnv(input: NativeEnvInput): readonly NativeEnvStep[] {
  return nativeAddresses(input.home).map(([key, value]) => {
    const current = input.current(key);
    const untouched = current === undefined || current === '' || current === input.template(key);
    return { key, value, action: untouched || current === value ? 'wrote' : 'kept' };
  });
}

/** Update the effective last entry, matching the config reader's handling of duplicates. */
export function upsertEnvValue(path: string, key: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  let index = -1;
  for (const [position, line] of lines.entries()) {
    if (parseEnvFile(line).has(key)) {
      index = position;
    }
  }
  const entry = `${key}=${value}`;
  if (index === -1) {
    lines.push(entry);
  } else {
    lines[index] = entry;
  }
  writeFileSync(path, lines.join('\n'));
}

/**
 * Applies the plan to the file and to this process at once. The process copy is what makes the
 * rest of the run read the addresses it just recorded: nothing on the host loads `.env` on its
 * own, so a config re-read would otherwise still resolve the compose names.
 *
 * `out` is the write target, and the name is also what `no-param-reassign` accepts a property
 * assignment through.
 */
export function applyNativeEnv(
  envPath: string,
  plan: readonly NativeEnvStep[],
  out: NodeJS.ProcessEnv,
): void {
  for (const step of plan) {
    if (step.action !== 'wrote') {
      continue;
    }
    upsertEnvValue(envPath, step.key, step.value);
    out[step.key] = step.value;
  }
}

/**
 * Which two stores a reset has to drop, named in the words of the profile they belong to. The
 * docker pair is two volumes; the native pair is a directory this install owns and a directory
 * the Neo4j somebody else manages owns, which is why the second one is a lookup rather than a
 * path.
 */
export function storeDropCommands(profile: InstallProfile, dataDir: string): readonly string[] {
  if (profile === 'native') {
    return [
      `rm -rf ${dataDir}`,
      'stop Neo4j, then remove the database and transaction directories under its data directory',
      "  (`SHOW SETTINGS 'server.directories.data'` on the running server names it)",
    ];
  }
  return ['docker compose --profile mcp down', 'docker volume rm aion_aion-neo4j aion_aion-data'];
}

/**
 * What puts a running service on the code the repo holds, which is a different pair of acts on
 * each profile: docker bakes the sha into the image at build and the container takes it on the
 * next recreate, and the native job runs the built tree with the sha init wrote into its plist,
 * so a rebuild reaches it through an init that rewrites the job and reloads it.
 *
 * The command uses the recorded profile, so a refresh never selects a different install.
 */
export function serviceRefreshRemedy(profile: InstallProfile): string {
  if (profile === 'native') {
    return 'npm run build, then `aion init` to restamp the job';
  }
  return 'run `aion init` to rebuild the image and refresh the service';
}

export type StorePairing = 'fresh' | 'paired' | 'graph-without-database' | 'database-without-graph';

/**
 * Whether the two stores were made by the same substrate. A half reset — one store dropped and
 * the other kept — leaves init finishing normally and the service failing on its next start,
 * with `publication_foreign_graph_pairing` when the database is the new half and
 * `publication_guard_missing_or_ambiguous` when the graph is. Both are the same operator
 * mistake, and both are cheaper to name here than to diagnose from a boot failure.
 */
export function storePairing(input: {
  readonly graphEstablished: boolean;
  readonly databaseEstablished: boolean;
}): StorePairing {
  if (input.graphEstablished && input.databaseEstablished) {
    return 'paired';
  }
  if (input.graphEstablished) {
    return 'graph-without-database';
  }
  if (input.databaseEstablished) {
    return 'database-without-graph';
  }
  return 'fresh';
}

/**
 * The same verdict over a live substrate. The backbone Member is the graph's own evidence that a
 * substrate was born there, and the applied-migration record is the database's; each survives
 * everything except its own store being dropped. Read before migrations run, because running
 * them is what makes the missing half look present again.
 */
export async function readStorePairing(driver: Driver, db: SqliteHandle): Promise<StorePairing> {
  const memberName = await readMemberName(driver);
  return storePairing({
    graphEstablished: memberName !== undefined,
    databaseEstablished: appliedGraphSchemaVersion(db) !== undefined,
  });
}

/** What a split pair costs, and the only way out of it: drop both and initialize again. */
export function storePairingRefusal(
  pairing: StorePairing,
  profile: InstallProfile,
  dataDir: string,
): readonly string[] {
  const kept =
    pairing === 'graph-without-database'
      ? 'the graph holds a substrate and the database holds no schema history'
      : 'the database holds schema history and the graph holds no backbone';
  return [
    `the two stores are not a pair: ${kept}.`,
    'A substrate is both stores together, and the half that survived cannot be adopted by a new',
    'one: the service refuses at its next start rather than serving a graph its receipts do not',
    'describe. Drop both and initialize again:',
    ...storeDropCommands(profile, dataDir).map((line) => `  ${line}`),
  ];
}

/**
 * `--install docker` on a native install is a refusal rather than a silent no-op.
 *
 * Only the native branch does anything with the flag, so asking for docker on a substrate that is
 * native used to validate and then change nothing: init would carry on against the host addresses
 * it was told to leave. Switching is not a flag, and it is not one line either. The two profiles
 * keep their substrates in different places — two volumes against two directories — so the move is
 * a reset and an init, with whatever the old substrate held dropped deliberately.
 *
 * The other direction is not refused, because `docker` is the code default and a recorded default
 * cannot be told from nobody having chosen. `--install native` on a docker-shaped config is the
 * first choice rather than a switch, and the store-pairing check is what catches the case where it
 * is pointed at a substrate that already exists elsewhere.
 */
export function refuseProfileSwitch(
  requested: InstallProfile | undefined,
  current: InstallProfile,
): void {
  if (requested === undefined || requested === current || current !== 'native') {
    return;
  }
  throw new CliUsageError(
    `this substrate is ${current}; switching profiles is a reset-and-init, not a flag. ` +
      'Drop both stores (docs/operations.md, "Resetting the substrate"), set ' +
      `${INSTALL_PROFILE_ENV_VAR}=${requested} in .env, and run init.`,
  );
}

/** One line for `aion status` and one doctor check: which substrate this install is running. */
export function describeInstallProfile(config: Config): string {
  if (config.install.profile === 'native') {
    return `native   host processes, data under ${config.operational.dataDir}`;
  }
  return 'docker   compose services neo4j and aion-mcp';
}
