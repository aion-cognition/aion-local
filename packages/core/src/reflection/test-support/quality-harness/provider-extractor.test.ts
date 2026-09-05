import { describe, expect, it } from 'vitest';

import {
  extractCognitiveViaProvider,
  extractEntitiesViaProvider,
  type ProviderGenerateDeps,
} from './provider-extractor.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import {
  KEYED as COGNITIVE_KEYED,
  LOCAL as COGNITIVE_LOCAL,
} from '../../../prompts/cognitive-extraction.js';
import {
  KEYED as ENTITY_KEYED,
  LOCAL as ENTITY_LOCAL,
} from '../../../prompts/entity-extraction.js';

const TEXT = 'user: the queue moved to SQLite\nassistant: noted';

function recording(
  answer: unknown,
  route?: Provider['route'],
): {
  readonly deps: ProviderGenerateDeps;
  readonly requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  return {
    requests,
    deps: {
      model: 'harness-model',
      ...(route === undefined ? {} : { route }),
      generate: (request: StructuredRequest): Promise<unknown> => {
        requests.push(request);
        return Promise.resolve(answer);
      },
    },
  };
}

function systemPrompt(requests: readonly StructuredRequest[]): string | undefined {
  return requests[0]?.messages[0]?.content;
}

/**
 * The harness scores the extraction the service runs, and `entities.ts` and `cognitive.ts` both
 * name 0. A sampled harness would score something else.
 */
describe('the sampling the harness extractors ask for', () => {
  it('asks for an unsampled answer on the entity route', async () => {
    const { deps, requests } = recording({ entities: [] });

    const outcome = await extractEntitiesViaProvider(deps, TEXT);

    expect(outcome.ok).toBe(true);
    expect(requests[0]?.temperature).toBe(0);
  });

  it('asks for an unsampled answer on the cognitive route', async () => {
    const { deps, requests } = recording({ nodes: [] });

    const outcome = await extractCognitiveViaProvider(deps, TEXT);

    expect(outcome.ok).toBe(true);
    expect(requests[0]?.temperature).toBe(0);
  });
});

/**
 * The harness has no prompt text of its own. Each route sends the constant that route ships, so a
 * forked surface is measured as two variants and a shared one is measured once, twice over.
 */
describe('the system prompt each harness route sends', () => {
  it('sends the local entity prompt on the Ollama route', async () => {
    const { deps, requests } = recording({ entities: [] }, { provider: 'ollama' });

    await extractEntitiesViaProvider(deps, TEXT);

    expect(systemPrompt(requests)).toBe(ENTITY_LOCAL);
  });

  it('sends the keyed entity prompt on the Anthropic route', async () => {
    const { deps, requests } = recording({ entities: [] }, { provider: 'anthropic' });

    await extractEntitiesViaProvider(deps, TEXT);

    expect(systemPrompt(requests)).toBe(ENTITY_KEYED);
  });

  it('sends the local cognitive prompt on the Ollama route', async () => {
    const { deps, requests } = recording({ nodes: [] }, { provider: 'ollama' });

    await extractCognitiveViaProvider(deps, TEXT);

    expect(systemPrompt(requests)).toBe(COGNITIVE_LOCAL);
  });

  it('sends the keyed cognitive prompt on the Anthropic route', async () => {
    const { deps, requests } = recording({ nodes: [] }, { provider: 'anthropic' });

    await extractCognitiveViaProvider(deps, TEXT);

    expect(systemPrompt(requests)).toBe(COGNITIVE_KEYED);
  });

  it('reads the local text when the caller states no route', async () => {
    const { deps, requests } = recording({ nodes: [] });

    await extractCognitiveViaProvider(deps, TEXT);

    expect(systemPrompt(requests)).toBe(COGNITIVE_LOCAL);
  });
});
