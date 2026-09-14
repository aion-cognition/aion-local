import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { gdsJarName, gdsJarUrl, gdsReleaseFor } from './gds-releases.js';
import { NativeSetupError, type HostActions } from './host-actions.js';
import type { Writer } from './output.js';

/**
 * Installing and configuring the Neo4j a native install runs on, which is the half of the setup
 * that is not the substrate. It does the work rather than printing instructions for it; what it
 * prints is what it did, and a step it could not take becomes the exact command that takes it.
 *
 * Nothing here is discovered by assumption. A Homebrew install, a tarball and a package install
 * each keep the distribution somewhere else, so the layout is probed for the two files that matter
 * and a layout that cannot be found is a named refusal rather than a guess written to a path.
 */

/** Where the distribution might be, in the order worth trying. */
function homeCandidates(brewPrefix: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const declared = (env.NEO4J_HOME ?? '').trim();
  const candidates = declared === '' ? [] : [declared];
  if (brewPrefix !== undefined) {
    candidates.push(join(brewPrefix, 'libexec'), brewPrefix, join(brewPrefix, 'share', 'neo4j'));
  }
  return candidates;
}

export type Neo4jLayout = {
  readonly home: string;
  readonly confFile: string;
  readonly pluginsDir: string;
  /** Absent where the distribution ships no admin tool on this layout. */
  readonly adminBin: string | undefined;
  readonly serverBin: string | undefined;
  /** True when Homebrew owns the install, which decides how it is started. */
  readonly brewManaged: boolean;
};

async function brewPrefixFor(actions: HostActions, formula: string): Promise<string | undefined> {
  const result = await actions.run('brew', ['--prefix', formula]);
  const path = result.stdout.trim();
  return result.ok && path !== '' && existsSync(path) ? path : undefined;
}

/**
 * The layout, or nothing. A home counts when it holds the config file, because that is the file
 * the substrate's settings have to go into and a distribution without one is not one.
 */
export async function resolveNeo4jLayout(
  actions: HostActions,
  env: NodeJS.ProcessEnv,
): Promise<Neo4jLayout | undefined> {
  const brewPrefix = await brewPrefixFor(actions, 'neo4j');
  for (const home of homeCandidates(brewPrefix, env)) {
    const confFile = join(home, 'conf', 'neo4j.conf');
    if (!existsSync(confFile)) {
      continue;
    }
    const adminBin = join(home, 'bin', 'neo4j-admin');
    const serverBin = join(home, 'bin', 'neo4j');
    return {
      home,
      confFile,
      // The dist always ships one, but an install that pruned it still gets a jar put somewhere
      // the server reads rather than a failure two steps later.
      pluginsDir: join(home, 'plugins'),
      adminBin: existsSync(adminBin) ? adminBin : undefined,
      serverBin: existsSync(serverBin) ? serverBin : undefined,
      brewManaged: brewPrefix !== undefined && home.startsWith(brewPrefix),
    };
  }
  return undefined;
}

/**
 * Installs Neo4j when it is not there, through the package manager the machine already has. The
 * brew formula pulls its own JDK, which is why this is the primary path rather than a tarball the
 * operator would then need a Java for.
 */
export async function ensureNeo4jInstalled(
  actions: HostActions,
  env: NodeJS.ProcessEnv,
  write: Writer,
): Promise<Neo4jLayout> {
  const existing = await resolveNeo4jLayout(actions, env);
  if (existing !== undefined) {
    write(`  neo4j present at ${existing.home}`);
    return existing;
  }
  const brew = await actions.run('brew', ['--version']);
  if (!brew.ok) {
    throw new NativeSetupError(
      'no Neo4j on this machine and no Homebrew to install it with. Install one of them, then run init again:',
      [
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        'brew install neo4j',
        'or install Neo4j yourself and export NEO4J_HOME to its directory',
      ],
    );
  }
  write('  installing neo4j through homebrew (this pulls a JDK and takes a few minutes)');
  const install = await actions.run('brew', ['install', 'neo4j']);
  if (!install.ok) {
    throw new NativeSetupError(`brew install neo4j failed: ${install.stderr.trim()}`, [
      'brew install neo4j',
    ]);
  }
  const installed = await resolveNeo4jLayout(actions, env);
  if (installed === undefined) {
    throw new NativeSetupError(
      'brew installed neo4j and no conf/neo4j.conf turned up under its prefix. Point init at the distribution:',
      ['export NEO4J_HOME=$(brew --prefix neo4j)/libexec', 'aion init --install native'],
    );
  }
  write(`  neo4j installed at ${installed.home}`);
  return installed;
}

