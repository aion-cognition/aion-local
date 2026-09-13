import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  descriptionFreshnessOperation,
  DESCRIPTION_FRESHNESS_SURFACE,
} from './description-freshness-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { readBatchWork } from '../../../infrastructure/sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { beginSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import {
  KEYED as FRESHNESS_KEYED,
  KEYED_MAX_TOKENS,
  LOCAL as FRESHNESS_LOCAL,
  LOCAL_MAX_TOKENS,
} from '../../../prompts/description-freshness.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * What the operation nominates and what it enqueues. The answer half, and what a live graph does
 * with it, is `description-freshness-operation.int.test.ts`.
 *
 * The run makes no model call at all now: it builds the request the batch lane will send and
 * writes it down. What is provable here is that the request it wrote asks the route's own
 * question, that a repeated nomination costs nothing, and that a shutdown stops it.
 *
 * The fake driver recognises the two read shapes this operation issues and throws on anything
 * else, the same way `proposal-hygiene.test.ts`'s fake does, so a query shape change fails loudly
 * rather than answering something the fake does not model.
 */

const CONFIG: Config = { ...DEFAULTS };

let dir: string;
let store: SqliteStore;
let db: SqliteHandle;

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function fakeDriver(): Driver {
  // Dispatched on the statement's own first line. The population read also names `(ep:Episode)`
  // in an OPTIONAL MATCH, so a substring test answers the entity scan with a mention record.
  const executeQuery = (cypher: string): Promise<unknown> => {
    if (cypher.startsWith('MATCH (ep:Episode)')) {
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
    if (cypher.startsWith('MATCH (e:Entity)')) {
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

/** Neither half is reached: nothing here generates, and the embed happens at publication. */
function unusedProvider(route?: Provider['route']): Provider {
  const provider: Provider = {
    embed: () => Promise.reject(new Error('this run must not reach the embedder')),
    generate: () => Promise.reject(new Error('this run must not reach the model')),
  };
  return route === undefined ? provider : { ...provider, route };
}

function contextFor(provider: Provider, signal: AbortSignal): OperationContext {
  return {
    driver: fakeDriver(),
    db,
    config: CONFIG,
    logger: silentLogger(),
    provider,
    health: healthFixture(),
    now: new Date('2026-08-31T00:00:00.000Z'),
    signal,
  };
}

type EnqueuedRequest = {
  readonly model: string;
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly system: string;
  readonly messages: { readonly role: string; readonly content: string }[];
};

async function nominate(route?: Provider['route']): Promise<EnqueuedRequest | undefined> {
  const outcome = await descriptionFreshnessOperation().run(
    contextFor(unusedProvider(route), new AbortController().signal),
  );
  expect(outcome.itemsAffected).toBe(1);
  const rows = db.prepare('SELECT work_key FROM batch_work').all() as { work_key: string }[];
  return readBatchWork(db, rows[0]?.work_key ?? '')?.request as EnqueuedRequest | undefined;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-description-freshness-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  ({ db } = store);
  beginSubstratePairing(db, 1);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the text and the budget the route asks under', () => {
  it('asks the keyed route for the longer gloss and gives it the room to write one', async () => {
    const request = await nominate({ provider: 'anthropic' });

    expect(request?.system.startsWith(FRESHNESS_KEYED)).toBe(true);
    expect(request?.max_tokens).toBe(KEYED_MAX_TOKENS);
  });

  it('reads a provider that states no route as the local one', async () => {
    const request = await nominate();

    expect(request?.system.startsWith(FRESHNESS_LOCAL)).toBe(true);
    expect(request?.max_tokens).toBe(LOCAL_MAX_TOKENS);
  });
});

describe('the sampling the description call asks for', () => {
  it('asks for an unsampled answer, so unchanged mentions rewrite nothing', async () => {
    const request = await nominate();

    expect(request?.temperature).toBe(0);
  });
});

describe('what the nomination writes down', () => {
  it('records the entity, the gloss and the baseline the request was built against', async () => {
    await nominate();

    const [key] = (
      db.prepare('SELECT work_key FROM batch_work').all() as { work_key: string }[]
    ).map((found) => found.work_key);
    // The entity and the baseline the question was asked at are in the identity itself, with a
    // digest of the gloss behind them: the same question asked again is the same row, and a gloss
    // a correction retired is a different one.
    expect(key?.startsWith(`${DESCRIPTION_FRESHNESS_SURFACE}:entity-1:1:`)).toBe(true);
    const row = readBatchWork(db, key ?? '');
    expect(row?.state).toBe('pending');
    expect(row?.surface).toBe(DESCRIPTION_FRESHNESS_SURFACE);
    expect(row?.revalidation).toEqual({
      entityId: 'entity-1',
      baseline: 1,
      mentions: 5,
      text: 'a Postgres connection pool (concept)',
    });
  });

  it('pays for the same question once however often it is nominated', async () => {
    await nominate();
    const second = await descriptionFreshnessOperation().run(
      contextFor(unusedProvider(), new AbortController().signal),
    );

    expect(second.status).toBe('noop');
    expect(second.itemsAffected).toBe(0);
    expect(db.prepare('SELECT count(*) AS rows FROM batch_work').get()).toEqual({ rows: 1 });
  });

  it('enqueues nothing for a store with no substrate identity', async () => {
    db.prepare('DELETE FROM publication_control').run();

    const outcome = await descriptionFreshnessOperation().run(
      contextFor(unusedProvider(), new AbortController().signal),
    );

    expect(outcome.status).toBe('noop');
    expect(db.prepare('SELECT count(*) AS rows FROM batch_work').get()).toEqual({ rows: 0 });
  });
});

describe('descriptionFreshnessOperation under a shutdown', () => {
  it('stops nominating on the context signal rather than working through the batch', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await descriptionFreshnessOperation().run(
      contextFor(unusedProvider(), controller.signal),
    );

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
    expect(db.prepare('SELECT count(*) AS rows FROM batch_work').get()).toEqual({ rows: 0 });
  });
});
