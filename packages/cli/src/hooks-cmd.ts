import { describeError, envFileValue } from '@aion/core';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { CliUsageError, wantsHelp } from './args.js';
import type { StopMode } from './hook/options.js';
import {
  buildAionHooks,
  describeAionHooks,
  mergeAionHooks,
  removeAionHooks,
  type HookProfile,
  type SettingsHooks,
} from './hooks-settings.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import {
  claudeSettingsPath,
  envFilePath,
  hookScriptPath,
  resolveHostRepo,
  type HostRepo,
} from './paths.js';

/**
 * `aion hooks install | uninstall | status`. The merge itself lives in `hooks-settings.ts`;
 * this owns the file, the backup, and what the user is told.
 */

function unknownHooksOption(option: string): CliUsageError {
  return new CliUsageError(
    `unknown option '${option}' for hooks (supported: --profile full|lite, ` +
      '--with-research-capture, --no-research-capture, --stop-mode push|instruct)',
  );
}

export class SettingsUnreadableError extends Error {
  constructor(path: string, reason: string, options?: { cause?: unknown }) {
    super(`${path} ${reason}; fix or move it before installing hooks`, options);
    this.name = 'SettingsUnreadableError';
  }
}

export type HooksFlags = {
  readonly profile: HookProfile;
  readonly withResearchCapture: boolean;
  readonly stopMode: StopMode;
};

export const DEFAULT_HOOKS_FLAGS: HooksFlags = {
  profile: 'full',
  withResearchCapture: true,
  stopMode: 'push',
};

export function parseHooksFlags(argv: readonly string[]): HooksFlags {
  let { profile, withResearchCapture, stopMode } = DEFAULT_HOOKS_FLAGS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--with-research-capture') {
      withResearchCapture = true;
      continue;
    }
    if (arg === '--no-research-capture') {
      withResearchCapture = false;
      continue;
    }
    if (arg === '--profile' && (value === 'full' || value === 'lite')) {
      profile = value;
      index += 1;
      continue;
    }
    if (arg === '--stop-mode' && (value === 'push' || value === 'instruct')) {
      stopMode = value;
      index += 1;
      continue;
    }
    throw unknownHooksOption(arg ?? '');
  }
  return { profile, withResearchCapture, stopMode };
}

export type HooksCommandOptions = {
  readonly flags: HooksFlags;
  readonly settingsPath: string;
  readonly repo: HostRepo;
  readonly now: Date;
  readonly env: NodeJS.ProcessEnv;
};

export function defaultHooksOptions(flags: HooksFlags): HooksCommandOptions {
  return {
    flags,
    settingsPath: claudeSettingsPath(homedir()),
    repo: resolveHostRepo(),
    now: new Date(),
    env: process.env,
  };
}

// init.ts owns the same name but imports this module, so naming it there and reading it here
// would close an import cycle over a string.
const ANTHROPIC_KEY_ENV_VAR = 'AION_ANTHROPIC_API_KEY';

/**
 * Both invocation paths reach the key through one of these two reads. Inside the CLI container
 * compose's `env_file` has already put it in the environment; a host invocation reads the same
 * file from the repo the hook script would be installed from.
 */
function anthropicKeyPresent(options: HooksCommandOptions): boolean {
  if ((options.env[ANTHROPIC_KEY_ENV_VAR] ?? '').trim() !== '') {
    return true;
  }
  const recorded = envFileValue(envFilePath(options.repo.path), ANTHROPIC_KEY_ENV_VAR);
  return (recorded ?? '').trim() !== '';
}

function keylessRefusal(repoPath: string): string {
  return (
    'aion hooks install: no Anthropic key is set. Hooks capture raw transcript windows and ' +
    `need the keyed profile to digest them. Set ${ANTHROPIC_KEY_ENV_VAR} in ` +
    `${envFilePath(repoPath)} or run aion init full, then re-run.`
  );
}

