import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { parseArgs, type ArgSpec } from './args.js';
import { composeRunner } from './compose.js';
import { claudeSettingsPath } from './hook/settings-file.js';
import { DEFAULT_HOOKS_FLAGS, uninstallHooks, type HooksCommandOptions } from './hooks-cmd.js';
import { HOST_ACTIONS, type HostActions } from './host-actions.js';
import { readInstallManifest, type InstallManifest } from './install-manifest.js';
import { launchAgentPath, MCP_LAUNCH_LABEL } from './launchd.js';
import { askLine, confirmOrExit, stderrWriter, stdoutWriter, type Writer } from './output.js';
import { resolveRepoDir } from './paths.js';
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
 * It asks twice. The first question is the ordinary destructive confirm and `--yes` skips it. The
 * second asks for the data root to be typed back, and nothing skips it: `--yes` exists so a script
 * can re-run an install, and the step that deletes everything the substrate ever remembered is not
 * a step a script should be able to take by passing a flag it was passing anyway.
 *
 * It removes what this install put there and says what it left. A Neo4j somebody else runs, a
 * plugin jar they placed, Ollama and its models: those are printed with their commands and not
 * touched. `uninstall-plan.ts` carries the rule and decides all of it before anything is removed.
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
 * Cuts the lines this install wrote and leaves every other line alone, including one carrying a
 * key we own with a value somebody changed: an edited setting is a decision, and taking it out
 * because the key matches would undo it silently.
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
 * `uninstallHooks` also knows codex, the manual-merge path, and its own repo verification; none
 * of that applies here, because init only ever writes the claude harness. This is the narrower
 * shape it needs to do exactly that removal, reusing the same read, backup, and strip it always
 * has.
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

async function unloadLaunchdJob(
  plistPath: string,
  actions: HostActions,
  write: Writer,
): Promise<void> {
  const domain = `gui/${String(process.getuid?.() ?? 0)}`;
  const unloaded = await actions.run('launchctl', ['bootout', domain, plistPath]);
  write(
    unloaded.ok
      ? `  unloaded ${MCP_LAUNCH_LABEL}`
      : `  ${MCP_LAUNCH_LABEL} was not loaded (${unloaded.stderr.trim() || 'no job'})`,
  );
  rmSync(plistPath, { force: true });
}

export type UninstallExecution = {
  readonly removed: readonly string[];
  readonly failed: readonly string[];
};

/**
 * Removes what the plan marked `remove`, in the plan's order. Every step is guarded on its own:
 * a machine part-way through an install is the usual caller, and one thing that is not there must
 * not stop the next thing that is.
 */
export async function executeUninstall(
  items: readonly UninstallItem[],
  manifest: InstallManifest | undefined,
  actions: HostActions,
  compose: (args: readonly string[]) => Promise<string>,
  write: Writer,
  now: Date = new Date(),
): Promise<UninstallExecution> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const item of items.filter((entry) => entry.action === 'remove')) {
    try {
      if (item.what === 'launchd job') {
        await unloadLaunchdJob(item.target, actions, write);
      } else if (item.what === 'compose services and volumes') {
        await compose(['--profile', 'mcp', 'down', '--volumes']);
      } else if (item.what === 'neo4j.conf settings') {
        const cut = stripOwnedSettings(item.target, manifest?.neo4jSettings ?? []);
        write(`  cut ${String(cut)} lines from ${item.target}`);
      } else if (item.what === 'claude hooks') {
        // Explicit, so a settings file never falls through to the recursive rmSync below: that
        // would delete the file outright instead of stripping the entries this install owns.
        uninstallHooks(claudeHooksOptions(item.target, now), write);
      } else {
        rmSync(item.target, { recursive: true, force: true });
      }
      removed.push(`${item.what} (${item.target})`);
    } catch (err) {
      failed.push(
        `${item.what} (${item.target}): ${err instanceof Error ? err.message : 'failed'}`,
      );
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
      // The second question, and `--yes` does not answer it. The data root is the memory: every
      // episode, every claim, every narrative the substrate ever wrote.
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
      );
      writeSummary(execution, items, models, write);
      return execution.failed.length === 0 ? 0 : 1;
    },
  });
}
