import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { batchSettlementOperation } from './batch-settlement.js';
import {
  descriptionFreshnessHandler,
  descriptionFreshnessOperation,
} from './description-freshness-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import {
  DESCRIPTION_REFRESH_METHOD,
  DESCRIPTION_REFRESH_METHOD_PROPERTY,
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
import { modelOn } from '../../../infrastructure/providers/routing.js';
import {
  testGenerationConfig,
  testGenerationKey,
} from '../../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { readBatchWork } from '../../../infrastructure/sqlite/batch-work.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { beginSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The description-refresh batch lane against the selected vendor's real batch API.
 *
 * `description-freshness-operation.int.test.ts` scripts the remote. This file does not: the
 * producer writes two requests in the selected provider's shape, `batch_settlement` submits them
 * with that provider's key, and the same operation is run again until the vendor's answers are
 * back and applied. It is how an installation learns that the vendor accepts the bodies the lane
 * sends, which no scripted remote can say.
 *
 * It never runs by default. It spends money and can wait a long time on the vendor:
 * `AION_LIVE_BATCH=1` opts in, `AION_GENERATION_PROVIDER` selects the vendor, and only that
 * vendor's key is read. `AION_LIVE_BATCH_DEADLINE_MS` bounds the wait (an hour by default).
 */

const ENABLED = process.env.AION_LIVE_BATCH === '1' && testGenerationKey() !== '';

const DEADLINE_MS = Number(process.env.AION_LIVE_BATCH_DEADLINE_MS ?? 3_600_000);

const POLL_MS = 30_000;

const EMBED_DIMENSION = DEFAULTS.models.embedDimension;

const SEEDS = [
  {
    name: 'halyard ingest worker',
    gloss: 'a queue worker (service)',
    mentions: [
      'The halyard ingest worker now reads from the Valkey queue instead of polling Postgres.',
      'Priya moved the halyard ingest worker behind the Valkey queue last Tuesday.',
      'The halyard ingest worker drains about 40 jobs a second at peak.',
      'We restarted the halyard ingest worker after the Valkey failover.',
      'The halyard ingest worker writes its checkpoints to the orders database.',
    ],
  },
  {
    name: 'orders connection pool',
    gloss: 'a Postgres connection pool (concept)',
    mentions: [
      'The orders connection pool was resized from 20 to 60 after the June incident.',
      'The orders connection pool is shared by checkout and the halyard ingest worker.',
      'Pool exhaustion on the orders connection pool caused the June checkout outage.',
      'We alert when the orders connection pool passes 80 percent of its slots.',
      'The orders connection pool runs through pgbouncer in transaction mode.',
    ],
  },
] as const;

const config: Config = {
  ...DEFAULTS,
  ...testGenerationConfig(DEFAULTS),
  maintenance: {
    ...DEFAULTS.maintenance,
    descriptionRefreshBatch: 5,
    descriptionRefreshMentionGrowth: 3,
  },
};

/** The embed the handler takes at publication. Every generation goes to the batch API. */
const localEmbedder: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => new Array<number>(EMBED_DIMENSION).fill(0.01))),
  generate: () => Promise.reject(new Error('the batch lane must not reach the synchronous route')),
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
const entityIds: string[] = [];

function contextFor(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: localEmbedder,
    health: healthFixture(),
    now: new Date(),
    signal: new AbortController().signal,
  };
}

async function seedEntity(seed: (typeof SEEDS)[number], prefix: string): Promise<string> {
  const now = new Date();
  const [entity] = await mergeEntities(
    harness.driver,
    [
      {
        name: seed.name,
        nameNorm: seed.name,
        type: 'concept',
        text: seed.gloss,
        sourceEpisodeId: `${prefix}-seed-episode`,
        extractionMethod: 'test-seed',
        confidence: 1,
        occurredAt: now,
      },
    ],
    now,
  );
  const { id } = entity!;
  for (const [index, text] of seed.mentions.entries()) {
    const episodeId = `${prefix}-mention-${String(index)}`;
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: episodeId,
      now,
      properties: { text },
    });
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [id],
      now,
      confidence: 1,
      provenance: ['test-seed'],
    });
  }
  return id;
}

function rows(): { work_key: string; state: string; provider: string; batch_id: string | null }[] {
  return db
    .prepare('SELECT work_key, state, provider, batch_id FROM batch_work ORDER BY work_key')
    .all() as { work_key: string; state: string; provider: string; batch_id: string | null }[];
}

