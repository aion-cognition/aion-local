import { DEFAULT_ANTHROPIC_MODEL } from '../anthropic-provider.js';
import { GenerationUnavailableError } from '../errors.js';
import { OllamaProvider, type OllamaProviderOptions } from '../ollama-provider.js';
import type { Provider, StructuredRequest, Vector } from '../types.js';
import { AnthropicHaikuClient } from './anthropic-client.js';

export type AnthropicTestProviderOptions = {
  readonly apiKey: string;
  readonly embedder: OllamaProvider;
  readonly model?: string;
};

/**
 * Generation goes to Anthropic, embedding stays on the local model. One embedding space is the
 * standing rule for the substrate, and a test that embedded anywhere else would compare vectors
 * the product never produces.
 */
export class AnthropicTestProvider implements Provider {
  /**
   * The same fact the service's routed provider carries, so a call site that sizes its prompt
   * to the model behind it reads what the service reads.
   */
  readonly route = { provider: 'anthropic' } as const;
  readonly #client: AnthropicHaikuClient;
  readonly #embedder: OllamaProvider;
  readonly #model: string;

  constructor(options: AnthropicTestProviderOptions) {
    // No schema-delivery pin: a test that drove the remote route a different way from the
    // service would not see what the service sees.
    this.#client = new AnthropicHaikuClient({ apiKey: options.apiKey });
    this.#embedder = options.embedder;
    this.#model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  embed(texts: readonly string[]): Promise<Vector[]> {
    return this.#embedder.embed(texts);
  }

  generate(req: StructuredRequest): Promise<unknown> {
    return this.#client.generate({ ...req, model: this.#model });
  }
}

/**
 * The provider a test drives when there is no key: it embeds, and refuses to generate with the
 * same error the service raises. A file that needs enrichment skips on the missing key rather
 * than measuring a model this substrate does not run.
 */
export class KeylessTestProvider implements Provider {
  readonly #embedder: OllamaProvider;

  constructor(embedder: OllamaProvider) {
    this.#embedder = embedder;
  }

  embed(texts: readonly string[]): Promise<Vector[]> {
    return this.#embedder.embed(texts);
  }

  generate(req: StructuredRequest): Promise<unknown> {
    return Promise.reject(new GenerationUnavailableError(req.surface ?? 'unlabeled'));
  }
}

/**
 * The provider an integration test drives enrichment through. With `AION_ANTHROPIC_API_KEY` in
 * the environment the generations run on Haiku and come back in a second or two. With no key,
 * generation refuses the same way the service refuses, because there is no second route left to
 * fall back to: an enrichment file on a keyless machine has to skip rather than measure
 * something the product does not run.
 *
 * The key is read here at call time and never stored anywhere else.
 */
export function testGenerationProvider(options: OllamaProviderOptions): Provider {
  const ollama = new OllamaProvider(options);
  const apiKey = process.env.AION_ANTHROPIC_API_KEY ?? '';
  if (apiKey.trim().length === 0) {
    return new KeylessTestProvider(ollama);
  }

  return new AnthropicTestProvider({
    apiKey,
    embedder: ollama,
    model: process.env.AION_ANTHROPIC_MODEL,
  });
}
