import {
  postToolUse,
  preCompact,
  promptSubmit,
  sessionEnd,
  sessionStart,
  stop,
  subagentStop,
} from './events.js';
import { isRecord, mcpEndpoint, type FetchImpl } from './mcp.js';
import {
  DEFAULT_MIN_CHARS,
  HOOK_EVENTS,
  HOOK_TIMEOUT_MS,
  type HookContext,
  type HookEvent,
  type HookOptions,
  type StopMode,
} from './options.js';
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
};

export type HookFlags = {
  readonly event: HookEvent | undefined;
  readonly stopMode: StopMode;
  readonly minChars: number;
};

export function parseHookFlags(argv: readonly string[]): HookFlags {
  const [name, ...rest] = argv;
  const event = (HOOK_EVENTS as readonly string[]).includes(name ?? '')
    ? (name as HookEvent)
    : undefined;

  let stopMode: StopMode = 'push';
  let minChars = DEFAULT_MIN_CHARS;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
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
  return { event, stopMode, minChars };
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

/** The one place an exit code other than 0 can survive: everything else collapses to fail-open. */
export async function runHook(
  input: Record<string, unknown>,
  options: HookOptions,
): Promise<number> {
  try {
    return await HANDLERS[options.event]({ input, options });
  } catch (err) {
    options.stderr(
      `aion hook ${options.event}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

export type HookMainDeps = {
  readonly env?: Record<string, string | undefined>;
  readonly readInput?: () => Promise<string>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly stateDir?: string;
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
      stopMode: flags.stopMode,
      minChars: flags.minChars,
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
