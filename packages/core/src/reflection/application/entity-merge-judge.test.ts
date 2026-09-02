import { describe, expect, it } from 'vitest';

import {
  describeEntityMergePair,
  judgeEntityMerge,
  reviewEntityMerge,
  type EntityMergePair,
} from './entity-merge-judge.js';
import type { StructuredRequest } from '../../infrastructure/providers/types.js';

const OPTIONS = { model: 'reflect-model', timeoutMs: 1_000 };

function pair(): EntityMergePair {
  return {
    subject: {
      name: 'Postgres',
      aliases: ['pg'],
      type: 'tool',
      typeCounts: { tool: 3, topic: 1 },
      description: 'Postgres (tool): the relational store this project runs on',
    },
    candidate: {
      name: 'PostgreSQL',
      aliases: [],
      type: 'topic',
      typeCounts: { topic: 2 },
      description: 'PostgreSQL (topic): the relational database',
    },
    facts: [
      'They are named together in 3 of the 5 episodes that mention either.',
      'Their names overlap as character bigrams but do not fold to one string.',
    ],
  };
}

function recorder(answer: unknown): {
  provider: { generate: (request: StructuredRequest) => Promise<unknown> };
  requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  return {
    requests,
    provider: {
      generate: async (request: StructuredRequest) => {
        requests.push(request);
        return answer;
      },
    },
  };
}

describe('describeEntityMergePair', () => {
  it('states both names, both alias lists, both type readings and every tier-2 fact', () => {
    const text = describeEntityMergePair(pair());

    expect(text).toContain('Postgres');
    expect(text).toContain('PostgreSQL');
    expect(text).toContain('pg');
    expect(text).toContain('tool 3');
    expect(text).toContain('topic 2');
    expect(text).toContain('the relational store this project runs on');
    expect(text).toContain('They are named together in 3 of the 5 episodes');
    expect(text).toContain('do not fold to one string');
  });

  it('says a side has no aliases, no description and no counted readings rather than omitting the line', () => {
    const text = describeEntityMergePair({
      subject: { name: 'Aion', aliases: [], type: 'project', typeCounts: {} },
      candidate: { name: 'aion-local', aliases: [], type: 'project', typeCounts: {} },
      facts: [],
    });

    expect(text).toContain('none recorded');
    expect(text).toContain('no evidence');
  });
});

describe('judgeEntityMerge', () => {
  it('asks unsampled and without thinking, and returns the boolean with its rationale', async () => {
    const { provider, requests } = recorder({
      same: true,
      rationale: 'one store under two spellings',
    });

    const outcome = await judgeEntityMerge(provider, pair(), OPTIONS);

    expect(outcome).toEqual({
      status: 'judged',
      judgment: { same: true, rationale: 'one store under two spellings' },
    });
    expect(requests[0]).toMatchObject({ model: 'reflect-model', temperature: 0, think: false });
    expect(requests[0]?.schema).toBeDefined();
  });

  it('carries no confidence off the model, whatever the model volunteers', async () => {
    const { provider } = recorder({ same: true, confidence: 0.97, rationale: 'sure' });

    const outcome = await judgeEntityMerge(provider, pair(), OPTIONS);

    expect(outcome.status).toBe('judged');
    expect(JSON.stringify(outcome)).not.toContain('confidence');
  });

  it('fails on an answer the schema refuses rather than reading a default out of it', async () => {
    const { provider } = recorder({ rationale: 'no verdict here' });

    const outcome = await judgeEntityMerge(provider, pair(), OPTIONS);

    expect(outcome).toEqual({
      status: 'failed',
      detail: 'the judge answered in a shape the schema refuses',
    });
  });

  it('fails with the thrown message rather than throwing at the caller', async () => {
    const provider = {
      generate: async (): Promise<unknown> => {
        throw new Error('model unreachable');
      },
    };

    const outcome = await judgeEntityMerge(provider, pair(), OPTIONS);

    expect(outcome).toMatchObject({ status: 'failed', detail: 'model unreachable' });
  });

  it('does not start a call the caller already aborted', async () => {
    const { provider, requests } = recorder({ same: true });
    const controller = new AbortController();
    controller.abort();

    const outcome = await judgeEntityMerge(provider, pair(), {
      ...OPTIONS,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(requests).toHaveLength(0);
  });
});

describe('reviewEntityMerge', () => {
  it('reads a reviewer finding two referents as a verdict of not the same', async () => {
    const { provider, requests } = recorder({
      different_referent: true,
      reason: 'one is the database, the other is the client library',
    });

    const outcome = await reviewEntityMerge(provider, pair(), OPTIONS);

    expect(outcome).toEqual({
      status: 'reviewed',
      review: { same: false, rationale: 'one is the database, the other is the client library' },
    });
    expect(requests[0]).toMatchObject({ think: false });
  });

  it('reads a reviewer who cannot separate them as agreement', async () => {
    const { provider } = recorder({ different_referent: false, reason: 'nothing separates them' });

    const outcome = await reviewEntityMerge(provider, pair(), OPTIONS);

    expect(outcome).toEqual({
      status: 'reviewed',
      review: { same: true, rationale: 'nothing separates them' },
    });
  });

  it('records a stated verdict with no reason rather than dropping the verdict', async () => {
    const { provider } = recorder({ different_referent: true, reason: '   ' });

    const outcome = await reviewEntityMerge(provider, pair(), OPTIONS);

    expect(outcome).toEqual({
      status: 'reviewed',
      review: { same: false, rationale: 'the reviewer gave no reason' },
    });
  });

  it('withholds the first pass verdict from the reviewer', async () => {
    const { provider, requests } = recorder({ different_referent: false, reason: 'same thing' });

    await reviewEntityMerge(provider, pair(), OPTIONS);

    const prompt = requests[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).not.toContain('rationale');
    expect(prompt).toContain('PostgreSQL');
  });

  it('fails on an answer the schema refuses', async () => {
    const { provider } = recorder({ reason: 'no verdict' });

    const outcome = await reviewEntityMerge(provider, pair(), OPTIONS);

    expect(outcome).toEqual({
      status: 'failed',
      detail: 'the reviewer answered in a shape the schema refuses',
    });
  });
});
