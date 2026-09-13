import { describe, expect, it } from 'vitest';

import {
  extractCognitiveViaProvider,
  extractEntitiesViaProvider,
  type ProviderGenerateDeps,
} from './provider-extractor.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { EXTRACTION_PROMPT as COGNITIVE_PROMPT } from '../../../prompts/cognitive-extraction.js';
import { EXTRACTION_PROMPT as ENTITY_PROMPT } from '../../../prompts/entity-extraction.js';

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
 * The harness has no prompt text of its own: each extractor sends the one constant its surface
 * ships, whatever route the caller states. It used to send one of two, which is what the
 * route argument below is left over from.
 */
describe('the system prompt the harness sends', () => {
  it('sends the entity prompt, whatever route the caller states', async () => {
    const routed = recording({ entities: [] }, { provider: 'anthropic' });
    const unrouted = recording({ entities: [] });

    await extractEntitiesViaProvider(routed.deps, TEXT);
    await extractEntitiesViaProvider(unrouted.deps, TEXT);

    expect(systemPrompt(routed.requests)).toBe(ENTITY_PROMPT);
    expect(systemPrompt(unrouted.requests)).toBe(ENTITY_PROMPT);
  });

  it('sends the cognitive prompt, whatever route the caller states', async () => {
    const routed = recording({ nodes: [] }, { provider: 'anthropic' });
    const unrouted = recording({ nodes: [] });

    await extractCognitiveViaProvider(routed.deps, TEXT);
    await extractCognitiveViaProvider(unrouted.deps, TEXT);

    expect(systemPrompt(routed.requests)).toBe(COGNITIVE_PROMPT);
    expect(systemPrompt(unrouted.requests)).toBe(COGNITIVE_PROMPT);
  });
});
