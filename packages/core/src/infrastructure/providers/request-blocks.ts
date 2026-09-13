import { cacheControlFor, type CacheTtl, type SystemBlock } from './anthropic-cache.js';
import type { JsonSchema } from './types.js';
import { frameFor, frameText } from '../../prompts/frame.js';

export type { SystemBlock };

/**
 * The one place a request's system side is assembled, for both the synchronous route and the
 * batch lane.
 *
 * Two blocks, in this order and no other:
 *
 * ```text
 * system block 1: the shared frame, marked for the hour where it reaches the cache floor
 * system block 2: the surface's own instructions, unchanged, then its schema
 * messages:       the per-call evidence
 * ```
 *
 * The order is the whole mechanism. Everything a call shares with every other call sits ahead of
 * the breakpoint and everything that varies sits behind it, so one cache entry can cover every
 * surface instead of one per surface. The serializer this replaces joined all the system messages
 * and appended the schema before marking the result, which put a per-surface tail inside the
 * marked region and fragmented the cache by task.
 *
 * Composing it here rather than at the call sites is what keeps the task text untouched: a
 * surface writes its instructions and knows nothing about the frame, and nothing about the frame
 * can drift into a prompt file.
 */

/** The TTL the frame is written under. Longer-TTL blocks precede shorter ones, and this is first. */
export const FRAME_CACHE_TTL: CacheTtl = '1h';

/**
 * The frame one run sends in place of its allocation.
 *
 * `{ none: true }` sends no frame block at all, which is what a battery comparing the same code,
 * inputs, model and thinking settings with and without the frame needs: it changes the request
 * and nothing else. `{ text }` sends that text on every surface. A test seam and not a deployment
 * switch: no knob reads it and the service never sets it.
 */
export type FrameOverride = { readonly none: true } | { readonly text: string };

export type SystemComposition = {
  /** The call class, which is what the frame allocation is keyed on. */
  readonly surface: string | undefined;
  /** The surface's own system text, joined as it wrote it. Undefined where it wrote none. */
  readonly instructions: string | undefined;
  /** Sent as an instruction rather than a constraint, which is the shipped delivery mode. */
  readonly schema?: JsonSchema;
  readonly promptCache: boolean;
  /** The frame this call carries in place of its allocation. Absent, the allocation decides. */
  readonly frameOverride?: FrameOverride;
};

function schemaInstruction(schema: JsonSchema): string {
  return [
    'Answer with one JSON value and nothing else: no prose, no explanation, no code fence.',
    'The value must satisfy this JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
}

/**
 * The second block: the surface's instructions and then its schema, joined the way they have
 * always been joined. Exported so a test can assert the task text reached the model unchanged
 * without restating the join.
 */
export function taskBlockOf(
  instructions: string | undefined,
  schema: JsonSchema | undefined,
): string {
  if (schema === undefined) {
    return instructions ?? '';
  }
  const extra = schemaInstruction(schema);
  return instructions === undefined ? extra : `${instructions}\n\n${extra}`;
}

/** The text this call's frame block carries, or nothing where the caller asked for none. */
function frameOf(input: SystemComposition): string | undefined {
  const override = input.frameOverride;
  if (override === undefined) {
    return frameText(frameFor(input.surface));
  }
  return 'none' in override ? undefined : override.text;
}

/**
 * The system blocks one request sends.
 *
 * The marker goes on the frame alone. The task block is different on every surface and would
 * write a cache entry per surface for a prefix that is read once, which is a surcharge rather
 * than a saving; `anthropic-cache.ts` decides whether the frame is long enough for the marker to
 * do anything at all.
 */
export function composeSystemBlocks(input: SystemComposition): readonly SystemBlock[] {
  const frame = frameOf(input);
  const task = taskBlockOf(input.instructions, input.schema);
  const blocks: SystemBlock[] = [];
  if (frame !== undefined && frame.length > 0) {
    blocks.push({
      type: 'text',
      text: frame,
      ...cacheControlFor(frame, input.promptCache, FRAME_CACHE_TTL),
    });
  }
  if (task.length > 0) {
    blocks.push({ type: 'text', text: task });
  }
  return blocks;
}

/**
 * How many bytes of this request sit ahead of the cache breakpoint.
 *
 * Zero when nothing is marked, which is the honest reading of a request whose prefix the model
 * would not cache: there is no breakpoint, so nothing is shared across calls at the API's
 * expense or its saving.
 */
export function sharedPrefixBytes(blocks: readonly SystemBlock[]): number {
  let bytes = 0;
  for (const block of blocks) {
    bytes += block.text.length;
    if (block.cache_control !== undefined) {
      return bytes;
    }
  }
  return blocks[0]?.text.length ?? 0;
}

/** True when this request carries a marked prefix, which is the only shape billed as a cache write. */
export function marksACacheWrite(blocks: readonly SystemBlock[]): boolean {
  return blocks.some((block) => block.cache_control !== undefined);
}

/** What a marked request's input can be billed at, and nothing where nothing is marked. */
export type CacheWriteClass = {
  readonly cacheWrite: boolean;
  /** Absent where nothing is marked. The hour is the more expensive of the two write rates. */
  readonly cacheWriteTtl?: CacheTtl;
};

/**
 * The write class a stored request body carries, read back off the body itself.
 *
 * The batch lane holds a request for hours before it submits it and reconciles it hours later
 * again, so the composition that decided the marker is long gone by then. The body is what the
 * remote is sent and what it bills against, which makes it the only honest thing to size a
 * reservation from: asserting the class from here would hold a bound for a request of a
 * different shape.
 */
export function cacheWriteClassOf(body: unknown): CacheWriteClass {
  const { system } = (body ?? {}) as { system?: unknown };
  if (!Array.isArray(system)) {
    return { cacheWrite: false };
  }
  const marked = (system as readonly SystemBlock[]).filter(
    (block) => block.cache_control !== undefined,
  );
  if (marked.length === 0) {
    return { cacheWrite: false };
  }
  // The dearest class any marked block asks for, because the bound has to cover the whole body.
  const hour = marked.some((block) => block.cache_control?.ttl === '1h');
  return { cacheWrite: true, cacheWriteTtl: hour ? '1h' : '5m' };
}
