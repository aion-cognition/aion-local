import { readRolloutTail } from './codex-rollout.js';
import { McpHookClient, type McpCallResult } from './mcp.js';
import { STOP_INSTRUCTION, type HookContext } from './options.js';
import {
  additionalContext,
  allowedUpdatedToolInput,
  booleanField,
  bufferedToolFrom,
  packHasContent,
  packText,
  recallArgs,
  reflectionArgs,
  reflectionObservationArgs,
  reflectionTurns,
  stampedToolInput,
  stringField,
  toolExecutions,
  updatedToolInput,
} from './payload.js';
import { dropHookState, readHookState, writeHookState, type HookState } from './state.js';
import {
  hasAssistantText,
  mentionsReflectionCall,
  readTranscriptTail,
  type TranscriptTail,
} from './transcript.js';

/**
 * The eight events, one MCP round trip at most each. Every handler returns an exit code, and
 * only Stop's instruct mode ever returns anything but 0.
 */

const RECALL_TOOL = 'recall';
const REFLECTION_TOOL = 'reflection';

const GROUNDING_QUERY =
  'active projects, recent decisions, open corrections, and current state of work';

const SESSION_START_BUDGET = 2000;
const PROMPT_BUDGET = 1200;

const SESSION_START_HEADER = 'Aion memory, recalled for this session:';
const PROMPT_HEADER = 'Aion memory, recalled for this prompt:';

async function withMcp<T>(
  context: HookContext,
  call: (client: McpHookClient) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, context.options.timeoutMs);
  timer.unref();
  const client = new McpHookClient({
    endpoint: context.options.endpoint,
    fetchImpl: context.options.fetchImpl,
    signal: controller.signal,
  });
  try {
    await client.open();
    return await call(client);
  } finally {
    await client.close();
    clearTimeout(timer);
  }
}

function emitRecall(
  context: HookContext,
  event: string,
  header: string,
  result: McpCallResult,
): void {
  if (!packHasContent(result.structured)) {
    return;
  }
  const text = packText(result.structured, result.text);
  if (text === undefined || text.trim() === '') {
    return;
  }
  context.options.stdout(additionalContext(event, `${header}\n\n${text}`));
}

async function recallInto(
  context: HookContext,
  event: string,
  header: string,
  query: string,
  budget: number,
): Promise<number> {
  const sessionId = stringField(context.input, 'session_id');
  const result = await withMcp(context, (client) =>
    client.call(RECALL_TOOL, recallArgs(query, budget, sessionId)),
  );
  emitRecall(context, event, header, result);
  return 0;
}

export function sessionStart(context: HookContext): Promise<number> {
  return recallInto(
    context,
    'SessionStart',
    SESSION_START_HEADER,
    GROUNDING_QUERY,
    SESSION_START_BUDGET,
  );
}

export function promptSubmit(context: HookContext): Promise<number> {
  const prompt = stringField(context.input, 'prompt');
  if (prompt === undefined || prompt.trim().length < context.options.minChars) {
    return Promise.resolve(0);
  }
  return recallInto(context, 'UserPromptSubmit', PROMPT_HEADER, prompt, PROMPT_BUDGET);
}

type Capture = {
  readonly sessionId: string | undefined;
  readonly offset: number;
  readonly raw: string;
  readonly fingerprint: string | undefined;
  readonly turns: ReturnType<typeof reflectionTurns>;
  readonly executions: ReturnType<typeof toolExecutions>;
  readonly assistantSpoke: boolean;
};

/** What either parser hands back. Only a rollout read keys its offset to the file it read. */
type CapturedTail = TranscriptTail & { readonly fingerprint: string | undefined };

/**
 * The two harnesses record a turn in two line shapes, so the parser is the only thing the
 * harness chooses here. A codex read also names the file it read, and that name rides on the
 * capture so the flush that follows stores it beside the offset. A read that names no file
 * keeps the name already stored: the offset outlives an unreadable file, and an offset whose
 * key was dropped is trusted blindly by the next read.
 */
function readTail(context: HookContext, path: string | undefined, state: HookState): CapturedTail {
  if (path === undefined) {
    return { messages: [], offset: state.offset ?? 0, raw: '', fingerprint: state.fingerprint };
  }
  if (context.options.harness === 'codex') {
    const tail = readRolloutTail(path, state.offset, state.fingerprint);
    return { ...tail, fingerprint: tail.fingerprint ?? state.fingerprint };
  }
  return { ...readTranscriptTail(path, state.offset), fingerprint: undefined };
}

function capture(context: HookContext): Capture {
  const sessionId = stringField(context.input, 'session_id');
  const state = readHookState(context.options.stateDir, sessionId ?? '');
  const tail = readTail(context, stringField(context.input, 'transcript_path'), state);
  return {
    sessionId,
    offset: tail.offset,
    raw: tail.raw,
    fingerprint: tail.fingerprint,
    turns: reflectionTurns(tail.messages),
    executions: toolExecutions(state.tools),
    assistantSpoke: hasAssistantText(tail.messages),
  };
}

