import { describe, expect, it } from 'vitest';

import { judgeHygienePair, type HygienePair } from './proposal-hygiene-judge.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';

const PAIR: HygienePair = {
  leftName: 'Ledger Cache',
  leftType: 'tool',
  rightName: 'Ledger Store',
  rightType: 'concept',
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

describe('judgeHygienePair', () => {
  it('reads a same verdict and its reason', async () => {
    const verdict = await judgeHygienePair(
      answering({ verdict: 'same', reason: 'both name the caching layer' }),
      PAIR,
      OPTIONS,
    );

    expect(verdict).toEqual({ status: 'same', reason: 'both name the caching layer' });
  });

  it('reads a distinct verdict and its reason', async () => {
    const verdict = await judgeHygienePair(
      answering({ verdict: 'distinct', reason: 'one is the tool, one is the data it holds' }),
      PAIR,
      OPTIONS,
    );

    expect(verdict).toEqual({
      status: 'distinct',
      reason: 'one is the tool, one is the data it holds',
    });
  });

  it('falls back to a stock reason when the model gives none', async () => {
    const verdict = await judgeHygienePair(answering({ verdict: 'distinct' }), PAIR, OPTIONS);

    expect(verdict).toEqual({ status: 'distinct', reason: 'the judge gave no reason' });
  });

  it('is case-insensitive on the verdict word', async () => {
    const verdict = await judgeHygienePair(answering({ verdict: 'Same' }), PAIR, OPTIONS);

    expect(verdict.status).toBe('same');
  });

  it('is unusable on a verdict outside the vocabulary', async () => {
    const verdict = await judgeHygienePair(answering({ verdict: 'maybe' }), PAIR, OPTIONS);

    expect(verdict.status).toBe('unusable');
  });

  it('is unusable on an answer the schema cannot read', async () => {
    const verdict = await judgeHygienePair(answering({ ok: true }), PAIR, OPTIONS);

    expect(verdict.status).toBe('unusable');
  });

  it('fails when the call runs past its own timeout', async () => {
    const verdict = await judgeHygienePair(hanging(), PAIR, { ...OPTIONS, timeoutMs: 5 });

    expect(verdict.status).toBe('failed');
  });

  it('fails when the caller aborts, so a shutdown does not wait out the call', async () => {
    const controller = new AbortController();
    controller.abort();

    const verdict = await judgeHygienePair(hanging(), PAIR, {
      ...OPTIONS,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(verdict.status).toBe('failed');
  });

  it('fails when the provider rejects', async () => {
    const verdict = await judgeHygienePair(
      { generate: () => Promise.reject(new Error('model unavailable')) },
      PAIR,
      OPTIONS,
    );

    expect(verdict).toEqual({ status: 'failed', reason: 'model unavailable' });
  });
});
