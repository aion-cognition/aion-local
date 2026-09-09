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
import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { OWNERSHIP_PROPERTIES } from '../../infrastructure/graph/ownership-summary-queries.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { nodeProperties } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  seedGraphOnlyEpisode,
  seedLegacyEdge,
  seedLegacyMention,
} from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { countCommittedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';
import { archiveRowidBounds } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  freezeMigrationCohort,
  readIntakeWatermark,
  readMigrationProgress,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { readSourceParts, readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
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

it('freezes a cohort whose membership names the graph-only source the archive never got', async () => {
  const report = await freezeLegacyCohort(
    { driver: substrate.harness.driver, db: store.db, publications: coordinator },
    { cohortId: 'cohort-1', now: NOW },
  );

  expect(report.members).toBe(4);
  expect(report.graphOnly).toBe(1);
  expect(report.written).toBe(4);
  expect(readMigrationProgress(store.db, 'cohort-1', 'episode-graph-only')?.status).toBe(
    'accounted',
  );

  // A repeat under the same census writes no member and re-freezes nothing.
  const again = await freezeLegacyCohort(
    { driver: substrate.harness.driver, db: store.db, publications: coordinator },
    { cohortId: 'cohort-1', now: NOW },
  );
  expect(again.written).toBe(0);
});

it('walks the cohort: verified against both stores, pinned where the proof cannot be made', async () => {
  const [alpha, beta, live] = accepted;
  const report = await runLegacyBackfillBatch(
    { driver: substrate.harness.driver, db: store.db, publications: coordinator },
    { cohortId: 'cohort-1', now: NOW },
  );

  expect(report.walked).toBe(4);
  expect(report.remaining).toBe(0);
  // Two proved: the legacy source with classified edges, and the live one nothing needed to
  // reprove. Two pinned: the graph-only source has no raw record, and beta's only relationship is
  // one the vocabulary does not name.
  expect(report.verified).toBe(2);
  expect(report.pinned).toBe(2);

  // The graph-only source is pinned with its reason and stays a source rather than disappearing.
  expect(readSourceRecord(store.db, 'episode-graph-only')).toMatchObject({
    verificationStatus: 'pinned',
    verificationReason: 'the archive holds no row for this source inside the frozen bounds',
  });

  // The live source was already proved by the acceptance that wrote it; the walk leaves it alone.
  expect(readMigrationProgress(store.db, 'cohort-1', live!)?.reason).toBe(
    'the live acceptance already proved this source',
  );

  // A legacy source is verified against the graph, with the whole archive proof recorded.
  const record = readSourceRecord(store.db, alpha!);
  expect(record?.verificationStatus).toBe('verified');
  expect(record?.canonicalArchiveId).not.toBeNull();
  expect(record?.verifiedContentDigest).not.toBeNull();
  expect(record?.aliasArchiveIds).toEqual([]);
  expect(readSourceParts(store.db, alpha!).length).toBeGreaterThan(0);

  // Its mention is now a durable record with the role its link is classified under.
  expect(countCommittedIncidenceForNode(store.db, 'entity-sync', 'mention')).toBe(1);

  // Beta's unclassified edge pinned it, and it materialized nothing. The archive proof it does
  // have is untouched: it is the relationship evidence that could not be established.
  const pinned = readMigrationProgress(store.db, 'cohort-1', beta!);
  expect(pinned?.status).toBe('pinned');
  expect(pinned?.reason).toContain('SIMILAR');
  expect(readSourceRecord(store.db, beta!)?.verificationStatus).toBe('verified');
  expect(countCommittedIncidenceForNode(store.db, 'entity-sync', 'participation')).toBe(1);

  // The index work a legacy source owes is queued, and no integrate row is: a migration does not
  // re-run extraction over the corpus.
  const jobs = listReflectionJobs(store.db);
  expect(jobs.every((job) => job.jobType === 'source_index')).toBe(true);
  expect(report.indexEnqueued).toBe(3);
}, 120_000);

it('counts nothing until the cohort has accounted, then answers support instead of unknown', async () => {
  const deps = { driver: substrate.harness.driver, db: store.db, publications: coordinator };

  // Before the seal the counters have moved and nothing is counted, so support stays unknown for
  // a node nothing stands behind.
  expect(
    readScopeVersion(store.db, { endpointId: 'entity-sync', relationClass: 'sqlite:mention:in' })
      ?.censusStatus,
  ).toBe('unknown');

  const held = await freezeLegacyCohort(deps, { cohortId: 'cohort-open', now: NOW });
  expect(held.members).toBeGreaterThan(0);
  const refused = await sealLegacyCohortCensus(deps, { cohortId: 'cohort-open' });
  expect(refused.deferred).toBe('cohort_not_fully_accounted');
  expect(
    readScopeVersion(store.db, { endpointId: 'entity-sync', relationClass: 'sqlite:mention:in' })
      ?.censusStatus,
  ).toBe('unknown');

  const sealed = await sealLegacyCohortCensus(deps, { cohortId: 'cohort-1' });
  expect(sealed.endpoints).toBeGreaterThan(0);
  expect(
    readScopeVersion(store.db, { endpointId: 'entity-sync', relationClass: 'sqlite:mention:in' })
      ?.censusStatus,
  ).toBe('established');

  const support = certifyNodeSupport(store.db, 'entity-sync');
  expect(support.support).toBe('supported');
  expect(support.reason).toBe('committed mention incidence');

  // The ownership projection carries the count the seal made, so a nomination may read it.
  const properties = await nodeProperties(substrate.harness.driver, 'entity-sync');
  expect(properties[OWNERSHIP_PROPERTIES.census]).toBe(true);
  expect(properties[OWNERSHIP_PROPERTIES.sessions]).toEqual([SESSION]);
}, 120_000);

it('resumes an interrupted materialization instead of leaving half of one behind', async () => {
  const deps = { driver: substrate.harness.driver, db: store.db, publications: coordinator };
  const marker = 'gamma';
  const result = await handleReflection(
    intake,
    { observations: [`the sync keyed on id_slug ${marker}`] },
    { identity: SESSION, now: NOW },
  );
  forgetDurableRecords(result.episode_id);
  store.db.prepare('DELETE FROM reflection_queue').run();
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: result.episode_id,
    entityId: 'entity-gamma',
    name: 'gamma engine',
    now: NOW,
  });
  // One member, so the injected interruption lands on the source this case is about rather than
  // on whichever id the previous cohort's ordering happens to reach first.
  const bounds = archiveRowidBounds(store.db);
  freezeMigrationCohort(store.db, {
    cohortId: 'cohort-2',
    cohortDigest: 'gamma-only',
    intakeWatermark: readIntakeWatermark(store.db),
    archiveRowidLow: bounds.low,
    archiveRowidHigh: bounds.high,
    graphCensusDigest: 'gamma-only',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: [result.episode_id],
  });

  failAt = 'before_ack';
  await expect(runLegacyBackfillBatch(deps, { cohortId: 'cohort-2', now: NOW })).rejects.toThrow();

  // Nothing is committed and the member is still owed: the walk did not mark it done.
  expect(countCommittedIncidenceForNode(store.db, 'entity-gamma', 'mention')).toBe(0);
  expect(readMigrationProgress(store.db, 'cohort-2', result.episode_id)?.status).toBe('accounted');

  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');
  expect(countCommittedIncidenceForNode(store.db, 'entity-gamma', 'mention')).toBe(1);

  // The next batch walks the member again and the replay writes one record, not a second.
  const report = await runLegacyBackfillBatch(deps, { cohortId: 'cohort-2', now: NOW });
  expect(report.remaining).toBe(0);
  expect(countCommittedIncidenceForNode(store.db, 'entity-gamma', 'mention')).toBe(1);
}, 120_000);
