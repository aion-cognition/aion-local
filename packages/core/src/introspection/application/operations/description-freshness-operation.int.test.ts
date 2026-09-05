import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { descriptionFreshnessOperation } from './description-freshness-operation.js';
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
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../../infrastructure/providers/test-support/generation-provider.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Mentions are seeded as plain Episode nodes linked directly, not through the full reflection
 * pipeline: the operation reads `MENTIONS` edges and episode text, and neither depends on
 * anything else the pipeline would have written.
 */

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let entityId: string;

/**
 * The keyed text is the one the remote route reads, so a run on the local model would measure
 * words nothing ships to it. Written out rather than imported, the way the gate batteries write
 * it: `core` does not import from `mcp`, where that constant lives.
 */
const REMOTE_JUDGE_ABSENT =
  (process.env.AION_ANTHROPIC_API_KEY ?? '').trim() === '' ||
  process.env.TEST_AION_GENERATION === 'local';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ORIGINAL_DESCRIPTION = 'a Postgres connection pool (concept)';
const REFRESHED_DESCRIPTION = 'a Postgres connection pool, resized after the June incident';
const MENTION_COUNT = 5;
const EMBED_DIMENSION = DEFAULTS.models.embedDimension;

function stubProvider(calls: StructuredRequest[]): Provider {
  return {
    embed: async (texts) => texts.map(() => new Array(EMBED_DIMENSION).fill(0.01)),
    generate: async (req: StructuredRequest) => {
      calls.push(req);
      return { description: REFRESHED_DESCRIPTION };
    },
  };
}

const config: Config = {
  ...DEFAULTS,
  maintenance: {
    ...DEFAULTS.maintenance,
    descriptionRefreshBatch: 5,
    descriptionRefreshMentionGrowth: 3,
  },
};

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-description-freshness-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const [entity] = await mergeEntities(
    harness.driver,
    [
      {
        name: 'connection pool',
        nameNorm: 'connection pool',
        type: 'concept',
        text: ORIGINAL_DESCRIPTION,
        sourceEpisodeId: 'seed-episode-0',
        extractionMethod: 'test-seed',
        confidence: 1,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  entityId = entity!.id;

  for (let index = 0; index < MENTION_COUNT; index += 1) {
    const episodeId = `mention-episode-${String(index)}`;
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: episodeId,
      now: NOW,
      properties: { text: `mention ${String(index)} of the connection pool` },
    });
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [entityId],
      now: NOW,
      confidence: 1,
      provenance: ['test-seed'],
    });
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function contextFor(provider: Provider = refusingProvider): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    provider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

