import { describe, expect, it } from 'vitest';

import { synthesizeGrounded } from './consolidation-synthesis.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';
import type { NarrativeSource } from '../domain/narrative.js';

const SOURCE: NarrativeSource = {
  text: '[M1] the queue moved to SQLite\n[M2] the move landed in July',
  items: [
    { id: 'claim-1', handle: 'M1', kind: 'decision', text: 'the queue moved to SQLite' },
    { id: 'claim-2', handle: 'M2', kind: 'event', text: 'the move landed in July' },
  ],
  renderedCount: 2,
  coverage: 1,
  sentenceBudget: 2,
};

const MESSAGES = [{ role: 'user' as const, content: `Members:\n${SOURCE.text}` }];

const OPTIONS = { model: 'reflect-model', timeoutMs: 1_000 };

describe('the sampling both consolidation passes ask for', () => {
  /**
   * The draft has to ground, or the reviewer is never called and the second pin measures
   * nothing. One cited sentence is what carries the run into pass two.
   */
  it('asks for an unsampled answer on the draft and on the review of it', async () => {
    const requests: StructuredRequest[] = [];
    const provider: Pick<Provider, 'generate'> = {
      generate: (request: StructuredRequest): Promise<unknown> => {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1
            ? { sentences: [{ text: 'The queue runs on SQLite.', source_ids: ['M1'] }] }
            : { unsupported: false },
        );
      },
    };

    const outcome = await synthesizeGrounded(provider, SOURCE, MESSAGES, OPTIONS);

    expect(outcome.status).toBe('grounded');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.temperature)).toEqual([0, 0]);
  });
});
