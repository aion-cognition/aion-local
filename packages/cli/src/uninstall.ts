import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { parseArgs, type ArgSpec } from './args.js';
import { composeRunner } from './compose.js';
import { claudeSettingsPath } from './hook/settings-file.js';
import { DEFAULT_HOOKS_FLAGS, uninstallHooks, type HooksCommandOptions } from './hooks-cmd.js';
import { HOST_ACTIONS, type HostActions } from './host-actions.js';
import { readInstallManifest, type InstallManifest } from './install-manifest.js';
import { launchAgentPath, mcpScriptPath, MCP_LAUNCH_LABEL } from './launchd.js';
import { askLine, confirmOrExit, stderrWriter, stdoutWriter, type Writer } from './output.js';
import { resolveRepoDir } from './paths.js';
import {
  launchdDomain,
  readLaunchdJob,
  readListenerPids,
  readProcessCommand,
  type LaunchdJobState,
  type Observed,
} from './service-binding.js';
import { withSubstrate } from './substrate.js';
import {
  installedModelTags,
  planUninstall,
  sharedToolCommands,
  type UninstallItem,
} from './uninstall-plan.js';

/**
 * `aion uninstall`: the mirror of init, and the only command that removes the memory store.
 *
 * It asks twice: the ordinary destructive confirm, which `--yes` skips, and a second asking for
 * the data root to be typed back, which nothing skips — the step that deletes everything the
 * substrate ever remembered is not one a flag should answer for.
 *
 * It removes what this install put there and prints the rest with its commands, untouched:
 * `uninstall-plan.ts` carries the rule and decides all of it beforehand.
 */

const SPEC: ArgSpec = {
  command: 'uninstall',
  usage: 'aion uninstall [--yes]',
  options: [{ flag: '--yes', alias: '-y' }],
};

export type UninstallFlags = { readonly yes: boolean };

export function parseUninstallFlags(argv: readonly string[]): UninstallFlags {
  return { yes: parseArgs(SPEC, argv).flags.has('--yes') };
}

export function writePlan(items: readonly UninstallItem[], write: Writer): void {
  for (const label of ['remove', 'manual', 'keep'] as const) {
    const group = items.filter((item) => item.action === label);
    if (group.length === 0) {
      continue;
    }
    write(`${label}:`);
    for (const item of group) {
      write(`  ${item.what}: ${item.target}`);
      write(`    ${item.why}`);
      for (const command of item.commands ?? []) {
        write(`    $ ${command}`);
      }
    }
  }
}

/**
 * Cuts the lines this install wrote, leaving every other line alone — including one carrying a
 * key we own with a changed value: an edited setting is a decision, not something to undo.
 */
export function stripOwnedSettings(
  confFile: string,
  owned: readonly (readonly [string, string])[],
): number {
  const lines = readFileSync(confFile, 'utf8').split('\n');
  const ours = new Set(owned.map(([key, value]) => `${key}=${value}`));
  const kept = lines.filter((line) => !ours.has(line.trim()));
  if (kept.length !== lines.length) {
    writeFileSync(confFile, kept.join('\n'));
  }
  return lines.length - kept.length;
}

/**
 * `uninstallHooks` also knows codex and its own repo verification; none of that applies here,
 * since init only ever writes the claude harness. This reuses its read, backup and strip.
 */
function claudeHooksOptions(settingsPath: string, now: Date): HooksCommandOptions {
  return {
    flags: DEFAULT_HOOKS_FLAGS,
    settingsPath,
    codexHooksPath: '',
    codexConfigPath: '',
    repo: { path: '', verified: false },
    now,
    env: {},
  };
}

/**
 * What became of the owned service when uninstall tried to stop it.
 *
 * `absent`/`stopped` mean nothing of ours is running — the only readings that let the data root
 * go. `alive` is the state a failed `bootout` used to be read as `absent`: the process still
 * holds the port and the store open. `unknown` had no name at all — a denied `launchctl print`, a
 * job launchd still holds, an observation that threw — and none of those say stopped either.
 */