/** CalVer out of whatever the distribution says its version is. */
function calVer(text: string): string | undefined {
  return /\b(\d{4}\.\d{2}\.\d+)\b/.exec(text)?.[1];
}

/**
 * The installed server's version, read before it is started, because the plugin that has to be in
 * place before the first start is chosen by it. The binary is asked first; a layout whose binary
 * will not run without a JVM still answers from the kernel jar's own filename.
 */
export async function readInstalledServerVersion(
  layout: Neo4jLayout,
  actions: HostActions,
): Promise<string | undefined> {
  if (layout.serverBin !== undefined) {
    const result = await actions.run(layout.serverBin, ['--version']);
    const version = calVer(`${result.stdout} ${result.stderr}`);
    if (version !== undefined) {
      return version;
    }
  }
  const lib = join(layout.home, 'lib');
  if (!existsSync(lib)) {
    return undefined;
  }
  for (const entry of readdirSync(lib)) {
    if (entry.startsWith('neo4j-kernel-')) {
      const version = calVer(entry);
      if (version !== undefined) {
        return version;
      }
    }
  }
  return undefined;
}

function series(version: string): string {
  const parts = version.split('.');
  return parts.length < 2 ? version : `${parts[0] ?? ''}.${parts[1] ?? ''}`;
}

/**
 * Puts the matching graph-data-science jar in the plugins directory, verifying what arrived
 * against a digest measured in this repo, and answers with the path it placed or nothing. A jar
 * already there is left alone: it may be the one an operator placed deliberately, the pairing
 * check after the server starts is what judges it, and uninstall removes only what we put down.
 *
 * A server series with no measured digest is the one case that stops and asks, and it asks with
 * the whole command rather than with a policy.
 */
export async function ensureGdsPlugin(
  layout: Neo4jLayout,
  serverVersion: string,
  actions: HostActions,
  write: Writer,
): Promise<string | undefined> {
  mkdirSync(layout.pluginsDir, { recursive: true });
  const present = readdirSync(layout.pluginsDir).filter(
    (entry) => entry.includes('graph-data-science') && entry.endsWith('.jar'),
  );
  if (present.length > 0) {
    write(`  graph-data-science plugin present (${present.join(', ')})`);
    // Nothing placed: somebody else's jar, and uninstall has to be able to tell the difference.
    return undefined;
  }
  const release = gdsReleaseFor(series(serverVersion));
  if (release === undefined) {
    throw new NativeSetupError(
      `no measured graph-data-science digest for a ${series(serverVersion)} server, and an unverified plugin jar is not installed automatically. Place it by hand, or record its digest in packages/cli/src/gds-releases.ts:`,
      [
        `curl -L -o ${join(layout.pluginsDir, gdsJarName(`${series(serverVersion)}.0`))} \\`,
        `  ${gdsJarUrl(`${series(serverVersion)}.0`)}`,
        'then re-run init (the release list names the exact asset for each server series)',
      ],
    );
  }
  const target = join(layout.pluginsDir, gdsJarName(release.version));
  write(`  fetching graph-data-science ${release.version} (${String(release.bytes)} bytes)`);
  const arrived = await actions.fetch(gdsJarUrl(release.version), target);
  if (arrived.sha256 !== release.sha256) {
    rmSync(target, { force: true });
    throw new NativeSetupError(
      `the graph-data-science download did not match its recorded digest and was deleted (expected ${release.sha256}, got ${arrived.sha256}). Nothing was installed.`,
      [
        `curl -L -o ${target} ${gdsJarUrl(release.version)}`,
        `shasum -a 256 ${target}   # compare against gds-releases.ts before keeping it`,
      ],
    );
  }
  write(`  graph-data-science ${release.version} verified and installed`);
  return target;
}

/**
 * The settings the substrate needs, as one idempotent rewrite of `neo4j.conf`.
 *
 * A key already carrying the wanted value is left untouched; a key carrying something else is
 * replaced and reported, so a re-run on a configured server changes nothing and says so. Lines
 * this build does not own are preserved exactly, comments included: the file belongs to whoever
 * installed the server.
 */
