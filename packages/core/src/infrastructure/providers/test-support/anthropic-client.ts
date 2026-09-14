import { requestAnthropicJson, type SchemaDelivery } from '../anthropic-provider.js';
import type { FrameOverride } from '../request-blocks.js';
import type { SpendingGuard } from '../spending.js';
import type { ApiCall, StructuredRequest } from '../types.js';

export { jsonSpans, parseJsonPayload } from '../anthropic-json.js';
export type { SchemaDelivery } from '../anthropic-provider.js';

export type AnthropicClientOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  readonly schemaDelivery?: SchemaDelivery;
  /**
   * The day's spending backstop, consulted before the request is sent. Absent leaves this
   * client's calls unbounded, which every production route already refuses to be; a battery
   * that constructs this class directly has to pass one in the same way `AnthropicProvider` does.
   */
  readonly spending?: SpendingGuard;
  /** The shared frame override, for a harness comparing conditions. See `AnthropicRequestOptions`. */
  readonly frameOverride?: FrameOverride;
  /**
   * Where each billed response's own usage is written. A guard's reservation bounds what a
   * dispatch may cost; this is what it did cost, with the tokens the response reported. A battery
   * measuring per-case spend needs both, and only this one survives the process.
   */
  readonly recordApiCall?: (call: ApiCall) => void;
};

/**
 * The test-side caller of the Anthropic Messages API: the extraction quality harness, which
 * compares this route against the local one, and the test-support provider integration tests
 * reach for. It keeps a model per request rather than pinning one, which is what the harness
 * needs to name the model it is measuring.
 *
 * The transport is the production provider's, so a fix to the parser or the retry reaches both.
 * What stays different is the breaker: a suite that fast-fails on a cooldown reports a circuit
 * where a test wanted the API's own error.
 */
export class AnthropicHaikuClient {
  readonly #options: AnthropicClientOptions;

  constructor(options: AnthropicClientOptions) {
    this.#options = options;
  }

  generate(req: StructuredRequest): Promise<unknown> {
    return requestAnthropicJson(this.#options, req);
  }
}
