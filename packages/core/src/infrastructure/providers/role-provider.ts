import type { Config } from '../config/schema.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import {
  resolveProviderRouting,
  type GenerationRole,
  type ProviderName,
  type ProviderRouting,
  type RoleRoute,
} from './routing.js';
import type { GenerationBackend, Provider, StructuredRequest, Vector } from './types.js';

/**
 * Emitted once per generation. This is how a caller answers "did that enrichment leave the
 * machine" from the outside: the boot log carries the resolved routing, and this carries what
 * each call actually did.
 */
export type GenerationEvent = {
  readonly role: GenerationRole;
  readonly provider: ProviderName;
  readonly model: string;
  readonly durationMs: number;
  readonly ok: boolean;
};

export type ProviderRouterOptions = {
  readonly config: Config;
  readonly fetchImpl?: typeof fetch;
  readonly onGeneration?: (event: GenerationEvent) => void;
  readonly now?: () => number;
};

/**
 * One role's `Provider`: the local embedder, and whichever backend the role routes to for
 * `generate`. Callers keep naming their own model from config; a remote route substitutes its
 * own, so no call site needs a second model knob for the route it happens to be on.
 */
class RoutedProvider implements Provider {
  readonly #embedder: Provider;
  readonly #generator: GenerationBackend;
  readonly #route: RoleRoute;
  readonly #onGeneration: ((event: GenerationEvent) => void) | undefined;
  readonly #now: () => number;

  constructor(
    embedder: Provider,
    generator: GenerationBackend,
    route: RoleRoute,
    onGeneration: ((event: GenerationEvent) => void) | undefined,
    now: () => number,
  ) {
    this.#embedder = embedder;
    this.#generator = generator;
    this.#route = route;
    this.#onGeneration = onGeneration;
    this.#now = now;
  }

  get route(): RoleRoute {
    return this.#route;
  }

  embed(texts: readonly string[]): Promise<Vector[]> {
    return this.#embedder.embed(texts);
  }

  async generate(req: StructuredRequest): Promise<unknown> {
    const started = this.#now();
    const report = (ok: boolean): void => {
      this.#onGeneration?.({
        role: this.#route.role,
        provider: this.#route.provider,
        model: this.#route.model,
        durationMs: this.#now() - started,
        ok,
      });
    };

    try {
      const answer = await this.#generator.generate(req);
      report(true);
      return answer;
    } catch (err) {
      report(false);
      throw err;
    }
  }
}

/**
 * Resolves routing once and hands out one `Provider` per role. Both roles share one Ollama
 * client (embeddings are local under every route) and one Anthropic client (so a remote
 * outage opens one breaker rather than one per role).
 */
export class ProviderRouter {
  readonly routing: ProviderRouting;
  readonly #ollama: OllamaProvider;
  readonly #anthropic: AnthropicProvider | undefined;
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
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.#anthropic = this.routing.keyPresent
      ? new AnthropicProvider({
          apiKey: config.anthropic.apiKey,
          model: config.anthropic.model,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : undefined;
  }

  /** The local provider itself, for a caller that only ever embeds. */
  get embedder(): Provider {
    return this.#ollama;
  }

  forRole(role: GenerationRole): Provider {
    const existing = this.#byRole.get(role);
    if (existing !== undefined) {
      return existing;
    }
    const route = this.routing.roles[role];
    // A remote route with no client cannot happen: routing resolves to Ollama without a key.
    const generator: GenerationBackend =
      route.provider === 'anthropic' && this.#anthropic !== undefined ? this.#anthropic : this.#ollama;
    const provider = new RoutedProvider(this.#ollama, generator, route, this.#onGeneration, this.#now);
    this.#byRole.set(role, provider);
    return provider;
  }
}