export function applyNeo4jSettings(
  confFile: string,
  settings: readonly (readonly [string, string])[],
): readonly string[] {
  const original = existsSync(confFile) ? readFileSync(confFile, 'utf8') : '';
  const lines = original === '' ? [] : original.split('\n');
  const changed: string[] = [];
  for (const [key, value] of settings) {
    const entry = `${key}=${value}`;
    const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
    if (index === -1) {
      lines.push(entry);
      changed.push(key);
      continue;
    }
    if (lines[index] === entry) {
      continue;
    }
    lines[index] = entry;
    changed.push(key);
  }
  if (changed.length > 0) {
    writeFileSync(confFile, lines.join('\n'));
  }
  return changed;
}

/**
 * What the compose file sets, translated. The memory numbers are the same modest laptop tuning
 * and the same reason: one user, one graph, and the JVM's own heuristics over-claim on a shared
 * machine. The retention policy is smaller than the container's `2 days 1G`, because a native
 * install keeps its logs on the operator's own disk beside everything else they run.
 *
 * Bolt is bound to loopback, which is what the container's published `127.0.0.1:7687` did.
 */
export const NEO4J_SETTINGS: readonly (readonly [string, string])[] = [
  ['dbms.security.procedures.unrestricted', 'gds.*'],
  ['dbms.security.procedures.allowlist', 'gds.*'],
  ['server.memory.heap.initial_size', '512m'],
  ['server.memory.heap.max_size', '1G'],
  ['server.memory.pagecache.size', '512m'],
  ['db.tx_log.rotation.retention_policy', '1 days 256M'],
  ['server.bolt.listen_address', '127.0.0.1:7687'],
];

/**
 * Brew's neo4j formula depends on this JDK. The service plist sets JAVA_HOME to it before
 * starting the server; a plain neo4j-admin invocation from this CLI gets only what the caller's
 * own shell exported, which on a fresh install is nothing.
 */
const BREW_JDK_FORMULA = 'openjdk@21';

async function resolveBrewJavaHome(actions: HostActions): Promise<string | undefined> {
  const prefix = await brewPrefixFor(actions, BREW_JDK_FORMULA);
  if (prefix === undefined) {
    return undefined;
  }
  const home = join(prefix, 'libexec', 'openjdk.jdk', 'Contents', 'Home');
  return existsSync(home) ? home : undefined;
}

/**
 * The environment a neo4j-admin call runs with. A brew-managed layout with no JAVA_HOME already
 * set needs brew's own JDK, because brew never puts it on PATH the way it does for the service
 * plist; anywhere else the caller's environment passes through untouched, since a tarball or
 * package install is expected to carry its own Java.
 *
 * Unresolvable is a named failure here rather than an environment neo4j-admin would then fail on
 * anyway with the same "Unable to locate a Java Runtime" this exists to avoid.
 */
export async function resolveAdminEnv(
  layout: Neo4jLayout,
  env: NodeJS.ProcessEnv,
  actions: HostActions,
): Promise<NodeJS.ProcessEnv> {
  if (!layout.brewManaged || (env.JAVA_HOME ?? '').trim() !== '') {
    return env;
  }
  const javaHome = await resolveBrewJavaHome(actions);
  if (javaHome === undefined) {
    throw new NativeSetupError(
      `neo4j-admin needs a JDK and brew's ${BREW_JDK_FORMULA} did not resolve. Install it, then run init again:`,
      [`brew install ${BREW_JDK_FORMULA}`, 'aion init --install native'],
    );
  }
  return { ...env, JAVA_HOME: javaHome };
}

/**
 * The `server.directories.data` neo4j.conf carries, or the distribution's default. Brew points
 * this at a prefix entirely outside `home`, so it is read rather than assumed.
 */
function neo4jDataDir(layout: Neo4jLayout): string {
  const text = existsSync(layout.confFile) ? readFileSync(layout.confFile, 'utf8') : '';
  const line = text.split('\n').find((l) => l.trimStart().startsWith('server.directories.data='));
  const configured = line?.slice(line.indexOf('=') + 1).trim() ?? '';
  if (configured === '') {
    return join(layout.home, 'data');
  }
  return isAbsolute(configured) ? configured : join(layout.home, configured);
}

/**
 * Whether this server has ever completed a real first boot. Neo4j creates its system database,
 * where user credentials actually live once the server has run, only then; `neo4j-admin dbms
 * set-initial-password` writes its own seed file regardless of that, so the seed file's presence
 * answers nothing about whether a boot ever happened. A virgin store has not had one yet: a
 * failed password set here is the last chance before the coming boot fills the account in with
 * defaults, not a refusal Bolt will go on to judge.
 */
export function isVirginNeo4jStore(layout: Neo4jLayout): boolean {
  return !existsSync(join(neo4jDataDir(layout), 'databases', 'system'));
}

