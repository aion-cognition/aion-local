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

function contextFor(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

describe('descriptionFreshnessOperation against a live graph', () => {
  it('refreshes a description that outgrew its mention baseline and keeps the old value', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await descriptionFreshnessOperation({
      buildProvider: () => stubProvider(calls),
    }).run(contextFor());

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
    const outcome = await descriptionFreshnessOperation({
      buildProvider: () => stubProvider(calls),
    }).run(contextFor());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
    expect(calls).toHaveLength(0);
  }, 60_000);
});
