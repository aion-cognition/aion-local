import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import {
  descriptionFreshnessHandler,
  descriptionFreshnessOperation,
} from './description-freshness-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { forgetNode, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { refreshEntityDescription } from '../../../infrastructure/graph/entity-description-queries.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { storedEntity } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
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
import type { Provider } from '../../../infrastructure/providers/types.js';
import {
  pendingBatchWork,
  readBatchWork,
  type BatchWorkItem,
} from '../../../infrastructure/sqlite/batch-work.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { beginSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

const NOW = new Date('2026-09-13T10:00:00Z');
const OLD = 'A database pool';
let harness: Neo4jHarness;
let store: SqliteStore;
let dir: string;
let logger: Logger;
let substrateId: string;
let serial = 0;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dir = mkdtempSync(join(tmpdir(), 'aion-D2-description-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  logger = openLogger({ filePath: join(dir, 'test.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, store.db, { embedDimension: 3 });
  ({ substrateId } = beginSubstratePairing(store.db, 1));
}, 120000);
afterEach(() => {
  store.db.prepare('DELETE FROM batch_work').run();
});
afterAll(async () => {
  store.close();
  await stopNeo4jHarness(harness);
  rmSync(dir, { recursive: true, force: true });
});

async function mention(entityId: string, suffix: string): Promise<string> {
  const id = `review-mention-${suffix}`;
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: `New evidence about ${entityId}, from ${suffix}.` },
  });
  await linkEntityMentions(harness.driver, {
    episodeId: id,
    entityIds: [entityId],
    now: NOW,
    confidence: 1,
    provenance: ['review'],
  });
  return id;
}
async function seed(): Promise<{ id: string; mentions: string[] }> {
  serial += 1;
  const [entity] = await mergeEntities(
    harness.driver,
    [
      {
        name: `review-pool-${serial}`,
        nameNorm: `review-pool-${serial}`,
        type: 'concept',
        text: OLD,
        sourceEpisodeId: `origin-${serial}`,
        extractionMethod: 'review',
        confidence: 1,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  if (entity === undefined) {
    throw new Error('entity missing');
  }
  const mentions: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    mentions.push(await mention(entity.id, `${serial}-${i}`));
  }
  return { id: entity.id, mentions };
}
function context(beforeEmbed?: () => Promise<void>): OperationContext {
  const provider: Provider = {
    embed: async (texts) => {
      await beforeEmbed?.();
      return texts.map(() => [0.2, 0.4, 0.8]);
    },
    generate: async () => {
      throw new Error('must use batch');
    },
  };
  return {
    driver: harness.driver,
    db: store.db,
    logger,
    provider,
    now: NOW,
    config: {
      ...DEFAULTS,
      maintenance: {
        ...DEFAULTS.maintenance,
        descriptionRefreshBatch: 100,
        descriptionRefreshMentionGrowth: 3,
      },
    },
    health: healthFixture(),
    signal: new AbortController().signal,
  };
}
async function nominate(id: string, ctx = context()): Promise<BatchWorkItem> {
  await descriptionFreshnessOperation().run(ctx);
  const item = pendingBatchWork(store.db, substrateId, 100).find(
    (row) => (row.revalidation as { entityId?: string }).entityId === id,
  );
  if (item === undefined) {
    throw new Error('the entity was not nominated');
  }
  return item;
}
function api(item: BatchWorkItem, description: string, enforceId = false): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith('/batches')) {
      const body = JSON.parse(String(init?.body)) as { requests: { custom_id: string }[] };
      if (enforceId && body.requests.some((row) => !/^[a-zA-Z0-9_-]{1,64}$/.test(row.custom_id))) {
        console.log(JSON.stringify({ refusedIds: body.requests.map((row) => row.custom_id) }));
        return new Response('custom_id does not meet the API contract', { status: 400 });
      }
    }
    // Except in the format case, accept the submitted IDs to isolate downstream binding defects.
    if (String(url).endsWith('/results')) {
      return new Response(
        JSON.stringify({
          custom_id: item.workKey,
          result: {
            type: 'succeeded',
            message: {
              model: DEFAULTS.anthropic.model,
              content: [{ type: 'text', text: JSON.stringify({ description }) }],
              usage: { input_tokens: 100, output_tokens: 20 },
            },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        id: `batch-${serial}`,
        processing_status: String(url).endsWith('/batches') ? 'in_progress' : 'ended',
        results_url: `https://api.anthropic.com/v1/messages/batches/batch-${serial}/results`,
      }),
    );
  };
}
function adapter(ctx: OperationContext, fetchImpl: typeof fetch): BatchAdapterDeps {
  return {
    db: store.db,
    substrateId,
    logger,
    handlers: [descriptionFreshnessHandler(ctx)],
    client: { apiKey: 'injected', fetchImpl },
    now: () => NOW,
  };
}

it('submits producer identities that the batch API accepts', async () => {
  const subject = await seed();
  const ctx = context();
  const item = await nominate(subject.id, ctx);
  const outcome = await submitBatchWork(adapter(ctx, api(item, 'An updated pool', true)));
  expect(outcome.submitted).toBeGreaterThan(0);
}, 60000);

it('does not apply a response grounded in a source forgotten while the batch was out', async () => {
  const subject = await seed();
  const ctx = context();
  const item = await nominate(subject.id, ctx);
  const deps = adapter(ctx, api(item, 'A description using the now-forgotten evidence'));
  await submitBatchWork(deps);
  await forgetNode(harness.driver, {
    id: subject.mentions[0]!,
    now: new Date(NOW.getTime() + 1000),
  });
  const result = await consumeBatchWork(deps);
  const text = (await storedEntity(harness.driver, subject.id))?.text;
  console.log(JSON.stringify({ scenario: 'forgotten-grounding', result, text }));
  expect(result.applied).toBe(0);
  expect(text).toBe(OLD);
}, 60000);

it('does not overwrite a newer description committed during the embedding wait', async () => {
  const subject = await seed();
  let moved = false;
  const ctx = context(async () => {
    if (moved) {
      return;
    }
    moved = true;
    await refreshEntityDescription(harness.driver, {
      id: subject.id,
      text: 'A newer committed description',
      contentVector: [0.1, 0.3, 0.9],
      mentionCount: 5,
      now: new Date(NOW.getTime() + 1000),
    });
  });
  const item = await nominate(subject.id, ctx);
  const deps = adapter(ctx, api(item, 'The stale batch answer'));
  await submitBatchWork(deps);
  await consumeBatchWork(deps);
  expect(moved).toBe(true);
  const text = (await storedEntity(harness.driver, subject.id))?.text;
  console.log(JSON.stringify({ scenario: 'post-validation-movement', text }));
  expect(text).toBe('A newer committed description');
}, 60000);

it('asks again after new evidence arrives following a no-change answer', async () => {
  const subject = await seed();
  const ctx = context();
  const item = await nominate(subject.id, ctx);
  const deps = adapter(ctx, api(item, OLD));
  await submitBatchWork(deps);
  await consumeBatchWork(deps);
  expect(readBatchWork(store.db, item.workKey)?.state).toBe('applied');
  for (let i = 0; i < 3; i += 1) {
    await mention(subject.id, `${serial}-new-${i}`);
  }
  await descriptionFreshnessOperation().run(ctx);
  const next = pendingBatchWork(store.db, substrateId, 100).filter(
    (row) => (row.revalidation as { entityId?: string }).entityId === subject.id,
  );
  console.log(JSON.stringify({ scenario: 'new-evidence-after-no-change', next }));
  expect(next).toHaveLength(1);
}, 60000);

it('still applies and bills an unchanged, readable request once', async () => {
  const subject = await seed();
  const ctx = context();
  const item = await nominate(subject.id, ctx);
  const deps = adapter(ctx, api(item, 'The useful updated description'));
  await submitBatchWork(deps);
  await consumeBatchWork(deps);
  await consumeBatchWork(deps);
  expect((await storedEntity(harness.driver, subject.id))?.text).toBe(
    'The useful updated description',
  );
  const bill = store.db
    .prepare('SELECT count(*) AS n FROM api_calls WHERE request_id = ?')
    .get(`batch-${serial}:${item.workKey}`) as { n: number };
  expect(bill.n).toBe(1);
}, 60000);
