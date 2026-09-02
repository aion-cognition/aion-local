import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  narrowClaimKey,
  resolveClaimSubjects,
  type ExtractedClaimKey,
} from './subject-resolution.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_ALIASES_PROPERTY,
  ENTITY_MENTION_TYPE,
} from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { foldName } from '../../domain/name-fold.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';

/**
 * Subject resolution against a real graph, which is where it has to be proven: every tier is an
 * identity read over stored folds, aliases and the backbone label, and a stub that answers those
 * reads would be asserting its own model of identity rather than the substrate's.
 */

const EMBED_DIMENSION = 8;

const OCCURRED_AT = new Date('2026-09-01T12:00:00.000Z');

const NOW = new Date('2026-09-01T12:05:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let memberId: string;

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: { text: `episode ${id}`, session_id: 'session-subjects' },
  });
}

async function seedEntity(
  id: string,
  name: string,
  aliases: readonly string[] = [],
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: {
      [ENTITY_NAME_PROPERTY]: name,
      [ENTITY_NAME_NORM_PROPERTY]: foldName(name),
      [ENTITY_ALIASES_PROPERTY]: [...aliases],
      [ENTITY_ALIASES_NORM_PROPERTY]: aliases.map((alias) => foldName(alias)),
      type: 'tool',
    },
  });
}

async function mention(episodeId: string, entityId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: ENTITY_MENTION_TYPE,
    sourceId: episodeId,
    targetId: entityId,
    strength: 1,
    confidence: 1,
    signals: ['fixture'],
    provenance: ['fixture'],
    now: NOW,
  });
}

const provider: Provider = {
  generate: async () => {
    throw new Error('subject resolution asks no model');
  },
  embed: async () => {
    throw new Error('subject resolution embeds nothing');
  },
};

function contextFor(episodeId: string): StageContext {
  return {
    driver: harness.driver,
    db,
    provider,
    episodeId,
    episode: {
      id: episodeId,
      sessionId: 'session-subjects',
      text: 'episode text',
      occurredAt: OCCURRED_AT,
      turns: [],
    },
    logger,
    now: NOW,
    occurredAt: OCCURRED_AT,
    pipelineVersion: PIPELINE_VERSION,
  };
}

/** One claim's key as the extractor emitted it, narrowed the way the stage narrows it. */
function key(subject: string): ExtractedClaimKey {
  return narrowClaimKey('Decision', {
    subjectEntity: subject,
    aspect: 'queue store',
    temporalClass: 'standing',
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-subject-resolution-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  memberId = backbone.member.id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('resolveClaimSubjects', () => {
  it('resolves a subject the episode mentions under its own name', async () => {
    await seedEpisode('ep-own-name');
    await seedEntity('entity-postgres', 'Postgres');
    await mention('ep-own-name', 'entity-postgres');

    const resolved = await resolveClaimSubjects(contextFor('ep-own-name'), [key('postgres')]);

    expect(resolved.get('postgres')).toBe('entity-postgres');
  });

  it('resolves a subject one mentioned entity answers to as an alias', async () => {
    await seedEpisode('ep-alias');
    await seedEntity('entity-harbor', 'Harbor Index', ['the index']);
    await mention('ep-alias', 'entity-harbor');

    const resolved = await resolveClaimSubjects(contextFor('ep-alias'), [key('The Index')]);

    expect(resolved.get('the index')).toBe('entity-harbor');
  });

  it('declines a subject two mentioned entities both answer to', async () => {
    await seedEpisode('ep-ambiguous');
    await seedEntity('entity-mercury-probe', 'Mercury Probe', ['mercury']);
    await seedEntity('entity-mercury-ledger', 'Mercury Ledger', ['mercury']);
    await mention('ep-ambiguous', 'entity-mercury-probe');
    await mention('ep-ambiguous', 'entity-mercury-ledger');

    const resolved = await resolveClaimSubjects(contextFor('ep-ambiguous'), [key('Mercury')]);

    expect(resolved.has('mercury')).toBe(false);
  });

  it('declines a subject this episode never mentioned, however the rest of the graph answers to it', async () => {
    await seedEpisode('ep-out-of-scope');
    await seedEntity('entity-redis', 'Redis');
    await seedEntity('entity-mentioned', 'Sqlite');
    await mention('ep-out-of-scope', 'entity-mentioned');

    const resolved = await resolveClaimSubjects(contextFor('ep-out-of-scope'), [key('Redis')]);

    expect(resolved.has('redis')).toBe(false);
  });

  it('routes a first-person subject to the backbone Member without the episode naming it', async () => {
    await seedEpisode('ep-speaker');
    await seedEntity('entity-sqlite-store', 'SQLite Store');
    await mention('ep-speaker', 'entity-sqlite-store');

    const resolved = await resolveClaimSubjects(contextFor('ep-speaker'), [key('I')]);

    expect(resolved.get('i')).toBe(memberId);
  });

  it('resolves nothing for a claim whose aspect declined, since half a key keys nothing', async () => {
    await seedEpisode('ep-no-aspect');
    await seedEntity('entity-bare', 'Bare Subject');
    await mention('ep-no-aspect', 'entity-bare');

    const resolved = await resolveClaimSubjects(contextFor('ep-no-aspect'), [
      narrowClaimKey('Decision', { subjectEntity: 'Bare Subject', temporalClass: 'standing' }),
    ]);

    expect(resolved.size).toBe(0);
  });
});
