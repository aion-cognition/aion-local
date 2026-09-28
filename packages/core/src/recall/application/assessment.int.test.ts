import { describe, expect, it } from 'vitest';

import { RECALL_ASSESSMENT_SURFACE } from './assessment.js';
import { handleRecall, type RecallDeps } from './recall.js';
import {
  config,
  deps,
  provider,
  QUERY,
  READ_SESSION,
  RECALLED_AT,
  WEBHOOKS_OBSERVATION,
  webhooksEpisodeId,
} from './test-support/recall-int.fixture.js';
import type { StructuredRequest } from '../../infrastructure/providers/types.js';

/**
 * The default recall mode over a substrate written by the real intake path: retrieval on the
 * query, the evidence read, and one assessment call whose answer decides the pack. The assessor
 * is scripted, because what this proves is the wiring on a real graph, never the model.
 */

function assessing(answer: (request: StructuredRequest) => Promise<unknown>): {
  readonly deps: RecallDeps;
  readonly requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  return {
    requests,
    deps: {
      ...deps,
      config: { ...config(), recall: { ...config().recall, mode: 'assess' } },
      provider: {
        embed: (texts) => provider.embed(texts),
        generate: (request) => {
          requests.push(request);
          return answer(request);
        },
      },
    },
  };
}

/** The number the assessment prompt gave the candidate holding this text. */
function numberOf(request: StructuredRequest, text: string): number {
  const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
  const line = user.split('\n').find((row) => row.includes(text));
  return Number(/^(\d+)\./.exec(line ?? '')?.[1] ?? Number.NaN);
}

function recall(run: RecallDeps) {
  return handleRecall(run, { query: QUERY }, { identity: READ_SESSION, now: RECALLED_AT });
}

describe('recall in the assess mode, over a real graph', () => {
  it('shows the model what retrieval found and serves the memory it chose', async () => {
    const run = assessing((request) =>
      Promise.resolve({ selected: [numberOf(request, WEBHOOKS_OBSERVATION)] }),
    );

    const pack = await recall(run.deps);

    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]?.surface).toBe(RECALL_ASSESSMENT_SURFACE);
    expect(pack.episodes?.map((item) => item.id)).toContain(webhooksEpisodeId);
    expect(pack.metadata.assessment).toMatchObject({ outcome: 'selected' });
    expect(pack.metadata.degraded).toBeUndefined();
    expect(pack.metadata.cues).toEqual([{ text: QUERY, source: 'raw_query', weight: 3 }]);
  });

  it('serves nothing when the model chose nothing, without calling it an outage', async () => {
    const run = assessing(() => Promise.resolve({ selected: [] }));

    const pack = await recall(run.deps);

    expect(pack.episodes).toBeUndefined();
    expect(pack.facts).toBeUndefined();
    expect(pack.metadata.degraded).toBeUndefined();
    expect(pack.rendered_text).toContain('judged none of them useful here');
  });

  it('serves the ranking and names the failure when the call produces nothing usable', async () => {
    const run = assessing(() => Promise.resolve({ query_cues: ['webhooks'] }));

    const pack = await recall(run.deps);

    expect(pack.episodes?.map((item) => item.id)).toContain(webhooksEpisodeId);
    expect(pack.metadata.degraded).toEqual([{ stage: 'assessment', reason: 'invalid_output' }]);
    expect(pack.metadata.assessment?.outcome).toBe('fallback');
  });
});
