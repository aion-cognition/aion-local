import type { FetchImpl } from './mcp.js';

export const HOOK_EVENTS = [
  'session-start',
  'prompt-submit',
  'pre-compact',
  'stop',
  'subagent-stop',
  'session-end',
  'post-tool-use',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type StopMode = 'push' | 'instruct';

/** Hard ceiling on everything one fire does. A hook that outlives it has already cost the turn more than the memory is worth. */
export const HOOK_TIMEOUT_MS = 10_000;

/** Below this a prompt is an acknowledgement or a one-word steer, and recalling against it returns noise. */
export const DEFAULT_MIN_CHARS = 40;

export const STOP_INSTRUCTION =
  'Call the aion reflection tool now with what this turn established: the decisions, ' +
  'the reasons behind them, and anything learned. Summarize the substance, not the steps.';

export type HookOptions = {
  readonly event: HookEvent;
  readonly stopMode: StopMode;
  readonly minChars: number;
  readonly stateDir: string;
  readonly endpoint: string;
  readonly fetchImpl: FetchImpl;
  readonly timeoutMs: number;
  readonly now: () => Date;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

export type HookContext = {
  readonly input: Record<string, unknown>;
  readonly options: HookOptions;
};
