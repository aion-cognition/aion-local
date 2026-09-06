import { describeError, envFileValue } from '@aion/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CliUsageError, wantsHelp } from './args.js';
import { buildCodexAionHooks, mergeCodexAionHooks } from './hook/codex-settings.js';
import { mcpEndpoint } from './hook/mcp.js';
import type { Harness, StopMode } from './hook/options.js';
import {
  backupSettings,
  claudeSettingsPath,
  codexHooksPath,
  readSettings,
  writeSettings,
} from './hook/settings-file.js';
import {
  buildAionHooks,
  describeAionHooks,
  mergeAionHooks,
  removeAionHooks,
  type HookProfile,
  type SettingsHooks,
} from './hook/settings.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { envFilePath, hookScriptPath, resolveHostRepo, type HostRepo } from './paths.js';

/**
 * `aion hooks install | uninstall | status`. The merge lives in `hook/settings.ts` and
 * `hook/codex-settings.ts`, the hooks file itself in `hook/settings-file.ts`; this owns the
 * invocation, the codex server block, and what the user is told.
 */

/** Codex keeps it beside hooks.json, and reads far more than the server list out of it. */
const CODEX_CONFIG_FILE = 'config.toml';

/** The header codex reads the aion server off, and the line an install looks for. */
const CODEX_MCP_HEADER = '[mcp_servers.aion]';

/** Printed verbatim after a codex install, because nothing fires until the user trusts it. */
const CODEX_TRUST_WALKTHROUGH = [
  'codex trusts a hook only after you review it. Run codex, then /hooks, and trust the aion entries.',
  'A reinstall with different flags changes those entries and codex will ask again. Hooks are enabled',
  'by default (features.hooks); if /hooks shows them disabled, enable the feature first.',
];

function unknownHooksOption(option: string): CliUsageError {
  return new CliUsageError(
    `unknown option '${option}' for hooks (supported: --harness claude|codex, ` +
      '--profile full|lite, --with-research-capture, --no-research-capture, ' +
      '--stop-mode push|instruct)',
  );
}

export type HooksFlags = {
  readonly profile: HookProfile;
  readonly withResearchCapture: boolean;
  readonly stopMode: StopMode;
  readonly harness: Harness;
};

export const DEFAULT_HOOKS_FLAGS: HooksFlags = {
  profile: 'full',
  withResearchCapture: true,
  stopMode: 'push',
  harness: 'claude',
};

export function parseHooksFlags(argv: readonly string[]): HooksFlags {
  let { profile, withResearchCapture, stopMode, harness } = DEFAULT_HOOKS_FLAGS;

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
    if (arg === '--harness' && (value === 'claude' || value === 'codex')) {
      harness = value;
      index += 1;
      continue;
    }
    throw unknownHooksOption(arg ?? '');
  }
  return { profile, withResearchCapture, stopMode, harness };
}

export type HooksCommandOptions = {
  readonly flags: HooksFlags;
  readonly settingsPath: string;
  readonly codexHooksPath: string;
  readonly codexConfigPath: string;
  readonly repo: HostRepo;
  readonly now: Date;
  readonly env: NodeJS.ProcessEnv;
};

