import { describe, expect, it } from 'vitest';

import {
  CLAIM_DEDUP_OVER_ALLOWANCE,
  judgeClaimDedup,
  reviewClaimDedup,
  type ClaimDedupPair,
} from './claim-dedup-judge.js';
import { JUDGE_ROUTE_ALLOWANCE } from '../../evidence/domain/budget.js';
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

describe('what a claim dedup pass is allowed to submit', () => {
  const oversized: ClaimDedupPair = {
    ...PAIR,
    subject: 'x'.repeat(JUDGE_ROUTE_ALLOWANCE.claim_dedup),
  };

  it('asks nothing when the first pass would submit more than its route allowance', async () => {
    const { provider, requests } = recording({ same: true });

    const outcome = await judgeClaimDedup(provider, oversized, OPTIONS);

    expect(outcome).toEqual({ status: 'failed', detail: CLAIM_DEDUP_OVER_ALLOWANCE });
    expect(requests).toEqual([]);
  });

  it('asks nothing when the second pass would submit more than its route allowance', async () => {
    const { provider, requests } = recording({ either_adds_information: false });

    const outcome = await reviewClaimDedup(provider, oversized, OPTIONS);

    expect(outcome).toEqual({ status: 'failed', detail: CLAIM_DEDUP_OVER_ALLOWANCE });
    expect(requests).toEqual([]);
  });

  it('submits a pair that fits, messages and system prompt together', async () => {
    const { provider, requests } = recording({ same: true });

    await judgeClaimDedup(provider, PAIR, OPTIONS);

    expect(requests).toHaveLength(1);
  });
});
