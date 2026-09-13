import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  descriptionFreshnessHandler,
  descriptionFreshnessOperation,
} from './description-freshness-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import {
  DESCRIPTION_MENTION_COUNT_PROPERTY,
  DESCRIPTION_REFRESHED_AT_PROPERTY,
  DESCRIPTION_REFRESH_METHOD,
  DESCRIPTION_REFRESH_METHOD_PROPERTY,
  PRIOR_DESCRIPTIONS_PROPERTY,
  refreshEntityDescription,
} from '../../../infrastructure/graph/entity-description-queries.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  nodeProperties,
  storedEntity,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import {
  consumeBatchWork,
  submitBatchWork,
  type BatchAdapterDeps,
} from '../../../infrastructure/providers/batch-adapter.js';
import { GenerationSpendGuard } from '../../../infrastructure/providers/spending.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { summarizeApiCalls } from '../../../infrastructure/sqlite/api-usage.js';
import { readBatchWork, type BatchWorkItem } from '../../../infrastructure/sqlite/batch-work.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { beginSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import { readSpendDay } from '../../../infrastructure/sqlite/spend-ledger.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The producer and the consumer, end to end, with the remote injected.
 *
 * This is the whole batch lane against a live graph: the operation nominates stale glosses and
 * writes the requests down, the pump submits them, the store is reopened the way a restart would
 * reopen it, answers come back out of order, and each one is revalidated before it is applied.
 * No batch is sent and no model is called; what is injected is the results file.
 *
 * Mentions are seeded as plain Episode nodes linked directly, not through the full reflection
 * pipeline: the operation reads `MENTIONS` edges and episode text, and neither depends on
 * anything else the pipeline would have written.
 */

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let dbPath: string;
let logger: Logger;
let substrateId: string;
let poolId: string;
let workerId: string;

const NOW = new Date('2026-08-29T12:00:00.000Z');
const POOL_DESCRIPTION = 'a Postgres connection pool (concept)';
const WORKER_DESCRIPTION = 'a queue worker (concept)';
const POOL_REFRESHED = 'a Postgres connection pool, resized after the June incident';
const WORKER_REFRESHED = 'the ingest worker, fed by the Valkey queue Priya moved it behind';
const MENTION_COUNT = 5;
const EMBED_DIMENSION = DEFAULTS.models.embedDimension;

const config: Config = {
  ...DEFAULTS,
  maintenance: {
    ...DEFAULTS.maintenance,
    descriptionRefreshBatch: 5,
    descriptionRefreshMentionGrowth: 3,
  },
};

/** The embed the handler takes at publication. Nothing here generates. */
const localEmbedder: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => new Array<number>(EMBED_DIMENSION).fill(0.01))),
  generate: () => Promise.reject(new Error('the batch lane must not reach the Messages route')),
};

