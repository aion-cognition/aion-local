import { requestAnthropicJson, type SchemaDelivery } from '../anthropic-provider.js';
import type { StructuredRequest } from '../types.js';

export { jsonSpans, parseJsonPayload } from '../anthropic-provider.js';
export type { SchemaDelivery } from '../anthropic-provider.js';

export type AnthropicClientOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  readonly schemaDelivery?: SchemaDelivery;
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
