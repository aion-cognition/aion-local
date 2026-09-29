import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proposalResolutionOperation, resolutionLedgerKey } from './proposal-resolution.js';
import { CoveredJudgmentEvidence } from '../../../evidence/application/covered-judgment.js';
import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import {
  establishEntityEvidence,
  seedEntitySource,
  stopCapture,
} from '../../../evidence/test-support/entity-evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  getEntityMergeProposal,
  recordEntityMergeProposal,
} from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * An open entity-merge proposal whose subject rests on long hook captures, resolved through the
 * evidence seam the service composes. Read whole, those captures exceed the pair's decode
 * allowance and the row stayed open forever; read as bounded excerpts, both passes are asked and
 * the row is decided on its merits. The judges are scripted, since what this file checks is the
 * evidence they were handed, not how a model reads it.
 */

const NOW = new Date('2026-09-28T12:00:00.000Z');
const EPISODE_ID = 'episode-filed-the-proposal';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let coordinator: PublicationCoordinator;
let evidence: CoveredJudgmentEvidence;
let subjectId: string;
let candidateId: string;

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

async function seedEntity(name: string): Promise<string> {
  const [merged] = await mergeEntities(
    harness.driver,
    [
      {
        name,
        nameNorm: name.toLowerCase(),
        type: 'tool',
        text: `${name} (tool): the ledger cache`,
        sourceEpisodeId: EPISODE_ID,
        extractionMethod: 'test',
        confidence: 0.8,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  if (merged === undefined) {
    throw new Error(`failed to seed ${name}`);
  }
  return merged.id;
}

/** Both passes scripted, every message they were sent recorded. */
function scripted(prompts: string[]): Provider {
  return {
    embed: () => Promise.reject(new Error('proposal resolution must not embed')),
    generate: (request: StructuredRequest) => {
      prompts.push(request.messages.map((message) => message.content).join('\n'));
      return Promise.resolve(
        JSON.stringify(request.schema).includes('different_referent')
          ? { different_referent: true, reason: 'one is the cache, the other its store' }
          : { same: true, rationale: 'both name the ledger cache' },
      );
    },
  };
}

function contextFor(provider: Provider): OperationContext {
  return {
    driver: harness.driver,
    db,
    config: DEFAULTS,
    logger,
    provider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    publications: coordinator,
    evidence,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-proposal-resolution-entity-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, {
    embedDimension: DEFAULTS.models.embedDimension,
  });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...PUBLICATION_HANDLERS],
  });
  await coordinator.initialize();
  evidence = new CoveredJudgmentEvidence({
    db,
    resolver: new EvidenceResolver({
      driver: harness.driver,
      db,
      logger,
      publications: coordinator,
    }),
    now: () => NOW,
  });

  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: EPISODE_ID,
    now: NOW,
    properties: { text: 'the ledger cache work', session_id: 'session-filing' },
  });
  subjectId = await seedEntity('Ledger Cache');
  candidateId = await seedEntity('Ledger Cache Store');
  await linkEntityMentions(harness.driver, {
    episodeId: EPISODE_ID,
    entityIds: [subjectId, candidateId],
    now: NOW,
    confidence: 0.8,
    provenance: ['test'],
  });

  establishEntityEvidence(db, subjectId, NOW);
  establishEntityEvidence(db, candidateId, NOW);
  seedEntitySource(db, {
    sourceId: EPISODE_ID,
    sessionId: 'session-filing',
    content: stopCapture('Ledger Cache', minutesAgo(240)),
    nodeIds: [subjectId],
    at: NOW,
  });
  for (let index = 0; index < 4; index += 1) {
    seedEntitySource(db, {
      sourceId: `episode-later-${String(index)}`,
      sessionId: `session-later-${String(index)}`,
      content: stopCapture('Ledger Cache', minutesAgo(10 + index)),
      nodeIds: [subjectId],
      at: NOW,
    });
  }
  seedEntitySource(db, {
    sourceId: 'episode-store',
    sessionId: 'session-store',
    content: {
      turns: [
        {
          role: 'assistant',
          text: 'Ledger Cache Store keeps the cache warm between deploys.',
          occurred_at: minutesAgo(20).toISOString(),
        },
      ],
    },
    nodeIds: [candidateId],
    at: NOW,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('proposal resolution of an entity merge on bounded evidence', () => {
  it('decides the row with the filing episode read first and nothing withheld', async () => {
    const id = recordEntityMergeProposal(db, {
      subject: { id: subjectId, name: 'Ledger Cache', type: 'tool' },
      candidate: { id: candidateId, name: 'Ledger Cache Store', type: 'tool' },
      similarity: 0.9,
      similaritySource: 'name_cosine',
      episodeId: EPISODE_ID,
      createdAt: minutesAgo(5).toISOString(),
    });
    const prompts: string[] = [];

    const result = await proposalResolutionOperation().run(contextFor(scripted(prompts)));

    expect(result.withheldWork).toBeUndefined();
    expect(result.itemsAffected).toBe(1);
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    expect(getLedgerEntry(db, resolutionLedgerKey('entity_merge', id))?.summary).toMatchObject({
      verdict: 'dismissed',
    });
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      const prompting = prompt.indexOf(`[prompting episode] source ${EPISODE_ID}`);
      expect(prompting).toBeGreaterThan(-1);
      expect(prompting).toBeLessThan(prompt.indexOf('[recent] source episode-later'));
      expect(prompt).toContain('Ledger Cache is the service that owns this queue.');
      expect(prompt).toContain('Ledger Cache Store keeps the cache warm');
      // The one-hop neighbourhood the resolver always read is still in front of both passes.
      expect(prompt).toContain('is one hop from');
    }
  }, 180_000);
});