describe('descriptionFreshnessOperation against a live graph', () => {
  it('refreshes a description that outgrew its mention baseline and keeps the old value', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await descriptionFreshnessOperation().run(contextFor(stubProvider(calls)));

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(1);
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain(ORIGINAL_DESCRIPTION);

    const entity = await storedEntity(harness.driver, entityId);
    expect(entity?.text).toBe(REFRESHED_DESCRIPTION);
    expect(entity?.contentVectorLength).toBe(EMBED_DIMENSION);

    const props = await nodeProperties(harness.driver, entityId);
    expect(props[PRIOR_DESCRIPTIONS_PROPERTY]).toEqual([ORIGINAL_DESCRIPTION]);
    expect(Number(props[DESCRIPTION_MENTION_COUNT_PROPERTY])).toBe(MENTION_COUNT);
    expect(props[DESCRIPTION_REFRESH_METHOD_PROPERTY]).toBe(DESCRIPTION_REFRESH_METHOD);
    expect(props[DESCRIPTION_REFRESHED_AT_PROPERTY]).toBeDefined();
  }, 120_000);

  it('leaves the freshly refreshed entity alone on the next run', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await descriptionFreshnessOperation().run(contextFor(stubProvider(calls)));

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
    expect(calls).toHaveLength(0);
  }, 60_000);

  it('will not rewrite an entity that lost currency while the model was answering', async () => {
    // The two model calls are long enough for a merge, a decay, or a forget to close the
    // entity. The write is an in-place replacement with no close to undo, so it carries the
    // currency test itself.
    await harness.driver.executeQuery(
      'MATCH (e:Entity { id: $id }) SET e.valid_until = datetime($now)',
      { id: entityId, now: NOW.toISOString() },
    );
    try {
      const applied = await refreshEntityDescription(harness.driver, {
        id: entityId,
        text: 'a rewrite nobody should be able to write',
        contentVector: new Array<number>(EMBED_DIMENSION).fill(0.02),
        mentionCount: MENTION_COUNT,
        now: NOW,
      });

      expect(applied).toBe(false);
      const props = await nodeProperties(harness.driver, entityId);
      expect(props.text).toBe(REFRESHED_DESCRIPTION);
    } finally {
      await harness.driver.executeQuery('MATCH (e:Entity { id: $id }) REMOVE e.valid_until', {
        id: entityId,
      });
    }
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

const KEYED_ENTITY_DESCRIPTION = 'a queue worker (concept)';

/**
 * Every mention names the same upstream queue and the same person, so the connections the keyed
 * text asks for are in the sources rather than left to the model to supply.
 */
const KEYED_ENTITY_MENTIONS = [
  'Priya moved the ingest worker behind the Valkey queue so its retries stopped doubling',
  'the ingest worker takes its jobs from the Valkey queue and writes each result to the ledger service',
  'after the June incident the ingest worker ran on two replicas, both fed by the Valkey queue',
  'Priya owns the ingest worker rota, and the Valkey queue is the only thing upstream of it',
  'the ingest worker drains the Valkey queue every night before the ledger service closes the day',
];

describe.skipIf(REMOTE_JUDGE_ABSENT)('a keyed-route refresh of the same shape', () => {
  let keyedEntityId: string;
  let live: Provider;

  beforeAll(async () => {
    live = testGenerationProvider({
      baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      embedModel: DEFAULTS.models.embed,
    });

    const [entity] = await mergeEntities(
      harness.driver,
      [
        {
          name: 'ingest worker',
          nameNorm: 'ingest worker',
          type: 'concept',
          text: KEYED_ENTITY_DESCRIPTION,
          sourceEpisodeId: 'keyed-seed-episode-0',
          extractionMethod: 'test-seed',
          confidence: 1,
          occurredAt: NOW,
        },
      ],
      NOW,
    );
    keyedEntityId = entity!.id;

    for (const [index, text] of KEYED_ENTITY_MENTIONS.entries()) {
      const episodeId = `keyed-mention-episode-${String(index)}`;
      await writeStampedNode(harness.driver, {
        label: 'Episode',
        id: episodeId,
        now: NOW,
        properties: { text },
      });
      await linkEntityMentions(harness.driver, {
        episodeId,
        entityIds: [keyedEntityId],
        now: NOW,
        confidence: 1,
        provenance: ['test-seed'],
      });
    }
  }, 300_000);

  it('writes a longer gloss that names what the entity connects to, and keeps the old one', async () => {
    const outcome = await descriptionFreshnessOperation().run(contextFor(live));

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(1);

    const entity = await storedEntity(harness.driver, keyedEntityId);
    const refreshed = entity?.text ?? '';
    expect(refreshed.length).toBeGreaterThan(KEYED_ENTITY_DESCRIPTION.length);
    expect(refreshed.toLowerCase()).toContain('valkey');
    expect(entity?.contentVectorLength).toBe(EMBED_DIMENSION);

    const props = await nodeProperties(harness.driver, keyedEntityId);
    expect(props[PRIOR_DESCRIPTIONS_PROPERTY]).toEqual([KEYED_ENTITY_DESCRIPTION]);
  }, 120_000);
});
