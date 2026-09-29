import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_OPENAI_MODEL, OpenAiProvider } from './openai-provider.js';
import {
  openCampaignProducer,
  type CampaignProducerHandle,
} from './test-support/campaign-guard.js';
import { testGenerationKey, testRoutesToOpenAi } from './test-support/generation-provider.js';
import {
  judgeEntityMerge,
  type EntityMergePair,
} from '../../reflection/application/entity-merge-judge.js';
import { DEFAULTS } from '../config/defaults.js';

/**
 * What the OpenAI route's cache policy does on the live API, for an operator to read rather than
 * for an ordinary run: two entity judgments sent exactly as the service sends them, and the usage
 * each answer reports. The body asks for explicit caching with no breakpoint, which the prompt
 * caching guide says writes nothing, so every answer should report no cache-write tokens.
 *
 * Opt-in on top of the key, because it spends money and nothing else in the suite needs it:
 * `AION_OPENAI_CACHE_CHECK=1` with `AION_GENERATION_PROVIDER=openai` and `AION_OPENAI_API_KEY`.
 */

const ENABLED =
  process.env.AION_OPENAI_CACHE_CHECK === '1' && testRoutesToOpenAi() && testGenerationKey() !== '';

const MODEL = process.env.AION_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;

type Reported = {
  readonly promptCacheOptions: unknown;
  readonly usage: unknown;
};

const PAIRS: readonly EntityMergePair[] = [
  {
    subject: { name: 'neo4j', aliases: [], type: 'tool', typeCounts: { tool: 4 } },
    candidate: { name: 'neo4j aura', aliases: [], type: 'tool', typeCounts: { tool: 1 } },
    facts: ['The two share 2 of 9 episodes.', 'Their names share the token "neo4j".'],
  },
  {
    subject: { name: 'ollama', aliases: [], type: 'tool', typeCounts: { tool: 6 } },
    candidate: { name: 'ollama server', aliases: [], type: 'tool', typeCounts: { tool: 2 } },
    facts: ['The two share 3 of 11 episodes.', 'Their names share the token "ollama".'],
  },
];

let campaignProducer: CampaignProducerHandle | undefined;

afterAll(() => {
  campaignProducer?.close();
});

describe.skipIf(!ENABLED)('the OpenAI cache policy against the live API', () => {
  it('reports no cache writes on two judgments sent the way the service sends them', async () => {
    campaignProducer = openCampaignProducer({
      experiment: 'openai-cache',
      ceilingUsd: DEFAULTS.anthropic.dailyCeilingUsd,
    });
    campaignProducer.beginCase('explicit-no-breakpoint');
    const reported: Reported[] = [];
    // The raw usage block rather than the recorded call, so the fields the operator reads are
    // the API's own names and nothing this program derived from them. Only answers are read: a
    // throttled or failed attempt bills nothing and its body need not be JSON.
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!response.ok) {
        return response;
      }
      const body = (await response.clone().json()) as { usage?: unknown };
      // The provider always sends its body as a JSON string.
      const sent = JSON.parse(init?.body as string) as { prompt_cache_options?: unknown };
      reported.push({ promptCacheOptions: sent.prompt_cache_options, usage: body.usage });
      return response;
    };
    const provider = new OpenAiProvider({
      apiKey: testGenerationKey(),
      model: MODEL,
      fetchImpl,
      spending: campaignProducer.guard,
      recordApiCall: campaignProducer.recordApiCall,
    });

    for (const pair of PAIRS) {
      const outcome = await judgeEntityMerge(provider, pair, { model: MODEL, timeoutMs: 60_000 });
      expect(outcome).toMatchObject({ status: 'judged' });
    }

    for (const [index, entry] of reported.entries()) {
      console.log(
        `openai cache check ${String(index + 1)}: prompt_cache_options ` +
          `${JSON.stringify(entry.promptCacheOptions)} usage ${JSON.stringify(entry.usage)}`,
      );
    }
    // At least one answer per pair; a judgment whose first answer would not parse is asked again
    // in JSON mode, and that answer is billed and reported too.
    expect(reported.length).toBeGreaterThanOrEqual(PAIRS.length);
    for (const entry of reported) {
      expect(entry.promptCacheOptions).toEqual({ mode: 'explicit' });
      const usage = entry.usage as
        { input_tokens_details?: { cache_write_tokens?: number } } | undefined;
      // An answer with no usage block says nothing about writes, so it cannot pass as zero.
      expect(usage).toBeDefined();
      expect(usage?.input_tokens_details?.cache_write_tokens ?? 0).toBe(0);
    }
  }, 180_000);
});
