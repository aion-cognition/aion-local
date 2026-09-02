import { describe, expect, it } from 'vitest';

import {
  adviseTier3,
  DEFAULT_TIER3_MODE,
  modelAdvisor,
  reviewTier3Proposal,
  TIER3_NO_OPERATION,
} from './tier3-advisor.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';
import type { OperationCandidate } from '../domain/decide.js';
import { NEUTRAL_QUEUE_HEALTH } from '../domain/health.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';
import type { Tier3Proposal, Tier3Request } from '../domain/tier3.js';

const CANDIDATES: readonly OperationCandidate[] = [
  { name: 'dead_letter', relevance: 0.18 },
  { name: 'memory_decay', relevance: 0.15 },
];

const REQUEST: Tier3Request = {
  health: healthFixture({ queue: { ...NEUTRAL_QUEUE_HEALTH, exhausted: 9 } }),
  candidates: CANDIDATES,
  reason: 'no operation cleared the urgency threshold',
};

const PROPOSAL: Tier3Proposal = {
  operation: 'dead_letter',
  confidence: 0.7,
  rationale: 'nine exhausted rows are waiting on their one retry',
};

const OPTIONS = { model: 'qwen3:8b', timeoutMs: 1_000 };

function answering(answer: unknown): Pick<Provider, 'generate'> {
  return { generate: (): Promise<unknown> => Promise.resolve(answer) };
}

/** Never answers on its own: the only way out is the abort the caller composed. */
function hanging(): Pick<Provider, 'generate'> {
  return {
    generate: (request: StructuredRequest): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        if (request.signal?.aborted === true) {
          reject(new Error('the call was aborted'));
          return;
        }
        request.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('the call was aborted'));
          },
          { once: true },
        );
      }),
  };
}

describe('adviseTier3', () => {
  it('reads a well-formed answer as a proposal and clamps the confidence', async () => {
    const outcome = await adviseTier3(
      answering({ operation: 'dead_letter', confidence: 4, rationale: 'the queue is stuck' }),
      REQUEST,
      OPTIONS,
    );

    expect(outcome).toEqual({
      status: 'advised',
      proposal: { operation: 'dead_letter', confidence: 1, rationale: 'the queue is stuck' },
    });
  });

  it('reads the none answer as a decision that the substrate needs nothing', async () => {
    const outcome = await adviseTier3(
      answering({ operation: TIER3_NO_OPERATION, rationale: 'every backlog is small' }),
      REQUEST,
      OPTIONS,
    );

    expect(outcome).toEqual({ status: 'declined', rationale: 'every backlog is small' });
  });

  it('is case-insensitive on the operation word, so None is a decline and not a broken advisor', async () => {
    const outcome = await adviseTier3(
      answering({ operation: 'None', rationale: 'every backlog is small' }),
      REQUEST,
      OPTIONS,
    );

    expect(outcome).toEqual({ status: 'declined', rationale: 'every backlog is small' });
  });

  it('is case-insensitive on a named operation too', async () => {
    const outcome = await adviseTier3(
      answering({ operation: 'Dead_Letter', confidence: 1, rationale: 'the queue is stuck' }),
      REQUEST,
      OPTIONS,
    );

    expect(outcome).toMatchObject({ status: 'advised', proposal: { operation: 'dead_letter' } });
  });

  it('refuses an answer the schema cannot read', async () => {
    const outcome = await adviseTier3(answering({ pick: 'dead_letter' }), REQUEST, OPTIONS);

    expect(outcome.status).toBe('unusable');
  });

  it('refuses an operation that was never a candidate', async () => {
    const outcome = await adviseTier3(
      answering({ operation: 'symbiosis_bridge', rationale: 'the graph looks split' }),
      REQUEST,
      OPTIONS,
    );

    expect(outcome).toMatchObject({ status: 'unusable' });
  });

  it('answers failed when the call runs past its own timeout', async () => {
    const outcome = await adviseTier3(hanging(), REQUEST, { ...OPTIONS, timeoutMs: 5 });

    expect(outcome.status).toBe('failed');
  });

  it('answers failed when the caller aborts, so a shutdown does not wait out the call', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await adviseTier3(hanging(), REQUEST, {
      ...OPTIONS,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(outcome.status).toBe('failed');
  });

  it('names an untried operation as untried rather than leaving its record out', async () => {
    let seen = '';
    const outcome = await adviseTier3(
      {
        generate: (request: StructuredRequest): Promise<unknown> => {
          seen = request.messages.map((message) => message.content).join('\n');
          return Promise.resolve({ operation: TIER3_NO_OPERATION, rationale: 'nothing' });
        },
      },
      REQUEST,
      OPTIONS,
    );

    expect(outcome.status).toBe('declined');
    expect(seen).toContain('dead_letter: relevance 0.180, routine, untried');
  });
});

describe('reviewTier3Proposal', () => {
  it('upholds a recommendation the second pass agrees with', async () => {
    const review = await reviewTier3Proposal(
      answering({ upheld: true, reason: 'the exhausted rows are real' }),
      REQUEST,
      PROPOSAL,
      OPTIONS,
    );

    expect(review).toEqual({ status: 'upheld' });
  });

  it('carries the reason a veto gives', async () => {
    const review = await reviewTier3Proposal(
      answering({ upheld: false, reason: 'nine rows is not a backlog' }),
      REQUEST,
      PROPOSAL,
      OPTIONS,
    );

    expect(review).toEqual({ status: 'vetoed', reason: 'nine rows is not a backlog' });
  });

  it('refuses an answer the schema cannot read', async () => {
    const review = await reviewTier3Proposal(answering({ ok: 'sure' }), REQUEST, PROPOSAL, OPTIONS);

    expect(review.status).toBe('unusable');
  });

  it('answers failed when the call runs past its own timeout', async () => {
    const review = await reviewTier3Proposal(hanging(), REQUEST, PROPOSAL, {
      ...OPTIONS,
      timeoutMs: 5,
    });

    expect(review.status).toBe('failed');
  });
});

describe('modelAdvisor', () => {
  it('answers with the advisor outcome and ships the default the battery pinned', async () => {
    const logger = openLogger({ filePath: '/dev/null', level: 'error' });
    const advisor = modelAdvisor({
      provider: answering({ operation: 'dead_letter', confidence: 0.6, rationale: 'exhausted' }),
      logger,
      config: DEFAULTS,
    });

    const outcome = await advisor(REQUEST);

    expect(outcome).toMatchObject({ status: 'advised' });
    expect(DEFAULT_TIER3_MODE).toBe(DEFAULTS.maintenance.tier3Mode);
  });
});

describe('the sampling both tier 3 calls ask for', () => {
  it('asks for an unsampled answer on the recommendation and on the review of it', async () => {
    const requests: StructuredRequest[] = [];
    const recording: Pick<Provider, 'generate'> = {
      generate: (request: StructuredRequest): Promise<unknown> => {
        requests.push(request);
        return Promise.resolve({ operation: TIER3_NO_OPERATION, upheld: true, reason: 'agreed' });
      },
    };

    await adviseTier3(recording, REQUEST, OPTIONS);
    await reviewTier3Proposal(recording, REQUEST, PROPOSAL, OPTIONS);

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.temperature)).toEqual([0, 0]);
  });
});
