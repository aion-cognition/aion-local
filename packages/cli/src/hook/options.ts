import type { KeyState } from './key-state.js';
import type { FetchImpl } from './mcp.js';

export const HOOK_EVENTS = [
  'session-start',
  'prompt-submit',
  'pre-compact',
  'stop',
  'subagent-stop',
  'session-end',
  'post-tool-use',
  'pre-tool-use',
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

/** The one thing a keyless fire says, and only at session start, where a session reads it once. */
export const KEYLESS_NOTICE =
  'aion: hooks were removed because no Anthropic key is set. The local profile is MCP-only. ' +
  'Set AION_ANTHROPIC_API_KEY and run aion hooks install to restore capture.';

export type HookOptions = {
  readonly event: HookEvent;
  readonly stopMode: StopMode;
  readonly minChars: number;
  /** Decided once per process, so eight handlers cannot disagree about it mid-session. */
  readonly keyState: KeyState;
  /** The file the client removes itself from when the key is gone. */
  readonly settingsPath: string;
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
