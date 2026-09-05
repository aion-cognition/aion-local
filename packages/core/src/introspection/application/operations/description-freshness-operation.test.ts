import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { descriptionFreshnessOperation } from './description-freshness-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  KEYED as FRESHNESS_KEYED,
  KEYED_MAX_TOKENS,
  LOCAL as FRESHNESS_LOCAL,
  LOCAL_MAX_TOKENS,
} from '../../../prompts/description-freshness.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * What a live graph does with the refreshed description belongs in
 * `description-freshness-operation.int.test.ts`. What is provable here is the shutdown path:
 * the run holds one model call, and the service stops by aborting the context signal.
 *
 * The fake recognises the two read shapes this operation issues and throws on anything else,
 * the same way `proposal-hygiene.test.ts`'s fake does, so a query shape change fails loudly
 * rather than answering something the fake does not model.
 */

const STAGE_TIMEOUT_MS = 2_000;

/** Well under the timeout, and far enough above scheduling noise to mean something. */
const PROMPT_RETURN_MS = 500;

const CONFIG: Config = {
  ...DEFAULTS,
  reflection: { ...DEFAULTS.reflection, stageTimeoutMs: STAGE_TIMEOUT_MS },
};

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function fakeDriver(): Driver {
  const executeQuery = (cypher: string): Promise<unknown> => {
    if (cypher.includes('(ep:Episode)-[:')) {
      return Promise.resolve({
        records: [
          {
            toObject: () => ({
              episode_id: 'episode-1',
              text: 'the pool was resized after the June incident',
              occurred_at: undefined,
            }),
          },
        ],
      });
    }
    if (cypher.includes('MATCH (e:Entity)')) {
      return Promise.resolve({
        records: [
          {
            toObject: () => ({
              id: 'entity-1',
              name: 'connection pool',
              type: 'concept',
              text: 'a Postgres connection pool (concept)',
              mentions: 5,
              baseline: 1,
            }),
          },
        ],
      });
    }
    throw new Error(`the fake driver has no model for this statement:\n${cypher}`);
  };
  return { executeQuery } as unknown as Driver;
}

type HangingProvider = {
  readonly provider: Provider;
  /** Resolves with the request the operation handed `generate`, once the call is under way. */
  readonly started: Promise<StructuredRequest>;
};

/** Never answers on its own: the only way out is the abort the caller composed. */
function hangingProvider(): HangingProvider {
  let announce: (request: StructuredRequest) => void = () => {
    // Replaced synchronously by the promise executor below.
  };
  const started = new Promise<StructuredRequest>((resolve) => {
    announce = resolve;
  });
  const provider: Provider = {
    embed: () => Promise.reject(new Error('this run must not reach the embedder')),
    generate: (request: StructuredRequest): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        announce(request);
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
  return { provider, started };
}

function contextFor(provider: Provider, signal: AbortSignal): OperationContext {
  return {
    driver: fakeDriver(),
    db: undefined as unknown as SqliteHandle,
    config: CONFIG,
    logger: silentLogger(),
    provider,
    health: healthFixture(),
    now: new Date('2026-08-31T00:00:00.000Z'),
    signal,
  };
}

describe('descriptionFreshnessOperation under a shutdown', () => {
  it('carries the context signal into the model call, so a stop does not wait out the timeout', async () => {
    const { provider, started } = hangingProvider();
    const controller = new AbortController();
    const run = descriptionFreshnessOperation().run(contextFor(provider, controller.signal));
    const request = await started;

    controller.abort();
    const reachedTheCall = request.signal?.aborted ?? false;
    const startedAt = Date.now();
    const outcome = await run;
    const elapsedMs = Date.now() - startedAt;

    expect(reachedTheCall).toBe(true);
    expect(elapsedMs).toBeLessThan(PROMPT_RETURN_MS);
    expect(outcome.status).toBe('noop');
  });
});

/** Drives the run as far as the model call, then stops it the way a shutdown would. */
async function requestUnderRoute(route?: Provider['route']): Promise<StructuredRequest> {
  const { provider, started } = hangingProvider();
  const controller = new AbortController();
  const routed: Provider = route === undefined ? provider : { ...provider, route };
  const run = descriptionFreshnessOperation().run(contextFor(routed, controller.signal));
  const request = await started;

  controller.abort();
  await run;
  return request;
}

describe('the text and the budget the route asks under', () => {
  it('asks the local model for the short gloss in the room that gloss needs', async () => {
    const request = await requestUnderRoute({ provider: 'ollama' });

    expect(request.messages[0]?.content).toBe(FRESHNESS_LOCAL);
    expect(request.maxTokens).toBe(LOCAL_MAX_TOKENS);
  });

  it('asks the keyed route for the longer gloss and gives it the room to write one', async () => {
    const request = await requestUnderRoute({ provider: 'anthropic' });

    expect(request.messages[0]?.content).toBe(FRESHNESS_KEYED);
    expect(request.maxTokens).toBe(KEYED_MAX_TOKENS);
  });

  it('reads a provider that states no route as the local one', async () => {
    const request = await requestUnderRoute();

    expect(request.messages[0]?.content).toBe(FRESHNESS_LOCAL);
    expect(request.maxTokens).toBe(LOCAL_MAX_TOKENS);
  });
});

describe('the sampling the description call asks for', () => {
  it('asks for an unsampled answer, so unchanged mentions rewrite nothing', async () => {
    const { provider, started } = hangingProvider();
    const controller = new AbortController();
    const run = descriptionFreshnessOperation().run(contextFor(provider, controller.signal));
    const request = await started;

    controller.abort();
    await run;

    expect(request.temperature).toBe(0);
  });
});