export function defaultHooksOptions(flags: HooksFlags): HooksCommandOptions {
  const codexHooks = codexHooksPath(homedir(), process.env);
  return {
    flags,
    settingsPath: claudeSettingsPath(homedir()),
    codexHooksPath: codexHooks,
    codexConfigPath: join(dirname(codexHooks), CODEX_CONFIG_FILE),
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

function backupAndReport(path: string, now: Date, write: Writer): void {
  const target = backupSettings(path, now);
  if (target !== undefined) {
    write(`  backup ${target}`);
  }
}

/** One install writes one file: each harness keeps its hooks in its own. */
function hooksFilePath(options: HooksCommandOptions): string {
  return options.flags.harness === 'codex' ? options.codexHooksPath : options.settingsPath;
}

function specFor(options: HooksCommandOptions): SettingsHooks {
  const spec = {
    profile: options.flags.profile,
    withResearchCapture: options.flags.withResearchCapture,
    stopMode: options.flags.stopMode,
    scriptPath: hookScriptPath(options.repo.path),
  };
  return options.flags.harness === 'codex' ? buildCodexAionHooks(spec) : buildAionHooks(spec);
}

function mergedFor(
  options: HooksCommandOptions,
  current: unknown,
  aion: SettingsHooks,
): Record<string, unknown> {
  if (options.flags.harness === 'codex') {
    return mergeCodexAionHooks(current, aion);
  }
  return mergeAionHooks(current, aion);
}

function codexMcpBlock(env: NodeJS.ProcessEnv): string {
  return `${CODEX_MCP_HEADER}\nurl = "${mcpEndpoint(env)}"\n`;
}

/** An exact line, so a server named aion-old and a header inside a comment both read as absent. */
function hasCodexMcpServer(config: string): boolean {
  return config.split('\n').some((line) => line.trim() === CODEX_MCP_HEADER);
}

function readCodexConfig(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return readFileSync(path, 'utf8');
}

/**
 * Append-only. Codex reads its model, its approvals, and every other server out of this file,
 * so an install that cannot find our header adds one block at the end and rewrites nothing
 * above it.
 */
function ensureCodexMcpServer(options: HooksCommandOptions, write: Writer): void {
  const path = options.codexConfigPath;
  const current = readCodexConfig(path);
  if (current === undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, codexMcpBlock(options.env), 'utf8');
    write(`  ${CODEX_MCP_HEADER} written to ${path}`);
    return;
  }
  if (hasCodexMcpServer(current)) {
    write(`  ${CODEX_MCP_HEADER} already in ${path}, left alone`);
    return;
  }
  backupAndReport(path, options.now, write);
  writeFileSync(path, `${current}\n${codexMcpBlock(options.env)}`, 'utf8');
  write(`  ${CODEX_MCP_HEADER} appended to ${path}`);
}

function codexMcpStatus(path: string): string {
  const config = readCodexConfig(path);
  if (config !== undefined && hasCodexMcpServer(config)) {
    return `config: ${CODEX_MCP_HEADER} present in ${path}`;
  }
  return `config: ${CODEX_MCP_HEADER} missing from ${path}`;
}

function renderRows(settings: unknown, write: Writer): void {
  for (const row of describeAionHooks(settings)) {
    const matcher = row.matcher === undefined ? '' : ` [${row.matcher}]`;
    const mode = row.async ? ' (async)' : '';
    write(`  ${row.event}${matcher}${mode}: ${row.command}`);
  }
}

/**
 * The container can reach neither the host repo nor the host's harness settings, so the blocks
 * are printed for the user to merge by hand instead of the command failing.
 */
function renderManualInstall(
  options: HooksCommandOptions,
  hooks: SettingsHooks,
  write: Writer,
): void {
  const codex = options.flags.harness === 'codex';
  const target = codex ? '~/.codex/hooks.json' : '~/.claude/settings.json';
  write('aion hooks: this process cannot see the host repo, so nothing was written.');
  write(`Merge this into ${target} on the host, under its "hooks" key:`);
  write('');
  write(JSON.stringify({ hooks }, null, 2));
  if (!codex) {
    return;
  }
  write('');
  write('Add this to ~/.codex/config.toml on the host, so the tools stay reachable:');
  write('');
  write(codexMcpBlock(options.env).trimEnd());
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
    renderManualInstall(options, hooks, write);
    return 0;
  }

  const script = hookScriptPath(options.repo.path);
  if (!existsSync(script)) {
    stderrWriter(`aion hooks: ${script} is missing; run \`npm run build\` in the repo first`);
    return 1;
  }

  const path = hooksFilePath(options);
  const merged = mergedFor(options, readSettings(path), hooks);
  backupAndReport(path, options.now, write);
  writeSettings(path, merged);
  write(`aion hooks installed (${options.flags.profile}) in ${path}`);
  renderRows(merged, write);
  if (options.flags.harness === 'codex') {
    ensureCodexMcpServer(options, write);
    for (const line of CODEX_TRUST_WALKTHROUGH) {
      write(line);
    }
  }
  return 0;
}

export function uninstallHooks(options: HooksCommandOptions, write: Writer): number {
  const path = hooksFilePath(options);
  if (!existsSync(path)) {
    write(`aion hooks: nothing to remove, ${path} does not exist`);
    return 0;
  }
  const current = readSettings(path);
  const removed = describeAionHooks(current).length;
  if (removed === 0) {
    write(`aion hooks: no aion entries in ${path}`);
    return 0;
  }
  backupAndReport(path, options.now, write);
  writeSettings(path, removeAionHooks(current));
  write(`aion hooks: removed ${removed} entries from ${path}`);
  if (options.flags.harness === 'codex') {
    // The server block costs nothing without hooks, and a model that calls recall or
    // reflection on its own still needs it.
    write(`  ${CODEX_MCP_HEADER} left in ${options.codexConfigPath}, still callable as tools`);
  }
  return 0;
}

export function statusHooks(options: HooksCommandOptions, write: Writer): number {
  const path = hooksFilePath(options);
  const settings = readSettings(path);
  write(`settings: ${path}`);
  if (describeAionHooks(settings).length === 0) {
    write('  no aion entries');
  } else {
    renderRows(settings, write);
  }
  if (options.flags.harness === 'codex') {
    write(codexMcpStatus(options.codexConfigPath));
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
    '  --harness claude|codex       which harness to write (default claude). codex keeps its',
    '                               hooks in $CODEX_HOME/hooks.json, takes the aion mcp server',
    '                               in config.toml beside it, and runs nothing until the entries',
    '                               are trusted in /hooks',
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