/**
 * Sets the password the substrate will use, which only works before the database is initialized.
 * On an already-initialized server a refusal here is a no-op and the answer comes from Bolt
 * instead. On a virgin store it is not: nothing has picked a password yet, and starting the
 * server anyway would boot it straight onto defaults, which is what the caller stops here to
 * avoid — including when there is no admin tool at all to try it with.
 */
export async function setInitialPassword(
  layout: Neo4jLayout,
  password: string,
  actions: HostActions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (layout.adminBin === undefined) {
    if (!isVirginNeo4jStore(layout)) {
      return;
    }
    throw new NativeSetupError(
      `no neo4j-admin under ${layout.home}, and a virgin store cannot get its initial password ` +
        `without one; the coming boot would start it on defaults instead. Get the admin tool, ` +
        `then run init again:`,
      ['brew install neo4j', 'or point NEO4J_HOME at a distribution that ships bin/neo4j-admin'],
    );
  }
  const runEnv = await resolveAdminEnv(layout, env, actions);
  const result = await actions.run(
    layout.adminBin,
    ['dbms', 'set-initial-password', password],
    runEnv,
  );
  if (result.ok || !isVirginNeo4jStore(layout)) {
    return;
  }
  // Brew never puts its JDK on PATH, so the command an operator runs by hand needs the same
  // JAVA_HOME prefix the call above just ran with, or it fails on the same missing Java.
  const javaHome =
    layout.brewManaged && (env.JAVA_HOME ?? '').trim() === '' ? runEnv.JAVA_HOME : undefined;
  const prefix = javaHome === undefined ? '' : `JAVA_HOME=${javaHome} `;
  throw new NativeSetupError(
    `neo4j-admin could not set the initial password on a store that has never booted, and the ` +
      `coming boot would start it on defaults instead: ${result.stderr.trim()}`,
    [
      `${prefix}${layout.adminBin} dbms set-initial-password "<password>"`,
      'aion init --install native',
    ],
  );
}

export async function startNeo4j(
  layout: Neo4jLayout,
  actions: HostActions,
  write: Writer,
): Promise<void> {
  if (layout.brewManaged) {
    write('  starting neo4j (brew services)');
    const started = await actions.run('brew', ['services', 'start', 'neo4j']);
    if (started.ok) {
      return;
    }
    throw new NativeSetupError(`brew services start neo4j failed: ${started.stderr.trim()}`, [
      'brew services start neo4j',
    ]);
  }
  if (layout.serverBin === undefined) {
    throw new NativeSetupError(`no neo4j binary to start under ${layout.home}`, [
      'start the server yourself, then run init again',
    ]);
  }
  write(`  starting neo4j (${layout.serverBin} start)`);
  const started = await actions.run(layout.serverBin, ['start']);
  if (!started.ok) {
    throw new NativeSetupError(`neo4j start failed: ${started.stderr.trim()}`, [
      `${layout.serverBin} console   # run it in the foreground to see why`,
    ]);
  }
}

/**
 * Neo4j's own recovery procedure for a password that is genuinely lost. Linked rather than run:
 * it changes another server's auth store, not something this build installs, and the operator is
 * the one who has to decide whether losing the password justifies that change.
 */
const PASSWORD_RECOVERY_DOC =
  'https://neo4j.com/docs/operations-manual/current/authentication-authorization/password-and-user-recovery/';

/**
 * The password refusal, in one place, because it is the one failure with two different fixes.
 * `dbms set-initial-password` is not one of them: it only takes effect before a store's first
 * boot, and a server already refusing this password over Bolt has had one.
 */
export function passwordRefusal(
  uri: string,
  layout: Neo4jLayout | undefined,
  _actions: HostActions,
  _env: NodeJS.ProcessEnv,
): NativeSetupError {
  const admin = layout?.adminBin ?? '$NEO4J_HOME/bin/neo4j-admin';
  return new NativeSetupError(
    `the Neo4j at ${uri} refused the password in .env. It is a server that was initialized with ` +
      `another one, and ${admin} dbms set-initial-password will not change it now: that only ` +
      `works before a store's first boot, which this server has already had. Either tell the ` +
      `substrate the real password or recover the lost one on the server itself:`,
    [
      'put the existing password in AION_NEO4J_PASSWORD in .env, or',
      `follow Neo4j's own account-recovery procedure: ${PASSWORD_RECOVERY_DOC}`,
      'then run init again',
    ],
  );
}