async function seedEntity(name: string, description: string, prefix: string): Promise<string> {
  const [entity] = await mergeEntities(
    harness.driver,
    [
      {
        name,
        nameNorm: name,
        type: 'concept',
        text: description,
        sourceEpisodeId: `${prefix}-seed-episode`,
        extractionMethod: 'test-seed',
        confidence: 1,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  const { id } = entity!;
  for (let index = 0; index < MENTION_COUNT; index += 1) {
    const episodeId = `${prefix}-mention-${String(index)}`;
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: episodeId,
      now: NOW,
      properties: { text: `mention ${String(index)} of the ${name}` },
    });
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [id],
      now: NOW,
      confidence: 1,
      provenance: ['test-seed'],
    });
  }
  return id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-description-freshness-int-'));
  dbPath = join(dataDir, 'aion.sqlite');
  db = openSqliteHandle({ filePath: dbPath });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  ({ substrateId } = beginSubstratePairing(db, 1));
  poolId = await seedEntity('connection pool', POOL_DESCRIPTION, 'pool');
  workerId = await seedEntity('ingest worker', WORKER_DESCRIPTION, 'worker');
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function contextFor(handle: SqliteHandle = db): OperationContext {
  return {
    driver: harness.driver,
    db: handle,
    config,
    logger,
    provider: localEmbedder,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

/** One succeeded line of a results file, with the usage the remote reports beside it. */
function answer(workKey: string, description: string): Record<string, unknown> {
  return {
    custom_id: workKey,
    result: {
      type: 'succeeded',
      message: {
        id: `message-${workKey}`,
        model: DEFAULTS.anthropic.model,
        content: [{ type: 'text', text: JSON.stringify({ description }) }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  };
}

/** The three batch endpoints, from a script. Nothing leaves the machine. */
function batchApi(results: readonly Record<string, unknown>[]): typeof fetch {
  const impl = (url: string | URL): Promise<Response> => {
    const target = String(url);
    if (target.endsWith('/results')) {
      return Promise.resolve(new Response(results.map((line) => JSON.stringify(line)).join('\n')));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msgbatch_freshness',
          processing_status: target.endsWith('/batches') ? 'in_progress' : 'ended',
          results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_freshness/results',
        }),
      ),
    );
  };
  return impl as unknown as typeof fetch;
}

function adapterDeps(handle: SqliteHandle, fetchImpl: typeof fetch): BatchAdapterDeps {
  return {
    db: handle,
    substrateId,
    client: { apiKey: 'injected-test-key', fetchImpl },
    handlers: [descriptionFreshnessHandler(contextFor(handle))],
    logger,
    spending: new GenerationSpendGuard({
      db: handle,
      ceilingUsd: config.anthropic.dailyCeilingUsd,
    }),
    now: () => NOW,
  };
}

/** The mentions a prompt about this entity quotes, most recent first, as the producer selects them. */
function sourcesFor(prefix: string): string[] {
  return Array.from({ length: MENTION_COUNT }, (_, index) => `${prefix}-mention-${String(index)}`);
}

/**
 * The remote id is a digest, so the entity it is about is read from the durable key the row
 * carries rather than from the id itself.
 */
function keyFor(handle: SqliteHandle, entityId: string): string {
  const row = handle
    .prepare('SELECT work_key FROM batch_work WHERE durable_key LIKE ?')
    .get(`%:${entityId}:%`) as { work_key: string } | undefined;
  if (row === undefined) {
    throw new Error(`no batch work was enqueued for ${entityId}`);
  }
  return row.work_key;
}

describe('description freshness on the batch lane', () => {
  it('nominates the stale glosses and writes their requests down', async () => {
    const outcome = await descriptionFreshnessOperation().run(contextFor());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(2);
    expect(outcome.itemsAffected).toBe(2);

    const row = readBatchWork(db, keyFor(db, poolId));
    expect(row?.state).toBe('pending');
    // The request carries the gloss it was built against, which is what the model is asked to
    // revise rather than to invent.
    expect(JSON.stringify(row?.request)).toContain(POOL_DESCRIPTION);
    // Nothing is refreshed by asking. The entity still says what it said.
    const entity = await storedEntity(harness.driver, poolId);
    expect(entity?.text).toBe(POOL_DESCRIPTION);
  }, 120_000);

  it('submits the work and completes nothing by submitting it', async () => {
    const report = await submitBatchWork(adapterDeps(db, batchApi([])));

    expect(report.submitted).toBe(2);
    expect(readBatchWork(db, keyFor(db, poolId))?.state).toBe('submitted');
    expect((await storedEntity(harness.driver, poolId))?.text).toBe(POOL_DESCRIPTION);
    // The submission committed its conservative maximum against the day before it was sent.
    expect(readSpendDay(db, NOW).inFlight).toBe(1);
  }, 120_000);

  it('applies shuffled answers to the right entities across a restart, and refuses a stale one', async () => {
    // The gloss the worker request was built against is rewritten under it, the way another pass
    // or a correction would. Its answer is then about a question nobody is asking.
    const moved = await refreshEntityDescription(harness.driver, {
      id: workerId,
      text: 'a gloss something else wrote while the batch was out',
      contentVector: new Array<number>(EMBED_DIMENSION).fill(0.02),
      mentionCount: MENTION_COUNT,
      now: NOW,
    });
    expect(moved).toBe(true);

    // The restart: the process that submitted is gone, and everything the next one needs is a
    // row. Nothing is carried over in memory.
    const reopened = openSqliteHandle({ filePath: dbPath });
    try {
      const poolKey = keyFor(reopened, poolId);
      const workerKey = keyFor(reopened, workerId);
      expect(readBatchWork(reopened, poolKey)?.state).toBe('submitted');

      // Reverse order, because the API answers in whatever order it finished.
      const report = await consumeBatchWork(
        adapterDeps(
          reopened,
          batchApi([answer(workerKey, WORKER_REFRESHED), answer(poolKey, POOL_REFRESHED)]),
        ),
      );

      expect(report).toMatchObject({ applied: 1, discarded: 1, returned: 0, failed: 0 });
      expect(readBatchWork(reopened, poolKey)?.state).toBe('applied');
      expect(readBatchWork(reopened, workerKey)?.state).toBe('discarded');

      const pool = await storedEntity(harness.driver, poolId);
      expect(pool?.text).toBe(POOL_REFRESHED);
      expect(pool?.contentVectorLength).toBe(EMBED_DIMENSION);
      const props = await nodeProperties(harness.driver, poolId);
      expect(props[PRIOR_DESCRIPTIONS_PROPERTY]).toEqual([POOL_DESCRIPTION]);
      expect(Number(props[DESCRIPTION_MENTION_COUNT_PROPERTY])).toBe(MENTION_COUNT);
      expect(props[DESCRIPTION_REFRESH_METHOD_PROPERTY]).toBe(DESCRIPTION_REFRESH_METHOD);
      expect(props[DESCRIPTION_REFRESHED_AT_PROPERTY]).toBeDefined();

      // The entity whose question moved kept the gloss that displaced it.
      const worker = await storedEntity(harness.driver, workerId);
      expect(worker?.text).toBe('a gloss something else wrote while the batch was out');
    } finally {
      reopened.close();
    }
  }, 120_000);

  it('publishes once however often the answers are consumed, and bills both of them once', async () => {
    const poolKey = keyFor(db, poolId);
    const workerKey = keyFor(db, workerId);

    const report = await consumeBatchWork(
      adapterDeps(
        db,
        batchApi([
          answer(poolKey, 'a second rewrite nobody asked for'),
          answer(workerKey, 'and another'),
        ]),
      ),
    );

    // Nothing of this batch is outstanding any more, so the re-poll reads nothing and applies
    // nothing. The gloss the first pass wrote stands.
    expect(report).toMatchObject({ applied: 0, discarded: 0, returned: 0 });
    expect((await storedEntity(harness.driver, poolId))?.text).toBe(POOL_REFRESHED);
    expect(await nodeProperties(harness.driver, poolId)).toMatchObject({
      [PRIOR_DESCRIPTIONS_PROPERTY]: [POOL_DESCRIPTION],
    });

    // Paid is paid, and paid once: the applied answer and the stale one are both on the bill,
    // each exactly once, at the batch rate.
    const bill = summarizeApiCalls(
      db,
      new Date('2026-08-29T00:00:00.000Z'),
      new Date('2026-08-30T00:00:00.000Z'),
    );
    const batched = bill.surfaces.filter((row) => row.pricingTier === 'batch');
    expect(batched.reduce((total, row) => total + row.calls, 0)).toBe(2);
    expect(batched.reduce((total, row) => total + row.inputTokens, 0)).toBe(200);
    // The submission's conservative hold is replaced by what the answers cost, not added to it:
    // two answers at 100 input and 20 output on Haiku 4.5, halved for the batch rate, is
    // (100 × $1 + 20 × $5) ÷ 1e6 × 0.5 × 2 = $0.0002.
    const day = readSpendDay(db, NOW);
    expect(day.inFlight).toBe(0);
    expect(day.committedUsd).toBeCloseTo(0.0002, 8);
  }, 120_000);

  it('leaves a refreshed entity alone on the next nomination', async () => {
    const outcome = await descriptionFreshnessOperation().run(contextFor());

    expect(outcome.itemsProcessed).toBe(0);
    expect(outcome.itemsAffected).toBe(0);
  }, 60_000);

  it('does nothing at all with AION_MAINTENANCE_DESCRIPTION_FRESHNESS off', async () => {
    const off: Config = {
      ...config,
      maintenance: { ...config.maintenance, descriptionFreshness: false },
    };
    const outcome = await descriptionFreshnessOperation().run({ ...contextFor(), config: off });

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail:
        'description freshness disabled by AION_MAINTENANCE_DESCRIPTION_FRESHNESS; no entity examined',
    });
  }, 60_000);
});

