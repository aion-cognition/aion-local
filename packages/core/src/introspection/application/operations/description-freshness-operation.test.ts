import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { descriptionFreshnessOperation } from './description-freshness-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
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
