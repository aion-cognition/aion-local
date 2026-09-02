import { describe, expect, it } from 'vitest';

import { extractCognitiveViaProvider, extractEntitiesViaProvider } from './provider-extractor.js';
import type { StructuredRequest } from '../../../infrastructure/providers/types.js';

const TEXT = 'user: the queue moved to SQLite\nassistant: noted';

function recording(answer: unknown): {
  readonly deps: { generate: (request: StructuredRequest) => Promise<unknown>; model: string };
  readonly requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  return {
    requests,
    deps: {
      model: 'harness-model',
      generate: (request: StructuredRequest): Promise<unknown> => {
        requests.push(request);
        return Promise.resolve(answer);
      },
    },
  };
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