type ServiceShutdown =
  | { readonly outcome: 'stopped' | 'absent' }
  | { readonly outcome: 'alive'; readonly pid: number; readonly command: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

/** The search for a process the job started, where a reading that could not be taken is neither. */
type OwnedProcessSearch =
  | { readonly found: 'running'; readonly pid: number; readonly command: string }
  | { readonly found: 'none' }
  | { readonly found: 'unknown'; readonly reason: string };

/** What the owned process would be running, when the manifest recorded where it was built. */
function ownedScriptPath(manifest: InstallManifest | undefined): string | undefined {
  if (manifest?.repoDir === undefined) {
    return undefined;
  }
  return mcpScriptPath(manifest.repoDir);
}

/**
 * The owned process, if one is still up: launchd's pid while it knows the job, or else the port,
 * where a holder is ours only when it runs our recorded server. A holder that is not ours is
 * named and left alone; nothing here signals, boots out or kills anything.
 */
async function survivingOwnedProcess(
  actions: HostActions,
  candidates: readonly (number | undefined)[],
  port: number | undefined,
  scriptPath: string | undefined,
  write: Writer,
): Promise<OwnedProcessSearch> {
  for (const pid of [...new Set(candidates)]) {
    if (pid === undefined) {
      continue;
    }
    const seen = await readProcessCommand(actions, pid);
    if (!seen.known) {
      return { found: 'unknown', reason: `pid ${String(pid)} could not be read: ${seen.reason}` };
    }
    if (seen.value !== undefined) {
      return { found: 'running', pid, command: seen.value };
    }
  }
  if (port === undefined) {
    return { found: 'none' };
  }
  const listeners = await readListenerPids(actions, port);
  if (!listeners.known) {
    return {
      found: 'unknown',
      reason: `what is listening on port ${String(port)} could not be read: ${listeners.reason}`,
    };
  }
  for (const pid of listeners.value) {
    const seen = await readProcessCommand(actions, pid);
    if (!seen.known) {
      return { found: 'unknown', reason: `pid ${String(pid)} could not be read: ${seen.reason}` };
    }
    if (seen.value === undefined) {
      continue;
    }
    if (scriptPath !== undefined && seen.value.includes(scriptPath)) {
      return { found: 'running', pid, command: seen.value };
    }
    write(
      `  port ${String(port)} is held by pid ${String(pid)}, which is not this install's server; left alone`,
    );
  }
  return { found: 'none' };
}

/** What a pid launchd named, when it named one and the read succeeded. */
function namedPid(job: Observed<LaunchdJobState>): number | undefined {
  return job.known ? job.value.pid : undefined;
}

/**
 * The one reading a `stopped`/`absent` verdict may rest on: launchd's own account, read after
 * whatever this run did, saying it no longer holds the job. A registered job with no current pid
 * does not satisfy this — KeepAlive is exactly that shape between respawns — and neither does an
 * unreadable one.
 */
function accountsForShutdown(job: Observed<LaunchdJobState>): boolean {
  return job.known && !job.value.loaded;
}

/**
 * Boots the job out and then establishes what happened, rather than reading the bootout's own exit
 * status as the answer. A failed bootout and a job that was never there are the same exit code.
 *
 * A bootout reporting success answers only one of three things that have to hold: no process of
 * ours survives, the pre-bootout read succeeded, and launchd's after-read says the job is gone. It
 * never substitutes for the other two, exactly as a reported failure never substitutes for the job
 * actually being loaded.
 */
async function unloadLaunchdJob(
  plistPath: string,
  actions: HostActions,
  write: Writer,
  port: number | undefined,
  scriptPath: string | undefined,
): Promise<ServiceShutdown> {
  const domain = launchdDomain();
  // Read before the bootout: the pid launchd names now is the process we have to account for
  // afterwards, and a successful bootout takes the job's name with it.
  const before = await readLaunchdJob(actions);
  const unloaded = await actions.run('launchctl', ['bootout', domain, plistPath]);
  const after = await readLaunchdJob(actions);
  const detail = unloaded.stderr.trim() || 'no detail';
  const survivor = await survivingOwnedProcess(
    actions,
    [namedPid(before), namedPid(after)],
    port,
    scriptPath,
    write,
  );
  if (survivor.found === 'running') {
    write(
      `  ${MCP_LAUNCH_LABEL} is still running as pid ${String(survivor.pid)} after bootout ` +
        `(${unloaded.ok ? 'bootout reported success' : detail})`,
    );
    return { outcome: 'alive', pid: survivor.pid, command: survivor.command };
  }
  if (survivor.found === 'unknown') {
    write(`  could not establish whether ${MCP_LAUNCH_LABEL} stopped: ${survivor.reason}`);
    return { outcome: 'unknown', reason: survivor.reason };
  }
  if (!before.known) {
    // Without the pre-bootout pid, an old owned process could be running under one neither the
    // after-read nor the port would surface; a clean-looking after-state does not account for it.
    const reason = `launchd could not be read for ${MCP_LAUNCH_LABEL} before bootout: ${before.reason}`;
    write(`  ${reason}`);
    return { outcome: 'unknown', reason };
  }
  const attempt = unloaded.ok ? 'bootout reported success but' : `did not boot out (${detail}) and`;
  if (!accountsForShutdown(after)) {
    const reason = after.known
      ? `${MCP_LAUNCH_LABEL} ${attempt} launchd still holds the job`
      : `${MCP_LAUNCH_LABEL} ${attempt} launchd could not be read afterwards: ${after.reason}`;
    write(`  ${reason}`);
    return { outcome: 'unknown', reason };
  }
  if (unloaded.ok) {
    write(`  unloaded ${MCP_LAUNCH_LABEL}`);
    rmSync(plistPath, { force: true });
    return { outcome: 'stopped' };
  }
  write(`  ${MCP_LAUNCH_LABEL} was not loaded (${unloaded.stderr.trim() || 'no job'})`);
  rmSync(plistPath, { force: true });
  return { outcome: 'absent' };
}

/**
 * The same question when the plan named no launchd step: an absent plist is not an absent
 * service, since the process it started can still hold the store open.
 */
async function observeOwnedService(
  actions: HostActions,
  manifest: InstallManifest | undefined,
  port: number | undefined,
  write: Writer,
): Promise<ServiceShutdown> {
  const job = await readLaunchdJob(actions);
  if (!job.known) {
    return {
      outcome: 'unknown',
      reason: `launchd could not be read for ${MCP_LAUNCH_LABEL}: ${job.reason}`,
    };
  }
  const survivor = await survivingOwnedProcess(
    actions,
    [job.value.pid],
    port,
    ownedScriptPath(manifest),
    write,
  );
  if (survivor.found === 'running') {
    write(
      `  ${MCP_LAUNCH_LABEL} is still running as pid ${String(survivor.pid)} with no job file to unload`,
    );
    return { outcome: 'alive', pid: survivor.pid, command: survivor.command };
  }
  if (survivor.found === 'unknown') {
    return { outcome: 'unknown', reason: survivor.reason };
  }
  if (!accountsForShutdown(job)) {
    // No plist to unload is not nothing registered: a KeepAlive job has no pid to have been found.
    const reason = `no job file to unload, and launchd still holds ${MCP_LAUNCH_LABEL}`;
    write(`  ${reason}`);
    return { outcome: 'unknown', reason };
  }
  return { outcome: 'absent' };
}

/** Why the data root stays, or undefined when the service is accounted for and it may go. */
function deletionRefusal(shutdown: ServiceShutdown, target: string): string | undefined {
  if (shutdown.outcome === 'alive') {
    return `data root (${target}): refused while pid ${String(shutdown.pid)} still holds it`;
  }
  if (shutdown.outcome === 'unknown') {
    return `data root (${target}): refused because the owned service was not shown to be stopped: ${shutdown.reason}`;
  }
  return undefined;
}

export type UninstallExecution = {
  readonly removed: readonly string[];
  readonly failed: readonly string[];
};

/**
 * Removes what the plan marked `remove`, in the plan's order. Every step is guarded on its own: a
 * machine part-way through an install is the usual caller, and one thing missing must not stop
 * the next thing that is there.
 *
 * The service step is the one exception: a server still running writes the store the data-root
 * step would delete, so that step waits on a shutdown or a demonstrated absence, even with no
 * launchd step because the plist was already gone. `mcpPort` finds a process launchd forgot.
 */
export async function executeUninstall(
  items: readonly UninstallItem[],
  manifest: InstallManifest | undefined,
  actions: HostActions,
  compose: (args: readonly string[]) => Promise<string>,
  write: Writer,
  now: Date = new Date(),
  mcpPort?: number,
): Promise<UninstallExecution> {
  const removed: string[] = [];
  const failed: string[] = [];
  // The docker profile's server is a container compose takes down; no launchd job to account for.
  const hostServed =
    manifest?.profile !== 'docker' &&
    !items.some((entry) => entry.what === 'compose services and volumes');
  let shutdown: ServiceShutdown | undefined;
  for (const item of items.filter((entry) => entry.action === 'remove')) {
    try {
      if (item.what === 'launchd job') {
        shutdown = await unloadLaunchdJob(
          item.target,
          actions,
          write,
          mcpPort,
          ownedScriptPath(manifest),
        );
        if (shutdown.outcome === 'alive') {
          failed.push(
            `${item.what} (${item.target}): ${MCP_LAUNCH_LABEL} is still running as pid ` +
              `${String(shutdown.pid)}; the job file is left in place`,
          );
          continue;
        }
        if (shutdown.outcome === 'unknown') {
          failed.push(
            `${item.what} (${item.target}): ${shutdown.reason}; the job file is left in place`,
          );
          continue;
        }
      } else if (item.what === 'data root') {
        // The store this would delete is the one a surviving server has open; deleting it would
        // leave that server serving a nameless file, so an unproved shutdown refuses it too.
        shutdown ??= hostServed
          ? await observeOwnedService(actions, manifest, mcpPort, write)
          : { outcome: 'absent' };
        const refusal = deletionRefusal(shutdown, item.target);
        if (refusal !== undefined) {
          failed.push(refusal);
          continue;
        }
        rmSync(item.target, { recursive: true, force: true });
      } else if (item.what === 'compose services and volumes') {
        await compose(['--profile', 'mcp', 'down', '--volumes']);
      } else if (item.what === 'neo4j.conf settings') {
        const cut = stripOwnedSettings(item.target, manifest?.neo4jSettings ?? []);
        write(`  cut ${String(cut)} lines from ${item.target}`);
      } else if (item.what === 'claude hooks') {
        // Explicit, so a settings file never falls to the rmSync below and gets deleted outright.
        uninstallHooks(claudeHooksOptions(item.target, now), write);
      } else {
        rmSync(item.target, { recursive: true, force: true });
      }
      removed.push(`${item.what} (${item.target})`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'failed';
      if (item.what === 'launchd job') {
        // The step that would answer whether the service stopped is the step that threw.
        shutdown = { outcome: 'unknown', reason: `the service step failed: ${detail}` };
      }
      failed.push(`${item.what} (${item.target}): ${detail}`);
    }
  }
  return { removed, failed };
}

function writeSummary(
  execution: UninstallExecution,
  items: readonly UninstallItem[],
  models: readonly string[],
  write: Writer,
): void {
  write('');
  write(`removed ${String(execution.removed.length)}:`);
  for (const line of execution.removed) {
    write(`  ${line}`);
  }
  const kept = items.filter((item) => item.action !== 'remove');
  write(`kept ${String(kept.length)}: ${kept.map((item) => item.what).join(', ') || 'nothing'}`);
  for (const line of execution.failed) {
    write(`failed: ${line}`);
  }
  write('');
  write('shared tools are never removed by this command. To take them off the machine too:');
  for (const command of sharedToolCommands(models)) {
    write(`  $ ${command}`);
  }
}

export function runUninstall(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
  actions: HostActions = HOST_ACTIONS,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseUninstallFlags,
    run: async (substrate, flags) => {
      const { config } = substrate;
      const { dataDir } = config.operational;
      const manifest = readInstallManifest(dataDir);
      const models = installedModelTags(config);
      const items = planUninstall({
        profile: config.install.profile,
        dataDir,
        manifest,
        launchAgentPath: launchAgentPath(homedir()),
        platform: process.platform,
        models,
        settingsPath: claudeSettingsPath(homedir()),
      });
      write(`data root ${dataDir}`);
      write(
        manifest === undefined
          ? 'no install record: only what this command can name for itself is removed.'
          : `install recorded ${manifest.recordedAt}`,
      );
      write('');
      writePlan(items, write);
      if (!items.some((item) => item.action === 'remove')) {
        write('');
        write('nothing to remove.');
        return 0;
      }

      write('');
      if (!(await confirmOrExit('remove all of the above? [y/N] ', flags.yes, write))) {
        write('cancelled');
        return 1;
      }
      // The second question, unanswered by `--yes`: the data root is every episode the substrate ever wrote.
      if (existsSync(dataDir)) {
        if (!process.stdin.isTTY) {
          stderrWriter(`refusing to delete ${dataDir} with no terminal to confirm it on.`);
          return 1;
        }
        write('');
        write(`${dataDir} is this substrate's memory store. Deleting it cannot be undone.`);
        const typed = (await askLine('type the path to confirm: ')).trim();
        if (typed !== dataDir) {
          stderrWriter('path did not match; nothing was removed.');
          return 1;
        }
      } else {
        write('data root already gone; removing the rest.');
      }

      const execution = await executeUninstall(
        items,
        manifest,
        actions,
        composeRunner(resolveRepoDir()),
        write,
        new Date(),
        config.operational.mcpPort,
      );
      writeSummary(execution, items, models, write);
      return execution.failed.length === 0 ? 0 : 1;
    },
  });
}