/** What OpenAI still stores for a job, read with the selected key and printed as ids only. */
async function openAiFilesLeft(batchId: string): Promise<readonly string[]> {
  const headers = { authorization: `Bearer ${testGenerationKey()}` };
  const batch = (await (
    await fetch(`https://api.openai.com/v1/batches/${batchId}`, { headers })
  ).json()) as Record<string, unknown>;
  const left: string[] = [];
  for (const field of ['input_file_id', 'output_file_id', 'error_file_id']) {
    const fileId = batch[field];
    if (typeof fileId !== 'string') {
      continue;
    }
    const read = await fetch(`https://api.openai.com/v1/files/${fileId}`, { headers });
    if (read.status !== 404) {
      left.push(`${field}=${fileId} (${String(read.status)})`);
    }
  }
  return left;
}

beforeAll(async () => {
  if (!ENABLED) {
    return;
  }
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-description-freshness-live-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'warn' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  beginSubstratePairing(db, 1);
  for (const [index, seed] of SEEDS.entries()) {
    entityIds.push(await seedEntity(seed, `seed${String(index)}`));
  }
}, 300_000);

afterAll(async () => {
  if (!ENABLED) {
    return;
  }
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('description refresh on the live batch API', () => {
  it(
    'enqueues for the selected provider, submits with its key, and applies the answers it returns',
    async () => {
      const { provider } = config.generation;
      const model = modelOn(config, provider);

      const nominated = await descriptionFreshnessOperation().run(contextFor());
      expect(nominated.itemsAffected).toBe(SEEDS.length);
      expect(rows().every((row) => row.provider === provider && row.state === 'pending')).toBe(
        true,
      );

      // Only the run is exercised here; the scale shapes the relevance alone.
      const settlement = batchSettlementOperation([descriptionFreshnessHandler], { fullWaitMs: 0 });
      const started = Date.now();
      const first = await settlement.run(contextFor());
      console.log(`LIVE BATCH submit on ${provider}:${model}: ${first.detail}`);
      expect(first.detail).toContain(`${String(SEEDS.length)} submitted to ${provider}`);
      const [batchId] = new Set(rows().map((row) => row.batch_id));
      expect(batchId).toEqual(expect.any(String));

      while (
        rows().some((row) => row.state === 'submitted') &&
        Date.now() - started < DEADLINE_MS
      ) {
        await new Promise((resolve) => {
          setTimeout(resolve, POLL_MS);
        });
        const outcome = await settlement.run(contextFor());
        console.log(
          `LIVE BATCH poll +${String(Math.round((Date.now() - started) / 1000))}s: ${outcome.detail}`,
        );
      }

      const settled = rows();
      console.log(`LIVE BATCH rows: ${JSON.stringify(settled)}`);
      expect(settled.every((row) => row.state === 'applied')).toBe(true);

      for (const [index, id] of entityIds.entries()) {
        const entity = await storedEntity(harness.driver, id);
        const props = await nodeProperties(harness.driver, id);
        console.log(`LIVE BATCH refreshed ${SEEDS[index]!.name}: ${entity?.text ?? ''}`);
        expect(entity?.text).not.toBe(SEEDS[index]!.gloss);
        expect(props[DESCRIPTION_REFRESH_METHOD_PROPERTY]).toBe(DESCRIPTION_REFRESH_METHOD);
      }

      const bills = db
        .prepare(
          `SELECT model, pricing_tier, input_tokens, cache_read_tokens, output_tokens
           FROM api_calls ORDER BY request_id`,
        )
        .all() as { model: string; pricing_tier: string }[];
      console.log(`LIVE BATCH bills: ${JSON.stringify(bills)}`);
      expect(bills).toHaveLength(SEEDS.length);
      expect(bills.every((bill) => bill.model.startsWith(model))).toBe(true);
      expect(bills.every((bill) => bill.pricing_tier === 'batch')).toBe(true);

      const spend = db
        .prepare('SELECT reserved_usd, settled_usd, state FROM generation_spend')
        .all() as { reserved_usd: number; settled_usd: number | null; state: string }[];
      console.log(`LIVE BATCH spend: ${JSON.stringify(spend)}`);
      expect(spend.every((row) => row.state === 'settled')).toBe(true);

      if (provider === 'openai') {
        const left = await openAiFilesLeft(String(batchId));
        console.log(`LIVE BATCH files left at OpenAI: ${JSON.stringify(left)}`);
        expect(left).toEqual([]);
      }
      expect(readBatchWork(db, settled[0]!.work_key)?.provider).toBe(provider);
    },
    DEADLINE_MS + 600_000,
  );
});
