/**
 * Whether a rendered system prefix is long enough for the API to cache it, and the block shape
 * that says so on the wire.
 *
 * Haiku 4.5 caches nothing shorter than 4,096 tokens. A `cache_control` marker on a shorter
 * prefix is accepted and then ignored, which is the worst of both readings: the request looks
 * cached and the bill says otherwise. Measured against every system prompt this workspace ships
 * (2026-09-13, `prompt-prefix-size.test.ts`), the longest rendered prefix is under a quarter of
 * that floor, so the marker was a no-op on every surface that carried it.
 *
 * Padding a prompt to clear the floor is not on the table: the prefix would be text the model
 * reads on every call and nobody wrote for a reason. The marker is attached where a prefix
 * actually reaches the floor and left off where it does not, and `aion costs` reads the usage
 * fields, which are the ground truth about what was cached.
 */

/** The API's documented floor for this model family, in tokens. */
export const MIN_CACHEABLE_PREFIX_TOKENS = 4_096;

/**
 * Characters per token, for deciding before the answer comes back whether a prefix can reach
 * the floor. Four is Anthropic's own rule of thumb for English, and it is used in the
 * conservative direction: a prefix this estimate reads as short is left unmarked, so the failure
 * mode is a prefix that would have cached going uncached rather than a marker that does nothing.
 * The response's `cache_creation_input_tokens` is what actually settles it.
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

export const MIN_CACHEABLE_PREFIX_CHARS = MIN_CACHEABLE_PREFIX_TOKENS * ESTIMATED_CHARS_PER_TOKEN;

/** Whether marking this prefix would do anything. */
export function prefixReachesCacheFloor(prefix: string): boolean {
  return prefix.length >= MIN_CACHEABLE_PREFIX_CHARS;
}

export type SystemBlock = {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral' };
};

/**
 * The `system` field for one call: the plain string when nothing is being cached, and a single
 * marked text block when the prefix clears the floor. A caller that switched caching off gets
 * the string whatever the length.
 */
export function systemField(
  instructions: string | undefined,
  promptCache: boolean,
): string | readonly SystemBlock[] | undefined {
  if (instructions === undefined) {
    return undefined;
  }
  if (!promptCache || !prefixReachesCacheFloor(instructions)) {
    return instructions;
  }
  return [{ type: 'text', text: instructions, cache_control: { type: 'ephemeral' } }];
}
