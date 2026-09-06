import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  postToolUse,
  preCompact,
  preToolUse,
  promptSubmit,
  sessionEnd,
  sessionStart,
  stop,
  subagentStop,
} from './events.js';
import { anthropicKeyState } from './key-state.js';
import { isRecord, mcpEndpoint, type FetchImpl } from './mcp.js';
import {
  DEFAULT_MIN_CHARS,
  HOOK_EVENTS,
  HOOK_TIMEOUT_MS,
  KEYLESS_NOTICE,
  type Harness,
  type HookContext,
  type HookEvent,
  type HookOptions,
  type StopMode,
} from './options.js';
import { additionalContext } from './payload.js';
import {
  backupSettings,
  claudeSettingsPath,
  codexHooksPath,
  readSettings,
  writeSettings,
} from './settings-file.js';
import { describeAionHooks, removeAionHooks } from './settings.js';
import { defaultStateDir } from './state.js';

/**
 * Entry for the hook subtree. Every file under `hook/` imports node builtins and its own
 * siblings, nothing else: this code runs on the host's bare node from whatever cwd the Claude
 * session happens to be in, with no install step, no bundler, and no container. A third-party
 * import here breaks every hook fire on a machine that never ran `npm install`.
 * `imports.test.ts` fails the build on one.
 *
 * The second rule is fail-open. A hook that throws, times out, or meets a service that is not
 * running exits 0 with nothing on stdout, because blocking a turn over memory is worse than
 * losing the memory. Stop's instruct mode is the one deliberate exception.
 */

const HANDLERS: Record<HookEvent, (context: HookContext) => Promise<number>> = {
  'session-start': sessionStart,
  'prompt-submit': promptSubmit,
  'pre-compact': preCompact,
  stop,
  'subagent-stop': subagentStop,
  'session-end': sessionEnd,
  'post-tool-use': postToolUse,
  'pre-tool-use': preToolUse,
};

export type HookFlags = {
  readonly event: HookEvent | undefined;
  readonly harness: Harness;
  readonly stopMode: StopMode;
  readonly minChars: number;
};

export function parseHookFlags(argv: readonly string[]): HookFlags {
  const [name, ...rest] = argv;
  const event = (HOOK_EVENTS as readonly string[]).includes(name ?? '')
    ? (name as HookEvent)
    : undefined;

  let harness: Harness = 'claude';
  let stopMode: StopMode = 'push';
  let minChars = DEFAULT_MIN_CHARS;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    // A name this does not know leaves the default standing, the way an unusable value does
    // everywhere else here: argv is not worth failing a fire over.
    if (flag === '--harness' && (value === 'claude' || value === 'codex')) {
      harness = value;
      index += 1;
      continue;
    }
    if (flag === '--mode' && (value === 'push' || value === 'instruct')) {
      stopMode = value;
      index += 1;
      continue;
    }
    if (flag === '--min-chars' && value !== undefined) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed >= 0) {
        minChars = parsed;
      }
      index += 1;
    }
  }
  return { event, harness, stopMode, minChars };
}

