import { DEFAULT_ANTHROPIC_MODEL } from '../anthropic-provider.js';
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

  /**
   * The request names an Ollama tag, because the caller reads its model from config the same
   * way the service does. Swapping it here keeps every call site free of a second model knob
   * it would need under this route alone.
   */
  generate(req: StructuredRequest): Promise<unknown> {
    return this.#client.generate({ ...req, model: this.#model });
  }
}

/**
 * The provider an integration test drives enrichment through. With `AION_ANTHROPIC_API_KEY` in
 * the environment the generations run on Haiku and come back in a second or two, where qwen3:8b
 * takes 35 to 100 seconds for the same call. Set `TEST_AION_GENERATION=local` to force the local
 * model, which is what a file measuring local-model quality wants. With no key at all everything
 * falls back to local silently, so a machine without one still runs the whole suite.
 *
 * The key is read here at call time and never stored anywhere else.
 */
export function testGenerationProvider(options: OllamaProviderOptions): Provider {
  const ollama = new OllamaProvider(options);
  const apiKey = process.env.AION_ANTHROPIC_API_KEY ?? '';
  if (apiKey.trim().length === 0 || process.env.TEST_AION_GENERATION === 'local') {
    return ollama;
  }

  return new AnthropicTestProvider({
    apiKey,
    embedder: ollama,
    model: process.env.AION_ANTHROPIC_MODEL,
  });
}
