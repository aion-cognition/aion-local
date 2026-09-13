import { AnthropicProvider } from './anthropic-provider.js';
import { GenerationUnavailableError } from './errors.js';
import { OllamaProvider } from './ollama-provider.js';
import type { FrameOverride } from './request-blocks.js';
import { resolveProviderRouting, type GenerationRole, type ProviderRouting } from './routing.js';
import type { SpendingGuard } from './spending.js';
import type {
  ApiCall,
  Embedder,
  GenerationBackend,
  Provider,
  StructuredRequest,
  Vector,
} from './types.js';
import type { Config } from '../config/schema.js';

/**
 * Emitted once per generation. This is how a caller answers "did that enrichment leave the
 * machine" from the outside: the boot log carries the resolved routing, and this carries what
 * each call actually did.
 */
export type GenerationEvent = {
  readonly role: GenerationRole;
  readonly provider: 'anthropic';
  readonly model: string;
  readonly durationMs: number;
  readonly ok: boolean;
};

export type ProviderRouterOptions = {
  readonly config: Config;
  readonly fetchImpl?: typeof fetch;
  readonly onGeneration?: (event: GenerationEvent) => void;
  readonly now?: () => number;
  readonly recordApiCall?: (call: ApiCall) => void;
  /**
   * The shared frame every generation surface reads, overridden for one run.
   *
   * This is the seam a battery comparing the same code, inputs, model and thinking settings with
   * and without the frame runs through: it changes the request and nothing else. Absent, each
   * surface's allocation decides, which is what the service always gets, since nothing reads this
   * from config and no deployment can set it.
   */
  readonly frameOverride?: FrameOverride;
  /**
   * The day's spending backstop, shared with every other route into the same store. Absent
   * leaves this router's calls unbounded, which is what a composition with no substrate store
   * behind it gets.
   */
  readonly spending?: SpendingGuard;
};

/**
 * A backend that refuses every call, for a substrate with no key. It is a backend rather than an
 * absent one so the shape of the call path is the same either way: the caller asks, the answer
 * is that generation has nowhere to run, and the caller's own handling decides whether that
 * means a queued job or a degraded pack.
 */
class UnavailableGeneration implements GenerationBackend {
  generate(req: StructuredRequest): Promise<unknown> {
    return Promise.reject(new GenerationUnavailableError(req.surface ?? 'unlabeled'));
  }
}

/**
 * One role's `Provider`: the local embedder, and the remote generation backend. Callers keep
 * naming their own model from config; the router substitutes the routed one, so no call site
 * needs a second model knob.
 */
class RoutedProvider implements Provider {
  readonly #embedder: Embedder;
  readonly #generator: GenerationBackend;
  readonly #role: GenerationRole;
  readonly #model: string;
  readonly #onGeneration: ((event: GenerationEvent) => void) | undefined;
  readonly #now: () => number;

  constructor(
    embedder: Embedder,
    generator: GenerationBackend,
    role: GenerationRole,
    model: string,
    onGeneration: ((event: GenerationEvent) => void) | undefined,
    now: () => number,
  ) {
    this.#embedder = embedder;
    this.#generator = generator;
    this.#role = role;
    this.#model = model;
    this.#onGeneration = onGeneration;
    this.#now = now;
  }

  /** One provider name now, kept on the interface because call sites size prompts by it. */
  get route(): { readonly provider: 'anthropic' } {
    return { provider: 'anthropic' };
  }

  embed(texts: readonly string[]): Promise<Vector[]> {
    return this.#embedder.embed(texts);
  }

  async generate(req: StructuredRequest): Promise<unknown> {
    const started = this.#now();
    const report = (ok: boolean): void => {
      this.#onGeneration?.({
        role: this.#role,
        provider: 'anthropic',
        model: this.#model,
        durationMs: this.#now() - started,
        ok,
      });
    };

    try {
      const answer = await this.#generator.generate(req);
      report(true);
      return answer;
    } catch (err) {
      // A refusal for want of a key is not a generation outcome: counting it would put a
      // failure rate on a substrate that never called anything.
      if (!(err instanceof GenerationUnavailableError)) {
        report(false);
      }
      throw err;
    }
  }
}

/**
 * Resolves routing once and hands out one `Provider` per role. Both roles share one Ollama
 * client (embeddings are local) and one Anthropic client (so a remote outage opens one breaker
 * rather than one per role).
 */
export class ProviderRouter {
  readonly routing: ProviderRouting;
  readonly #ollama: OllamaProvider;
  readonly #generator: GenerationBackend;
  readonly #byRole = new Map<GenerationRole, RoutedProvider>();
  readonly #onGeneration: ((event: GenerationEvent) => void) | undefined;
  readonly #now: () => number;

  constructor(options: ProviderRouterOptions) {
    const { config } = options;
    this.routing = resolveProviderRouting(config);
    this.#onGeneration = options.onGeneration;
    this.#now = options.now ?? Date.now;
    this.#ollama = new OllamaProvider({
      baseUrl: config.ollama.url,
      embedModel: config.models.embed,
      embedKeepAlive: config.ollama.embedKeepAlive,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.#generator = this.routing.keyPresent
      ? new AnthropicProvider({
          // Trimmed, because routing decided the key was present after trimming it. A key read
          // from a file keeps its trailing newline, and fetch rejects that header value outright.
          apiKey: config.anthropic.apiKey.trim(),
          model: config.anthropic.model,
          promptCache: config.anthropic.promptCache,
          ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
          thinkingBudgetTokens: config.anthropic.thinkingBudgetTokens,
          now: this.#now,
          ...(options.recordApiCall === undefined ? {} : { recordApiCall: options.recordApiCall }),
          ...(options.spending === undefined ? {} : { spending: options.spending }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : new UnavailableGeneration();
  }

  /** The local embedder itself, for a caller that only ever embeds. */
  get embedder(): Embedder {
    return this.#ollama;
  }

  forRole(role: GenerationRole): Provider {
    const existing = this.#byRole.get(role);
    if (existing !== undefined) {
      return existing;
    }
    const route = this.routing.roles[role];
    const provider = new RoutedProvider(
      this.#ollama,
      this.#generator,
      role,
      route.model,
      this.#onGeneration,
      this.#now,
    );
    this.#byRole.set(role, provider);
    return provider;
  }
}
