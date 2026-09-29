import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import {
  descriptionFreshnessHandler,
  descriptionFreshnessOperation,
} from './description-freshness-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import {
  forgetNode,
  unforgetNodeInTransaction,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { GraphTransaction, inWriteTransaction } from '../../../infrastructure/graph/connection.js';
import { refreshEntityDescription } from '../../../infrastructure/graph/entity-description-queries.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { lockNodeInTransaction } from '../../../infrastructure/graph/locks.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { writeRedactedProperties } from '../../../infrastructure/graph/redaction-residue-writes.js';
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
    const address = url instanceof Request ? url.url : url.toString();
    if (address.endsWith('/batches')) {
      if (typeof init?.body !== 'string') {
        throw new Error('expected a JSON request body');
      }
      const body = JSON.parse(init.body) as { requests: { custom_id: string }[] };
      if (enforceId && body.requests.some((row) => !/^[a-zA-Z0-9_-]{1,64}$/.test(row.custom_id))) {
        console.log(JSON.stringify({ refusedIds: body.requests.map((row) => row.custom_id) }));
        return new Response('custom_id does not meet the API contract', { status: 400 });
      }
    }
    // Except in the format case, accept the submitted IDs to isolate downstream binding defects.
    if (address.endsWith('/results')) {
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
        processing_status: address.endsWith('/batches') ? 'in_progress' : 'ended',
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

it('reconsiders discarded work when its temporarily forgotten premise is restored', async () => {
  const subject = await seed();
  const ctx = context();
  const item = await nominate(subject.id, ctx);
  const deps = adapter(ctx, api(item, 'An answer that becomes usable again'));
  await submitBatchWork(deps);
  await forgetNode(harness.driver, {
    id: subject.mentions[0]!,
    now: new Date(NOW.getTime() + 1000),
  });
  await consumeBatchWork(deps);
  expect(readBatchWork(store.db, item.workKey)?.state).toBe('discarded');
  await inWriteTransaction(harness.driver, (tx) =>
    unforgetNodeInTransaction(tx, { id: subject.mentions[0]! }),
  );
  expect(await descriptionFreshnessHandler(ctx).isCurrent(store.db, item.revalidation)).toBe(true);
  await descriptionFreshnessOperation().run(ctx);
  const actionable = store.db
    .prepare(
      "SELECT state FROM batch_work WHERE json_extract(revalidation_json, '$.entityId') = ? AND state IN ('pending', 'submitted')",
    )
    .all(subject.id);
  const written = (await storedEntity(harness.driver, subject.id))?.text !== OLD;
  console.log(JSON.stringify({ scenario: 'restored-premise', actionable, written }));
  expect(actionable.length > 0 || written).toBe(true);
}, 60000);

it('rejects a queued answer after its quoted source is rewritten by the redaction writer', async () => {
  const subject = await seed();
  const ctx = context();
  const item = await nominate(subject.id, ctx);
  expect(JSON.stringify(item.request)).toContain(`from ${serial}-0.`);
  const deps = adapter(ctx, api(item, 'A stale reading of text that has been removed'));
  await submitBatchWork(deps);
  await writeRedactedProperties(
    harness.driver,
    [{ id: subject.mentions[0]!, properties: { text: '[redacted source text]' } }],
    new Date(NOW.getTime() + 1000),
  );
  const result = await consumeBatchWork(deps);
  console.log(JSON.stringify({ scenario: 'rewritten-premise', result }));
  expect(result.applied).toBe(0);
  expect((await storedEntity(harness.driver, subject.id))?.text).toBe(OLD);
}, 60000);

it('allows only one writer to replace the same expected description under contention', async () => {
  const subject = await seed();
  const session = harness.driver.session();
  const tx = session.beginTransaction();
  let released = false;
  try {
    await lockNodeInTransaction(new GraphTransaction(tx), subject.id, NOW);
    const options = {
      id: subject.id,
      expectedText: OLD,
      sources: subject.mentions,
      mentionCount: 5,
      now: NOW,
      contentVector: [0.2, 0.4, 0.8],
    };
    const first = refreshEntityDescription(harness.driver, { ...options, text: 'first candidate' });
    const second = refreshEntityDescription(harness.driver, {
      ...options,
      text: 'second candidate',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await tx.commit();
    released = true;
    const outcomes = await Promise.all([first, second]);
    console.log(JSON.stringify({ scenario: 'contended-cas', outcomes }));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  } finally {
    if (!released) {
      await tx.rollback();
    }
    await session.close();
  }
}, 60000);

it('still updates an unchanged request through the batch handler', async () => {
  const subject = await seed();
  const ctx = context();
  const item = await nominate(subject.id, ctx);
  const deps = adapter(ctx, api(item, 'A current updated description'));
  await submitBatchWork(deps);
  const report = await consumeBatchWork(deps);
  expect(report.applied).toBe(1);
  expect((await storedEntity(harness.driver, subject.id))?.text).toBe(
    'A current updated description',
  );
}, 60000);