/** Compact UTC, so a directory listing sorts the backups in the order they were taken. */
export function backupPath(settingsPath: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${settingsPath}.aion-${stamp}`;
}

function readSettings(path: string): unknown {
  if (!existsSync(path)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SettingsUnreadableError(path, 'could not be read', { cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SettingsUnreadableError(path, 'is not valid JSON', { cause: err });
  }
}

/** Nothing is written until the current file is copied aside, so a bad merge is always one `mv` from undone. */
function backupSettings(path: string, now: Date, write: Writer): void {
  if (!existsSync(path)) {
    return;
  }
  const target = backupPath(path, now);
  // Two commands inside the same second would name the same copy. The first one holds the
  // older state, which is the one worth keeping, so it is never overwritten.
  if (existsSync(target)) {
    return;
  }
  copyFileSync(path, target);
  write(`  backup ${target}`);
}

function writeSettings(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function specFor(options: HooksCommandOptions): SettingsHooks {
  return buildAionHooks({
    profile: options.flags.profile,
    withResearchCapture: options.flags.withResearchCapture,
    stopMode: options.flags.stopMode,
    scriptPath: hookScriptPath(options.repo.path),
  });
}

function renderRows(settings: unknown, write: Writer): void {
  for (const row of describeAionHooks(settings)) {
    const matcher = row.matcher === undefined ? '' : ` [${row.matcher}]`;
    const mode = row.async ? ' (async)' : '';
    write(`  ${row.event}${matcher}${mode}: ${row.command}`);
  }
}

/**
 * The container can reach neither the host repo nor the host's Claude settings, so the block
 * is printed for the user to merge by hand instead of the command failing.
 */
function renderManualInstall(hooks: SettingsHooks, write: Writer): void {
  write('aion hooks: this process cannot see the host repo, so nothing was written.');
  write('Merge this into ~/.claude/settings.json on the host, under its "hooks" key:');
  write('');
  write(JSON.stringify({ hooks }, null, 2));
}

export function installHooks(options: HooksCommandOptions, write: Writer): number {
  // Every hook profile is keyed-only, so the refusal comes before the spec is built and before
  // the manual block is printed: a keyless run leaves with nothing to write and nothing to paste.
  if (!anthropicKeyPresent(options)) {
    stderrWriter(keylessRefusal(options.repo.path));
    return 1;
  }

  const hooks = specFor(options);
  if (!options.repo.verified) {
    renderManualInstall(hooks, write);
    return 0;
  }

  const script = hookScriptPath(options.repo.path);
  if (!existsSync(script)) {
    stderrWriter(`aion hooks: ${script} is missing; run \`npm run build\` in the repo first`);
    return 1;
  }

  const merged = mergeAionHooks(readSettings(options.settingsPath), hooks);
  backupSettings(options.settingsPath, options.now, write);
  writeSettings(options.settingsPath, merged);
  write(`aion hooks installed (${options.flags.profile}) in ${options.settingsPath}`);
  renderRows(merged, write);
  return 0;
}

export function uninstallHooks(options: HooksCommandOptions, write: Writer): number {
  if (!existsSync(options.settingsPath)) {
    write(`aion hooks: nothing to remove, ${options.settingsPath} does not exist`);
    return 0;
  }
  const current = readSettings(options.settingsPath);
  const removed = describeAionHooks(current).length;
  if (removed === 0) {
    write(`aion hooks: no aion entries in ${options.settingsPath}`);
    return 0;
  }
  backupSettings(options.settingsPath, options.now, write);
  writeSettings(options.settingsPath, removeAionHooks(current));
  write(`aion hooks: removed ${removed} entries from ${options.settingsPath}`);
  return 0;
}

export function statusHooks(options: HooksCommandOptions, write: Writer): number {
  const settings = readSettings(options.settingsPath);
  write(`settings: ${options.settingsPath}`);
  if (describeAionHooks(settings).length === 0) {
    write('  no aion entries');
  } else {
    renderRows(settings, write);
  }

  const script = hookScriptPath(options.repo.path);
  if (!options.repo.verified) {
    // Both paths above belong to this process. Inside the container neither is the host's.
    write(`build: ${script} not checkable from here (host path)`);
    return 0;
  }
  write(`build: ${script} ${existsSync(script) ? 'present' : 'missing, run npm run build'}`);
  return 0;
}

/** `aion init full` installs the same way `aion hooks install` does, with the full profile. */
export function installFullProfile(write: Writer): number {
  return installHooks(defaultHooksOptions({ ...DEFAULT_HOOKS_FLAGS, profile: 'full' }), write);
}

function usage(): string {
  return [
    'usage: aion hooks <install | uninstall | status> [options]',
    '',
    '  --profile full|lite          full: recall on session start and every prompt, capture on',
    '                               compact, stop, subagent stop, and session end. lite: session',
    '                               start and session end only. both stamp the session id onto a',
    '                               direct recall or reflection call',
    '  --stop-mode push|instruct    push stores the turn directly; instruct asks the model to',
    '                               store it and blocks the stop until it does',
    '  --with-research-capture      capture Slack, Linear, and Notion tool results (default)',
    '  --no-research-capture        skip that capture',
    '',
  ].join('\n');
}

function dispatch(argv: readonly string[], write: Writer): number {
  const [action = '', ...rest] = argv;
  if (action === '' || action === 'help' || wantsHelp(argv)) {
    write(usage());
    return 0;
  }
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
    stderrWriter(`aion hooks: unknown action '${action}'\n\n${usage()}`);
    return 1;
  }

  const options = defaultHooksOptions(parseHooksFlags(rest));
  if (action === 'install') {
    return installHooks(options, write);
  }
  if (action === 'uninstall') {
    return uninstallHooks(options, write);
  }
  return statusHooks(options, write);
}

export function runHooks(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  try {
    return Promise.resolve(dispatch(argv, write));
  } catch (err) {
    if (err instanceof CliUsageError) {
      stderrWriter(`${err.message}\n\n${usage()}`);
      return Promise.resolve(1);
    }
    stderrWriter(describeError(err));
    return Promise.resolve(1);
  }
}
