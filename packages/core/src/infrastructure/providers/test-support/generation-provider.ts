import type { Config } from '../../config/schema.js';
import { DEFAULT_ANTHROPIC_MODEL } from '../anthropic-provider.js';
import { GenerationUnavailableError } from '../errors.js';
import { OllamaProvider, type OllamaProviderOptions } from '../ollama-provider.js';
import { DEFAULT_OPENAI_MODEL, OpenAiProvider } from '../openai-provider.js';
import type { FrameOverride } from '../request-blocks.js';
import type { SpendingGuard } from '../spending.js';
import type { ApiCall, Provider, StructuredRequest, Vector } from '../types.js';
import { AnthropicHaikuClient } from './anthropic-client.js';

export type AnthropicTestProviderOptions = {
  readonly apiKey: string;
  readonly embedder: OllamaProvider;
  readonly model?: string;
  /** Forwarded to the underlying client untouched. See `AnthropicClientOptions`. */
  readonly spending?: SpendingGuard;
  readonly frameOverride?: FrameOverride;
  /** Forwarded to the underlying client untouched: the per-response usage record. */
  readonly recordApiCall?: (call: ApiCall) => void;
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
    this.#client = new AnthropicHaikuClient({
      apiKey: options.apiKey,
      ...(options.spending === undefined ? {} : { spending: options.spending }),
      ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
      ...(options.recordApiCall === undefined ? {} : { recordApiCall: options.recordApiCall }),
    });
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
 * Generation goes to OpenAI through the service's own backend, embedding stays local. The same
 * backend rather than a test copy of it, so a comparison against Haiku measures the route the
 * service would run.
 */
export class OpenAiTestProvider implements Provider {
  readonly route: { readonly provider: 'openai'; readonly model: string };
  readonly #backend: OpenAiProvider;
  readonly #embedder: OllamaProvider;

  constructor(options: Omit<AnthropicTestProviderOptions, 'model'> & { readonly model?: string }) {
    const model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.route = { provider: 'openai', model };
    this.#backend = new OpenAiProvider({
      apiKey: options.apiKey,
      model,
      ...(options.spending === undefined ? {} : { spending: options.spending }),
      ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
      ...(options.recordApiCall === undefined ? {} : { recordApiCall: options.recordApiCall }),
    });
    this.#embedder = options.embedder;
  }

  embed(texts: readonly string[]): Promise<Vector[]> {
    return this.#embedder.embed(texts);
  }

  generate(req: StructuredRequest): Promise<unknown> {
    return this.#backend.generate(req);
  }
}

/** Whether a run routes background generation to OpenAI: only when the shell says so. */
export function testRoutesToOpenAi(): boolean {
  return process.env.AION_REFLECT_PROVIDER === 'openai';
}

/** The key the selected test route needs, read at call time and stored nowhere else. */
export function testGenerationKey(): string {
  return (
    (testRoutesToOpenAi() ? process.env.AION_OPENAI_API_KEY : process.env.AION_ANTHROPIC_API_KEY) ??
    ''
  ).trim();
}

/**
 * The generation settings a battery that builds its own router runs under: both keys from the
 * environment, and the background route the shell selected. Anthropic unless it says otherwise.
 */
export function testGenerationConfig(
  base: Config,
): Pick<Config, 'anthropic' | 'openai' | 'generation'> {
  return {
    anthropic: { ...base.anthropic, apiKey: process.env.AION_ANTHROPIC_API_KEY ?? '' },
    openai: {
      ...base.openai,
      apiKey: process.env.AION_OPENAI_API_KEY ?? '',
      ...(process.env.AION_OPENAI_MODEL === undefined
        ? {}
        : { model: process.env.AION_OPENAI_MODEL }),
    },
    generation: {
      ...base.generation,
      reflectProvider: testRoutesToOpenAi() ? 'openai' : 'anthropic',
    },
  };
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

export type TestGenerationProviderOptions = OllamaProviderOptions & {
  /**
   * Forwarded to `AnthropicTestProvider` untouched, so a battery that needs the guarded path
   * passes its own campaign guard through the same factory every other caller uses. Absent
   * leaves generation unbounded, which is why the two named batteries and the four precision
   * gates all route through this option rather than constructing the client directly.
   */
  readonly spending?: SpendingGuard;
  readonly frameOverride?: FrameOverride;
  /**
   * The durable per-response usage record, forwarded to the remote client. A campaign opening
   * passes `openCampaignProducer`'s recorder here, which writes each billed response into the
   * shared ledger under its own experiment, condition and case.
   */
  readonly recordApiCall?: (call: ApiCall) => void;
};

/**
 * The provider an integration test drives enrichment through. With `AION_ANTHROPIC_API_KEY` in
 * the environment the generations run on Haiku and come back in a second or two; with
 * `AION_REFLECT_PROVIDER=openai` exported and `AION_OPENAI_API_KEY` set they run on the OpenAI
 * model instead, which is how a battery compares the two. With no key for the selected route,
 * generation refuses the same way the service refuses, because no other route stands in: an
 * enrichment file on a keyless machine has to skip rather than measure something else.
 *
 * The key is read here at call time and never stored anywhere else.
 */
export function testGenerationProvider(options: TestGenerationProviderOptions): Provider {
  const ollama = new OllamaProvider(options);
  const apiKey = testGenerationKey();
  if (apiKey.length === 0) {
    return new KeylessTestProvider(ollama);
  }
  const forwarded = {
    ...(options.spending === undefined ? {} : { spending: options.spending }),
    ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
    ...(options.recordApiCall === undefined ? {} : { recordApiCall: options.recordApiCall }),
  };
  if (testRoutesToOpenAi()) {
    return new OpenAiTestProvider({
      apiKey,
      embedder: ollama,
      ...(process.env.AION_OPENAI_MODEL === undefined
        ? {}
        : { model: process.env.AION_OPENAI_MODEL }),
      ...forwarded,
    });
  }

  return new AnthropicTestProvider({
    apiKey,
    embedder: ollama,
    model: process.env.AION_ANTHROPIC_MODEL,
    ...(options.spending === undefined ? {} : { spending: options.spending }),
    ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
    ...(options.recordApiCall === undefined ? {} : { recordApiCall: options.recordApiCall }),
  });
}
