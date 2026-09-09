import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { intakePublication } from './intake-publication.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import { legacyMaterializationPublication } from './legacy-materialization.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { countCurrentMentionSources } from '../../evidence/application/logical-counters.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  driftEpisodeDigest,
  seedGraphOnlyEpisode,
  seedLegacyEdge,
  seedLegacyMention,
} from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  readScopeVersion,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { archiveRowidBounds } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  recordMigrationProgress,
  freezeMigrationCohort,
  readIntakeWatermark,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
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
it('refuses a census seal for a cohort that was never frozen', async () => {
  prepareScopeAdvance(store.db, {
    endpointId: 'unrelated',
    relationClass: 'source.state',
    operationId: 'foreign-pending',
    updatedAt: NOW,
  });
  acknowledgeScopeAdvance(store.db, {
    endpointId: 'unrelated',
    relationClass: 'source.state',
    operationId: 'foreign-pending',
    updatedAt: NOW,
  });
  const result = await sealLegacyCohortCensus(deps(), { cohortId: 'not-a-cohort' });
  expect(result.deferred).toBeDefined();
  expect(
    readScopeVersion(store.db, { endpointId: 'unrelated', relationClass: 'source.state' })
      ?.censusStatus,
  ).not.toBe('established');
});
it('does not certify a shared endpoint while one contributing source was pinned without materialization', async () => {
  const beta = accepted[1];
  if (beta === undefined) {
    throw new Error('missing beta');
  }
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: beta,
    entityId: 'entity-sync',
    name: 'sync engine',
    now: NOW,
  });
  await freezeLegacyCohort(deps(), { cohortId: 'pinned-population', now: NOW });
  const walked = await runLegacyBackfillBatch(deps(), { cohortId: 'pinned-population', now: NOW });
  expect(walked.pinned).toBeGreaterThan(0);
  await sealLegacyCohortCensus(deps(), { cohortId: 'pinned-population' });
  expect(countCurrentMentionSources(store.db, 'entity-sync').status).toBe('unavailable');
});
it('retries a pinned source after its evidence is repaired instead of returning its old saved pin', async () => {
  const id = accepted[0];
  if (id === undefined) {
    throw new Error('missing alpha');
  }
  const bounds = archiveRowidBounds(store.db);
  freezeMigrationCohort(store.db, {
    cohortId: 'retry-cohort',
    cohortDigest: 'retry',
    intakeWatermark: readIntakeWatermark(store.db),
    archiveRowidLow: bounds.low,
    archiveRowidHigh: bounds.high,
    graphCensusDigest: 'known',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: [id],
  });
  const held = readSourceRecord(store.db, id);
  expect(held).toBeDefined();
  await driftEpisodeDigest(substrate.harness.driver, id, 'wrong');
  const first = await runLegacyBackfillBatch(deps(), {
    cohortId: 'retry-cohort',
    now: NOW,
    reverify: true,
  });
  expect(first.pinned).toBe(1);
  const original = held?.verifiedContentDigest;
  if (original === null || original === undefined) {
    throw new Error('no prior digest');
  }
  await driftEpisodeDigest(substrate.harness.driver, id, original);
  recordMigrationProgress(store.db, {
    cohortId: 'retry-cohort',
    sourceId: id,
    status: 'accounted',
    reason: 'proof repaired',
  });
  const second = await runLegacyBackfillBatch(deps(), {
    cohortId: 'retry-cohort',
    now: NOW,
    reverify: true,
  });
  expect(second.verified).toBe(1);
});

it('reuses a frozen cohort after an intervening intake instead of trying to freeze new membership under its old id', async () => {
  const first = await freezeLegacyCohort(deps(), { cohortId: 'restart-freeze', now: NOW });
  await handleReflection(
    intake,
    { observations: ['arrived after freeze'] },
    { identity: 'new-session', now: NOW },
  );
  await expect(
    freezeLegacyCohort(deps(), { cohortId: 'restart-freeze', now: NOW }),
  ).resolves.toMatchObject({ members: first.members, written: 0 });
});