/** The cursor and the tool buffer move together: both describe the same flushed window. */
function advance(context: HookContext, taken: Capture): void {
  writeHookState(context.options.stateDir, taken.sessionId ?? '', {
    offset: taken.offset,
    lastFlushAt: context.options.now().toISOString(),
    fingerprint: taken.fingerprint,
    tools: [],
  });
}

async function push(context: HookContext, taken: Capture): Promise<boolean> {
  if (taken.turns.length === 0 && taken.executions.length === 0) {
    return false;
  }
  const origin = { channel: 'hook' as const, event: context.options.event };
  await withMcp(context, (client) =>
    client.call(
      REFLECTION_TOOL,
      reflectionArgs(taken.turns, taken.executions, taken.sessionId, origin),
    ),
  );
  advance(context, taken);
  return true;
}

/** Compaction discards the window this reads, so pushing it first is what makes the memory outlive the context. */
export async function preCompact(context: HookContext): Promise<number> {
  await push(context, capture(context));
  return 0;
}

async function pushTurn(context: HookContext): Promise<number> {
  const taken = capture(context);
  if (!taken.assistantSpoke) {
    return 0;
  }
  await push(context, taken);
  return 0;
}

function instruct(context: HookContext): number {
  const taken = capture(context);
  if (!taken.assistantSpoke || mentionsReflectionCall(taken.raw)) {
    advance(context, taken);
    return 0;
  }
  // A block that is already being processed must never produce a second one: the pair would
  // never settle and the turn would never end.
  if (booleanField(context.input, 'stop_hook_active')) {
    return 0;
  }
  context.options.stderr(STOP_INSTRUCTION);
  return 2;
}

export function stop(context: HookContext): Promise<number> {
  if (context.options.stopMode === 'push') {
    return pushTurn(context);
  }
  return Promise.resolve(instruct(context));
}

/**
 * A subagent writes its own transcript file, which the session cursor cannot tail: the stored
 * offset tracks the parent transcript, so the tail read comes back empty and the turn path
 * no-ops. The payload's `last_assistant_message` carries the synthesis directly, and it goes
 * up as one observation, tagged with the agent type, with the parent cursor left alone. A
 * payload without the field (a harness older than 2.1.196) falls back to the turn path.
 */
export async function subagentStop(context: HookContext): Promise<number> {
  const synthesis = stringField(context.input, 'last_assistant_message');
  if (synthesis === undefined) {
    return pushTurn(context);
  }
  const agentType = stringField(context.input, 'agent_type');
  const noted = agentType === undefined ? synthesis : `[${agentType}] ${synthesis}`;
  const origin = { channel: 'hook' as const, event: context.options.event };
  await withMcp(context, (client) =>
    client.call(
      REFLECTION_TOOL,
      reflectionObservationArgs(noted, stringField(context.input, 'session_id'), origin),
    ),
  );
  return 0;
}

export async function sessionEnd(context: HookContext): Promise<number> {
  // Codex gives this event a few seconds at most and reads nothing it writes, which is not room
  // for a round trip. Stop already flushed the turn, so the codex path only lets the cursor go.
  if (context.options.harness === 'codex') {
    dropHookState(context.options.stateDir, stringField(context.input, 'session_id') ?? '');
    return 0;
  }
  const taken = capture(context);
  await push(context, taken);
  dropHookState(context.options.stateDir, taken.sessionId ?? '');
  return 0;
}

/**
 * The one hook that runs before its tool rather than after it, and the only one that rewrites a
 * call. It fires on the model's own aion tool calls and stamps the Claude session id into the
 * arguments, so a session writes to one Session node however the tool was reached. Stdin to
 * stdout, no round trip: this sits on the critical path of every recall and reflection the model
 * makes.
 */
export function preToolUse(context: HookContext): Promise<number> {
  const sessionId = stringField(context.input, 'session_id');
  const tool = stringField(context.input, 'tool_name');
  if (sessionId === undefined || tool === undefined) {
    return Promise.resolve(0);
  }
  const stamped = stampedToolInput(context.input, tool, sessionId);
  if (stamped !== undefined) {
    const frame =
      context.options.harness === 'codex'
        ? allowedUpdatedToolInput('PreToolUse', stamped)
        : updatedToolInput('PreToolUse', stamped);
    context.options.stdout(frame);
  }
  return Promise.resolve(0);
}

/**
 * No MCP call at all. The record joins the buffer the next flush folds into its reflection,
 * which is what keeps a research-heavy turn from paying a round trip per tool.
 */
export function postToolUse(context: HookContext): Promise<number> {
  const sessionId = stringField(context.input, 'session_id');
  const record = bufferedToolFrom(context.input, context.options.now().toISOString());
  if (record === undefined) {
    return Promise.resolve(0);
  }
  const state = readHookState(context.options.stateDir, sessionId ?? '');
  writeHookState(context.options.stateDir, sessionId ?? '', {
    offset: state.offset,
    lastFlushAt: state.lastFlushAt,
    fingerprint: state.fingerprint,
    tools: [...state.tools, record],
  });
  return Promise.resolve(0);
}
