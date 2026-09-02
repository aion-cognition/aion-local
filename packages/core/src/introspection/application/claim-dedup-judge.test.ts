import { describe, expect, it } from 'vitest';

import { judgeClaimDedup, reviewClaimDedup, type ClaimDedupPair } from './claim-dedup-judge.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';

const PAIR: ClaimDedupPair = {
  subjectLabel: 'Decision',
  candidateLabel: 'Decision',
  subject: 'The queue writes go to a separate SQLite database.',
  candidate: 'Queue writes live in their own SQLite file.',
};

const OPTIONS = { model: 'qwen3:8b', timeoutMs: 1_000 };

function recording(answer: unknown): {
  readonly provider: Pick<Provider, 'generate'>;
  readonly requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  return {
    requests,
    provider: {
      generate: (request: StructuredRequest): Promise<unknown> => {
        requests.push(request);
        return Promise.resolve(answer);
      },
    },
  };
}

describe('the sampling both claim dedup passes ask for', () => {
  it('asks for an unsampled answer on the detection pass', async () => {
    const { provider, requests } = recording({ same: true, rationale: 'one claim said twice' });

    const outcome = await judgeClaimDedup(provider, PAIR, OPTIONS);

    expect(outcome.status).toBe('judged');
    expect(requests[0]?.temperature).toBe(0);
  });

  /** Unanimity is what merges two claims, so the pass that can veto is pinned the same way. */
  it('asks for an unsampled answer on the review pass', async () => {
    const { provider, requests } = recording({ either_adds_information: false });

    const outcome = await reviewClaimDedup(provider, PAIR, OPTIONS);

    expect(outcome.status).toBe('reviewed');
    expect(requests[0]?.temperature).toBe(0);
  });
});