/**
 * What the handler refuses, one reason at a time. Each of these is a way the substrate can move
 * between the question and the answer, and the answer is discarded rather than applied.
 */
describe('what the publication revalidates', () => {
  const handler = (): ReturnType<typeof descriptionFreshnessHandler> =>
    descriptionFreshnessHandler(contextFor());

  it('refuses an answer whose revalidation record it cannot read', async () => {
    expect(await handler().isCurrent(db, { entityId: poolId })).toBe(false);
  }, 60_000);

  it('refuses an answer about an entity the store no longer holds', async () => {
    expect(
      await handler().isCurrent(db, {
        entityId: 'an-entity-that-was-never-minted',
        baseline: 1,
        mentions: 5,
        text: POOL_DESCRIPTION,
        sources: sourcesFor('pool'),
      }),
    ).toBe(false);
  }, 60_000);

  it('accepts an answer about the gloss and baseline the entity still carries', async () => {
    expect(
      await handler().isCurrent(db, {
        entityId: poolId,
        baseline: MENTION_COUNT,
        mentions: MENTION_COUNT,
        text: POOL_REFRESHED,
        sources: sourcesFor('pool'),
      }),
    ).toBe(true);
  }, 60_000);

  it('refuses an answer resting on a source that has gone, however many mentions remain', async () => {
    expect(
      await handler().isCurrent(db, {
        entityId: poolId,
        baseline: MENTION_COUNT,
        mentions: MENTION_COUNT,
        text: POOL_REFRESHED,
        // Four of the five the prompt quoted, and one episode that never mentioned this entity.
        sources: [...sourcesFor('pool').slice(1), 'worker-mention-0'],
      }),
    ).toBe(false);
  }, 60_000);

  it('leaves the work owed when the guarded write matches no current entity', async () => {
    const item = {
      workKey: 'df-0000',
      revalidation: {
        entityId: 'an-entity-that-was-never-minted',
        baseline: 1,
        mentions: 5,
        text: POOL_DESCRIPTION,
        sources: sourcesFor('pool'),
      },
    } as unknown as BatchWorkItem;

    await expect(
      handler().apply(item, { description: 'a rewrite with nowhere to land' }),
    ).rejects.toThrow('moved under its answer');
  }, 60_000);

  it('leaves the work owed when the gloss moved while the answer was being embedded', async () => {
    const item = {
      workKey: 'df-0001',
      revalidation: {
        entityId: poolId,
        baseline: MENTION_COUNT,
        mentions: MENTION_COUNT,
        // The gloss this answer revised. The entity says POOL_REFRESHED by now.
        text: POOL_DESCRIPTION,
        sources: sourcesFor('pool'),
      },
    } as unknown as BatchWorkItem;

    await expect(
      handler().apply(item, { description: 'a rewrite of a gloss nothing carries' }),
    ).rejects.toThrow('moved under its answer');
    expect((await storedEntity(harness.driver, poolId))?.text).toBe(POOL_REFRESHED);
  }, 60_000);
});
