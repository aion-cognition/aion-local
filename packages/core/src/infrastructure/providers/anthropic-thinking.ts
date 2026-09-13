/**
 * Extended thinking on the Anthropic route: a token budget on the request, and the share of the
 * output bill it came back as.
 *
 * Haiku 4.5 takes only this manual mode. There is no adaptive setting to fall back on and no
 * effort word that stands in for the number, so the budget IS the configuration, and three of
 * the API's rules decide whether a call can carry one at all.
 */

/** The API refuses a smaller budget outright. */
export const MIN_THINKING_BUDGET_TOKENS = 1024;

/** The budget a call asks for when nothing names one. */
export const DEFAULT_THINKING_BUDGET_TOKENS = 2048;

/**
 * Output tokens held back from the budget for the answer itself. Thinking counts against
 * `max_tokens`, so a budget that fills it leaves the model no room to write the JSON and the
 * response stops on `max_tokens` with nothing parseable in it.
 */
const THINKING_ANSWER_RESERVE_TOKENS = 1024;

export type ThinkingConfig = { readonly type: 'enabled'; readonly budget_tokens: number };

/**
 * The thinking block this call sends, or nothing.
 *
 * The budget has to stay under `max_tokens`, since thinking is billed and counted as output, and
 * it has to reach the floor above or the request is refused. A ceiling too low for the floor
 * therefore answers with no thinking at all rather than a request that cannot be sent: a caller
 * asking to reason inside a thousand-token answer is asking for something the model does not
 * offer.
 */
export function thinkingConfig(
  think: boolean | undefined,
  maxTokens: number,
  budgetTokens: number = DEFAULT_THINKING_BUDGET_TOKENS,
): ThinkingConfig | undefined {
  if (think !== true) {
    return undefined;
  }
  const budget = Math.min(budgetTokens, maxTokens - THINKING_ANSWER_RESERVE_TOKENS);
  if (budget < MIN_THINKING_BUDGET_TOKENS) {
    return undefined;
  }
  return { type: 'enabled', budget_tokens: budget };
}