export function parseHookInput(raw: string): Record<string, unknown> {
  if (raw.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * One JSON line per fire into `<stateDir>/hooks.log`. Hooks run where nobody watches, so
 * this is the only durable record of whether they fired and what they did; the pino file
 * lives on the container volume and the hook client must not depend on it. The write is
 * fail-open like everything else here, and the log rotates once at 5MB so it stays small.
 */
function trace(stateDir: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, 'hooks.log');
    try {
      if (statSync(file).size > 5 * 1024 * 1024) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      // a missing file is the normal first-run case
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // the trace must never break a fire
  }
}

/**
 * The same strip `aion hooks uninstall` performs, from the machine the hooks are installed on.
 * Idempotent: a second fire finds nothing of ours left, writes nothing, and returns 0, so
 * concurrent fires converge on one stripped file rather than racing to rewrite it.
 */
function stripInstalledHooks(options: HookOptions): number {
  try {
    const current = readSettings(options.settingsPath);
    const removed = describeAionHooks(current).length;
    if (removed === 0) {
      return 0;
    }
    backupSettings(options.settingsPath, options.now());
    writeSettings(options.settingsPath, removeAionHooks(current));
    return removed;
  } catch {
    // A settings file this cannot read is not one to rewrite. Capture stops either way.
    return 0;
  }
}

/**
 * Hooks capture raw transcript windows, which only the keyed profile digests, so a machine with
 * no key stops capturing and takes its own hooks out of the settings file. Hooks a live session
 * already registered keep firing until it ends; each fire lands here and does nothing.
 */
function runKeyless(options: HookOptions): number {
  const removed = stripInstalledHooks(options);
  if (options.event === 'session-start') {
    options.stdout(additionalContext('SessionStart', KEYLESS_NOTICE));
  }
  return removed;
}

/** The one place an exit code other than 0 can survive: everything else collapses to fail-open. */
export async function runHook(
  input: Record<string, unknown>,
  options: HookOptions,
): Promise<number> {
  const started = options.now().getTime();
  const base = {
    ts: options.now().toISOString(),
    event: options.event,
    session: typeof input.session_id === 'string' ? input.session_id : undefined,
  };
  // Ahead of the dispatch, so no handler reaches the service and stop's instruct mode cannot
  // block a turn over memory this profile will never store.
  if (options.keyState === 'absent') {
    const removed = runKeyless(options);
    trace(options.stateDir, {
      ...base,
      exit: 0,
      keyless: true,
      removed,
      ms: options.now().getTime() - started,
    });
    return 0;
  }
  try {
    const exit = await HANDLERS[options.event]({ input, options });
    trace(options.stateDir, { ...base, exit, ms: options.now().getTime() - started });
    return exit;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.stderr(`aion hook ${options.event}: ${message}`);
    trace(options.stateDir, {
      ...base,
      exit: 0,
      error: message,
      ms: options.now().getTime() - started,
    });
    return 0;
  }
}

export type HookMainDeps = {
  readonly env?: Record<string, string | undefined>;
  readonly readInput?: () => Promise<string>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly stateDir?: string;
  readonly settingsPath?: string;
  /** How the repo is found: the harness invokes `<repo>/packages/cli/dist/hook-main.js`. */
  readonly scriptPath?: string;
  readonly fetchImpl?: FetchImpl;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The file the keyless strip rewrites, which is the one the harness that fired reads its hooks from. */
function hooksFilePath(harness: Harness, env: NodeJS.ProcessEnv): string {
  if (harness === 'codex') {
    return codexHooksPath(homedir(), env);
  }
  return claudeSettingsPath(homedir());
}

export async function main(argv: readonly string[], deps: HookMainDeps = {}): Promise<number> {
  const stderr =
    deps.stderr ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  try {
    const flags = parseHookFlags(argv);
    if (flags.event === undefined) {
      stderr(`aion hook: unknown event '${argv[0] ?? ''}'`);
      return 0;
    }
    const env = deps.env ?? process.env;
    const input = parseHookInput(await (deps.readInput ?? readStdin)());
    return await runHook(input, {
      event: flags.event,
      harness: flags.harness,
      stopMode: flags.stopMode,
      minChars: flags.minChars,
      keyState: anthropicKeyState(env, deps.scriptPath ?? process.argv[1]),
      settingsPath: deps.settingsPath ?? hooksFilePath(flags.harness, env),
      stateDir: deps.stateDir ?? defaultStateDir(),
      endpoint: mcpEndpoint(env),
      fetchImpl: deps.fetchImpl ?? fetch,
      timeoutMs: deps.timeoutMs ?? HOOK_TIMEOUT_MS,
      now: deps.now ?? ((): Date => new Date()),
      stdout:
        deps.stdout ??
        ((line: string): void => {
          process.stdout.write(`${line}\n`);
        }),
      stderr,
    });
  } catch (err) {
    stderr(`aion hook: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
