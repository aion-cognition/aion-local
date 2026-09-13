import { describe, expect, it } from 'vitest';

import { buildBridgeMessages, proposeBridge, type CommunityContext } from './symbiosis-proposal.js';
import type { CommunityProfile } from '../../../infrastructure/graph/community-queries.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import type { CommunityPairScore } from '../../domain/bridge-pairs.js';

const OPTIONS = { model: 'claude-haiku-4-5', timeoutMs: 1_000 };

function profile(community: number): CommunityProfile {
  return { community, size: 10, externalEdges: 0, internalEdges: 10 };
}

const PAIR: CommunityPairScore = {
  left: profile(1),
  right: profile(2),
  coherence: 1,
  sizeBalance: 1,
  overlap: 0,
  isolation: 1,
  score: 1,
};

const CONTEXT: CommunityContext = {
  pair: PAIR,
  leftMembers: [
    { id: 'left-1', label: 'the connection pool ran out of handles' },
    { id: 'left-2', label: 'the nightly export' },
  ],
  rightMembers: [
    { id: 'right-1', label: 'checkout timed out for an hour on the 14th' },
    { id: 'right-2', label: 'a garden bed' },
  ],
};

function answering(answer: unknown): Pick<Provider, 'generate'> {
  return { generate: (): Promise<unknown> => Promise.resolve(answer) };
}

const PROPOSED = {
  decision: 'bridge',
  sourceId: 'left-1',
  targetId: 'right-1',
  sourceRole: 'the cause',
  targetRole: 'the symptom',
  summary: 'The pool exhaustion and the checkout outage are the same incident from two ends.',
  rationale: 'One cluster records the cause and the other records what users saw.',
  premises: ['the connection pool ran out of handles', 'checkout timed out for an hour'],
  compatibility: 0.82,
};

describe('buildBridgeMessages', () => {
  it('offers both community profiles with their members, not two pre-picked nodes', () => {
    const text = buildBridgeMessages(CONTEXT)
      .map((message) => message.content)
      .join('\n');

    expect(text).toContain('left-1: the connection pool ran out of handles');
    expect(text).toContain('right-2: a garden bed');
    expect(text).toContain('Cluster A: 10 memories');
  });

  it('stops forbidding a relation outside two excerpts', () => {
    const system = buildBridgeMessages(CONTEXT)[0]?.content ?? '';

    expect(system).toContain('name the one member of each cluster');
    expect(system).not.toContain('You are given one memory from each cluster');
  });
});

describe('proposeBridge', () => {
  it('reads a well-formed answer as a proposal, endpoints and roles included', async () => {
    const answer = await proposeBridge(answering(PROPOSED), CONTEXT, OPTIONS);

    expect(answer).toMatchObject({
      status: 'proposed',
      proposal: {
        sourceId: 'left-1',
        targetId: 'right-1',
        sourceRole: 'the cause',
        targetRole: 'the symptom',
        compatibility: 0.82,
      },
    });
  });

  it('keeps the premises the answer rested on', async () => {
    const answer = await proposeBridge(answering(PROPOSED), CONTEXT, OPTIONS);

    expect(answer.status === 'proposed' && answer.proposal.premises).toEqual([
      'the connection pool ran out of handles',
      'checkout timed out for an hour',
    ]);
  });

  it('reads a decline as a decline rather than as a broken answer', async () => {
    const answer = await proposeBridge(
      answering({
        decision: 'decline',
        summary: 'These two share nothing.',
        rationale: 'One is a database incident and the other is a garden.',
        compatibility: 0,
      }),
      CONTEXT,
      OPTIONS,
    );

    expect(answer).toEqual({
      status: 'declined',
      reason: 'One is a database incident and the other is a garden.',
    });
  });

  it('refuses an endpoint from neither member list', async () => {
    const answer = await proposeBridge(
      answering({ ...PROPOSED, targetId: 'right-99' }),
      CONTEXT,
      OPTIONS,
    );

    expect(answer).toMatchObject({ status: 'unusable' });
  });

  it('refuses an answer the schema cannot read', async () => {
    const answer = await proposeBridge(
      answering({ caption: 'both about ingest' }),
      CONTEXT,
      OPTIONS,
    );

    expect(answer.status).toBe('unusable');
  });

  it('answers failed when the call runs past its own timeout', async () => {
    const hanging: Pick<Provider, 'generate'> = {
      generate: (request: StructuredRequest): Promise<unknown> =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('the call was aborted'));
            },
            { once: true },
          );
        }),
    };

    const answer = await proposeBridge(hanging, CONTEXT, { ...OPTIONS, timeoutMs: 5 });

    expect(answer.status).toBe('failed');
  });

  it('asks the model to reason, since finding the relation is the work', async () => {
    const requests: StructuredRequest[] = [];
    const recording: Pick<Provider, 'generate'> = {
      generate: (request: StructuredRequest): Promise<unknown> => {
        requests.push(request);
        return Promise.resolve(PROPOSED);
      },
    };

    await proposeBridge(recording, CONTEXT, OPTIONS);

    expect(requests[0]).toMatchObject({ think: true, temperature: 0 });
  });
});
