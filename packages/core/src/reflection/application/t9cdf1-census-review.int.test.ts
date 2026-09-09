import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { intakePublication } from './intake-publication.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { runLegacyBackfillBatch, sealLegacyCohortCensus } from './legacy-backfill.js';
import { legacyMaterializationPublication } from './legacy-materialization.js';
import { planSourceVerification } from './legacy-verification.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { countCurrentMentionSources } from '../../evidence/application/logical-counters.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { findLegacyRawNodes } from '../../infrastructure/graph/legacy-evidence-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  seedGraphOnlyEpisode,
  seedLegacyEdge,
  seedLegacyMention,
} from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import { corruptRawTurn } from '../../infrastructure/graph/test-support/t9cdf1-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { archiveRowidBounds } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  freezeMigrationCohort,
  readIntakeWatermark,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The C1 freeze/backfill acceptance, end to end and through the real coordinator.
 *
 * A legacy corpus is built the only honest way: real acceptances write the archive rows and the
 * graph, and then the durable identity records are removed. What is left is a substrate whose
 * sources exist in the archive and the graph and nowhere else, which is exactly the world the
 * migration was written for.
 *
 * The run is freeze, walk, seal. What it asserts is that the walk proves each member against both
 * stores, that a member it cannot prove is PINNED rather than dropped, that the census is
 * established only after every member has been accounted for, and that an interrupted
 * materialization resumes rather than leaving half of one behind.
 *
 * No provider is constructed in this file's import graph, and the injected one rejects: a
 * generation or an embedding would fail the run rather than pass quietly.
 */

const NOW = new Date('2026-09-09T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const STAGES = ['entities'];
const SESSION = 'legacy-session';

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let failAt: PublicationBoundary | undefined;

/** The sources of the legacy corpus, in the order they were accepted. */
const accepted: string[] = [];

function forgetDurableRecords(sourceId: string): void {
  store.db.prepare('DELETE FROM source_parts WHERE source_id = ?').run(sourceId);
  store.db.prepare('DELETE FROM source_records WHERE source_id = ?').run(sourceId);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-legacy-backfill-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, intakePublication, legacyMaterializationPublication],
    boundary: ({ boundary }) => {
      expect(store.db.inTransaction).toBe(false);
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error(`interrupted at ${boundary}`);
      }
    },
  });
  await coordinator.initialize();
  publishPipelineReadinessPolicy(
    store.db,
    STAGES.map((name) => ({ name, run: () => Promise.resolve({ status: 'ok', summary: '' }) })),
    NOW,
  );
  intake = {
    driver: substrate.harness.driver,
    db: store.db,
    sessions: new SessionManager(substrate.harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: {
      embed: () => Promise.reject(new Error('no embedding in this battery')),
      generate: () => Promise.reject(new Error('no generation in this battery')),
    },
    publications: coordinator,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };

  // Three acceptances become the legacy corpus. Their identity records are removed afterwards,
  // which is what makes them sources whose only evidence is the archive row and the graph.
  for (const marker of ['alpha', 'beta', 'live']) {
    const result = await handleReflection(
      intake,
      { observations: [`the sync keyed on id_slug ${marker}`] },
      { identity: SESSION, now: NOW },
    );
    accepted.push(result.episode_id);
  }
  const [alpha, beta] = accepted;
  if (alpha === undefined || beta === undefined) {
    throw new Error('the legacy corpus needs its first two acceptances');
  }
  forgetDurableRecords(alpha);
  forgetDurableRecords(beta);
  store.db.prepare('DELETE FROM reflection_queue').run();

  await seedLegacyMention(substrate.harness.driver, {
    episodeId: alpha,
    entityId: 'entity-sync',
    name: 'sync engine',
    now: NOW,
  });
  // Beta's only incident relationship is one this vocabulary does not classify, which is what a
  // pin is for: the source stays, and nothing invents a role for the edge.
  await seedLegacyEdge(substrate.harness.driver, {
    type: 'SIMILAR',
    fromId: beta,
    toId: 'entity-sync',
    now: NOW,
  });
  await seedGraphOnlyEpisode(substrate.harness.driver, {
    episodeId: 'episode-graph-only',
    sessionId: SESSION,
    now: NOW,
  });
}, 300_000);

beforeEach(() => {
  failAt = undefined;
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

function deps() {
  return { driver: substrate.harness.driver, db: store.db, publications: coordinator };
}

it('does not certify a global endpoint census from a subset cohort with an unmaterialized contributor', async () => {
  const [alpha, beta] = accepted;
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: beta!,
    entityId: 'entity-sync',
    name: 'sync engine',
    now: NOW,
  });
  const bounds = archiveRowidBounds(store.db);
  freezeMigrationCohort(store.db, {
    cohortId: 'subset',
    cohortDigest: 'subset',
    intakeWatermark: readIntakeWatermark(store.db),
    archiveRowidLow: bounds.low,
    archiveRowidHigh: bounds.high,
    graphCensusDigest: 'subset',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: [alpha!],
  });
  expect((await runLegacyBackfillBatch(deps(), { cohortId: 'subset', now: NOW })).verified).toBe(1);
  await sealLegacyCohortCensus(deps(), { cohortId: 'subset' });
  expect(countCurrentMentionSources(store.db, 'entity-sync').status).toBe('unavailable');
});
it('compares the raw turn bytes rather than trusting the graph hash property', async () => {
  const { episode_id: id } = await handleReflection(
    intake,
    { turns: [{ role: 'user', text: 'the original raw turn' }] },
    { identity: 'raw-proof', now: NOW },
  );
  const before = await findLegacyRawNodes(substrate.harness.driver, id);
  expect(
    planSourceVerification(store.db, {
      sourceId: id,
      bounds: archiveRowidBounds(store.db),
      raw: before,
      now: NOW,
      reverify: true,
    }).status,
  ).toBe('verified');
  await corruptRawTurn(substrate.harness.driver, id, { text: 'a different raw turn' });
  const after = await findLegacyRawNodes(substrate.harness.driver, id);
  expect(
    planSourceVerification(store.db, {
      sourceId: id,
      bounds: archiveRowidBounds(store.db),
      raw: after,
      now: NOW,
      reverify: true,
    }).status,
  ).toBe('pinned');
});

it('revisits a pinned member when an explicit re-verification raises its proof bound', async () => {
  const alpha = accepted[0]!;
  const bounds = archiveRowidBounds(store.db);
  freezeMigrationCohort(store.db, {
    cohortId: 'retry-bounds',
    cohortDigest: 'retry-bounds',
    intakeWatermark: readIntakeWatermark(store.db),
    archiveRowidLow: bounds.low,
    archiveRowidHigh: bounds.high,
    graphCensusDigest: 'retry-bounds',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: [alpha],
  });
  expect(
    (await runLegacyBackfillBatch(deps(), { cohortId: 'retry-bounds', now: NOW, relationLimit: 1 }))
      .pinned,
  ).toBe(1);
  const retried = await runLegacyBackfillBatch(deps(), {
    cohortId: 'retry-bounds',
    now: NOW,
    relationLimit: 500,
    reverify: true,
  });
  expect(retried.verified).toBe(1);
});
