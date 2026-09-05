import { describe, expect, it } from 'vitest';

import { describeVeto, reviewContradiction } from './supersession-review.js';
import type { StructuredRequest } from '../../../infrastructure/providers/types.js';

const PAIR = {
  priorLabel: 'Concept',
  currentLabel: 'Event',
  prior: 'The Foxglove retry policy applies to webhook deliveries.',
  current: 'The Foxglove retry policy was updated to apply to every outbound call.',
  sharedSubject: 'Foxglove retry policy',
};

const OPTIONS = { model: 'test-model', timeoutMs: 5_000 };

function providerReturning(
  answer: unknown,
  route?: { readonly provider: 'ollama' | 'anthropic' },
): {
  readonly generate: (request: StructuredRequest) => Promise<unknown>;
  readonly route?: { readonly provider: 'ollama' | 'anthropic' };
  readonly requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  return {
    requests,
    ...(route === undefined ? {} : { route }),
    generate: async (request: StructuredRequest) => {
      requests.push(request);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
}

describe('the second pass over an affirmative judgment', () => {
  it('affirms when the earlier statement dies and the newer one is a claim', async () => {
    const provider = providerReturning({
      earlier_survives: false,
      newer_is_well_formed: true,
      reason: 'one deployment target, given a different value',
    });

    const outcome = await reviewContradiction(provider, PAIR, OPTIONS);

    expect(outcome).toEqual({ status: 'reviewed', verdict: { outcome: 'unanimous' } });
  });

  it('vetoes on survival and carries the reason back', async () => {
    const provider = providerReturning({
      earlier_survives: true,
      newer_is_well_formed: true,
      reason: 'the narrow case stays true under the wider rule',
    });

    const outcome = await reviewContradiction(provider, PAIR, OPTIONS);

    expect(outcome).toEqual({
      status: 'reviewed',
      verdict: {
        outcome: 'vetoed',
        check: 'survival',
        reason: 'the narrow case stays true under the wider rule',
      },
    });
  });

  /** A statement that asserts nothing cannot make anything false, so the survival answer is moot. */
  it('names well-formedness when both checks fail', async () => {
    const provider = providerReturning({
      earlier_survives: true,
      newer_is_well_formed: false,
      reason: 'the newer statement is a fragment naming two things',
    });

    const outcome = await reviewContradiction(provider, PAIR, OPTIONS);

    expect(outcome).toMatchObject({ verdict: { check: 'well_formedness' } });
  });

  it('still vetoes when the reviewer gives no reason', async () => {
    const provider = providerReturning({ earlier_survives: true, newer_is_well_formed: true });

    const outcome = await reviewContradiction(provider, PAIR, OPTIONS);

    expect(outcome).toMatchObject({
      verdict: { outcome: 'vetoed', check: 'survival', reason: 'the reviewer gave no reason' },
    });
  });

  it('reports a call that threw and one that answered in a shape the schema refuses', async () => {
    const failed = await reviewContradiction(
      providerReturning(new Error('unreachable')),
      PAIR,
      OPTIONS,
    );
    const unusable = await reviewContradiction(
      providerReturning({ verdict: 'survives' }),
      PAIR,
      OPTIONS,
    );

    expect(failed.status).toBe('failed');
    expect(unusable.status).toBe('unusable');
  });

  it('sends both statements, the shared subject, thinking off, and an unsampled answer', async () => {
    const provider = providerReturning({ earlier_survives: false, newer_is_well_formed: true });

    await reviewContradiction(provider, PAIR, OPTIONS);

    const [request] = provider.requests;
    expect(request?.temperature).toBe(0);
    expect(request?.think).toBe(false);
    expect(request?.signal).toBeDefined();
    const prompt = (request?.messages ?? []).map((message) => message.content).join('\n');
    expect(prompt).toContain(PAIR.prior);
    expect(prompt).toContain(PAIR.current);
    expect(prompt).toContain('Both statements name: Foxglove retry policy');
  });

  /**
   * The prompt has to argue the other side, or the second call is the first one twice. These
   * are the four shapes the measured false positives came in.
   */
  it('leads with compatibility and names the shapes an earlier claim survives', async () => {
    const provider = providerReturning(
      { earlier_survives: false, newer_is_well_formed: true },
      { provider: 'anthropic' },
    );

    await reviewContradiction(provider, PAIR, OPTIONS);

    const prompt = (provider.requests[0]?.messages ?? [])
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toContain('is the earlier statement, exactly as written, false now');
    expect(prompt).toContain('the burden is on the replacement');
    expect(prompt).toContain('A record of a position');
    expect(prompt).toContain('widens, extends, or adds');
    expect(prompt).toContain('different attributes of the subject');
    expect(prompt).toContain('garbled extraction');
  });

  /**
   * The local text keeps all four survival rules and asks for the two rival values first: a
   * reviewer that reads the presumption alone answers earlier_survives on every pair it sees.
   */
  it('gives the local route the four rules with the replacement test in front of them', async () => {
    const provider = providerReturning({ earlier_survives: false, newer_is_well_formed: true });

    await reviewContradiction(provider, PAIR, OPTIONS);

    const prompt = (provider.requests[0]?.messages ?? [])
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toContain('is the earlier statement, exactly as written, false now');
    expect(prompt).toContain('name the attribute both statements give a value for');
    expect(prompt).toContain('Then check the four rules');
    expect(prompt).toContain('a record of a position');
    expect(prompt).toContain('widens or adds');
    expect(prompt).toContain('different attributes of the subject');
    expect(prompt).toContain('garbled extraction');
  });

  /**
   * The field order is the reviewer's only chance to reason: with the booleans first it
   * affirmed every closure it was shown, both known false positives included.
   */
  it('asks for the reason before either verdict', () => {
    const provider = providerReturning({ earlier_survives: false, newer_is_well_formed: true });

    void reviewContradiction(provider, PAIR, OPTIONS);

    expect(Object.keys(provider.requests[0]?.schema.properties ?? {})).toEqual([
      'reason',
      'earlier_survives',
      'newer_is_well_formed',
    ]);
  });

  it('describes a verdict in one line for the proposal row', () => {
    expect(describeVeto({ outcome: 'unanimous' })).toBe('unanimous');
    expect(
      describeVeto({ outcome: 'vetoed', check: 'well_formedness', reason: 'a fragment' }),
    ).toBe('vetoed on well_formedness: a fragment');
  });
});
