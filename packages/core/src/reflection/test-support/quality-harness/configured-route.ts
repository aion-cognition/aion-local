import {
  extractCognitiveViaProvider,
  extractEntitiesViaProvider,
  type ProviderGenerateDeps,
} from './provider-extractor.js';
import type { RouteConfig } from './runner.js';
import type { CognitiveExtractorFn, EntityExtractorFn, ExtractionRoute } from './types.js';
import {
  ProviderRouter,
  type ProviderRouterOptions,
} from '../../../infrastructure/providers/role-provider.js';

/** Runs the diagnostic through the service's selected reflection route. */
export class ConfiguredExtractionRoute implements RouteConfig {
  readonly route: ExtractionRoute;
  readonly model: string;
  readonly available: boolean;
  readonly #deps: ProviderGenerateDeps;

  constructor(options: ProviderRouterOptions) {
    const router = new ProviderRouter(options);
    const selected = router.routing.roles.reflect;
    const provider = router.forRole('reflect');
    this.route = selected.provider;
    this.model = selected.model;
    this.available = selected.available;
    this.#deps = {
      generate: (request) => provider.generate(request),
      model: selected.model,
      route: provider.route,
    };
  }

  extractEntities(text: string): ReturnType<EntityExtractorFn> {
    return extractEntitiesViaProvider(this.#deps, text);
  }

  extractCognitive(text: string): ReturnType<CognitiveExtractorFn> {
    return extractCognitiveViaProvider(this.#deps, text);
  }
}
