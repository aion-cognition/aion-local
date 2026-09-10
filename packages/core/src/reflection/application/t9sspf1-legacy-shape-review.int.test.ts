import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import * as census from './accepted-source-census.js';
import { incomingStatementScopes, memberScopesCounted } from './chunk-evidence.js';
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
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  seedLegacyEdge,
  seedLegacyMention,
} from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';
import { readMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The census over the shape the migration actually produces.
 *
 * The reviewer's own case reproduces a source the PREVIOUS intake accepted: its identity records
 * are the ones that acceptance wrote, and only the census hooks were missing. This file asks the
 * other question — a source whose durable records are gone, so the walk has to re-verify it
 * against the archive and the graph and write the record itself. That is the corpus the migration
 * was written for, and it is the only way to find out whether the seal reaches a source whose
 * record no acceptance left behind.
 *
 * Built the way the C1 acceptance builds one: real acceptances write the archive rows and the
 * graph, the durable identity records are deleted, and what is left exists in the archive and the
 * graph and nowhere else. The census hooks are suppressed for those acceptances alone, so no scope
 * row is deleted or rewritten anywhere: these sources simply never had one.
 *
 * No provider is constructed in this file's import graph, and the injected one rejects.
 */

const NOW = new Date('2026-09-09T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const SESSION = 'legacy-shape-session';
const CORRECTION = durableRoleScope('stated_correction', 'in');
const CONFIRMATION = durableRoleScope('stated_confirmation', 'in');

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
/** The plain migrated source, and the pair a later graph correction joins. */
let plain: string;
let corrected: string;
let corrector: string;

function deps() {
  return { driver: substrate.harness.driver, db: store.db, publications: coordinator };
}

/** What a source accepted before the census producer, and since reduced to the corpus, looks like. */
async function legacySource(marker: string): Promise<string> {
  const prepare = vi.spyOn(census, 'prepareSourceCensus').mockImplementation(() => undefined);
  const acknowledge = vi.spyOn(census, 'acknowledgeSourceCensus').mockReturnValue(0);
  const discard = vi.spyOn(census, 'discardSourceCensus').mockImplementation(() => undefined);
  try {
    const result = await handleReflection(
      intake,
      { observations: [`the migration corpus records ${marker}`] },
      { identity: SESSION, now: NOW },
    );
    store.db.prepare('DELETE FROM source_parts WHERE source_id = ?').run(result.episode_id);
    store.db.prepare('DELETE FROM source_records WHERE source_id = ?').run(result.episode_id);
    store.db.prepare('DELETE FROM reflection_queue').run();
    return result.episode_id;
  } finally {
    prepare.mockRestore();
    acknowledge.mockRestore();
    discard.mockRestore();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-legacy-shape-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, intakePublication, legacyMaterializationPublication],
  });
  await coordinator.initialize();
  publishPipelineReadinessPolicy(
    store.db,
    [{ name: 'entities', run: () => Promise.resolve({ status: 'ok', summary: '' }) }],
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
  plain = await legacySource('a plain migrated source');
  corrected = await legacySource('the migrated source a later one corrects');
  corrector = await legacySource('the migrated source that corrects it');
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: plain,
    entityId: 'entity-migrated',
    name: 'migrated entity',
    now: NOW,
  });
}, 300_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('counts the incoming statement populations of sources the walk itself re-verified', async () => {
  await freezeLegacyCohort(deps(), { cohortId: 'legacy-shape', now: NOW });
  const walked = await runLegacyBackfillBatch(deps(), { cohortId: 'legacy-shape', now: NOW });
  expect(walked.pinned).toBe(0);
  expect(walked.remaining).toBe(0);
  const sealed = await sealLegacyCohortCensus(deps(), { cohortId: 'legacy-shape' });
  expect(sealed.deferred).toBeUndefined();

  // The walk wrote this record: the acceptance's was deleted with the rest of the corpus, so a
  // seal that only reached sources an acceptance had recorded would never have looked here. The
  // verdict names the archive-and-graph proof rather than the live-acceptance shortcut, which is
  // what says this went through the real materialization path.
  expect(readSourceRecord(store.db, plain)?.verificationStatus).toBe('verified');
  expect(readMigrationProgress(store.db, 'legacy-shape', plain)?.reason).toBe(
    'the archived digest matches the graph projection',
  );
  expect(incomingStatementScopes(store.db, plain).unproved).toEqual([]);
  expect(memberScopesCounted(store.db, [plain, corrected, corrector])).toBe(true);
});

it('records what proved each population rather than stamping the source empty', () => {
  // Nothing corrects these sources and every walk finished, so each zero is a proved one and the
  // coverage names the sources it walked rather than asserting an absence.
  for (const sourceId of [plain, corrected, corrector]) {
    for (const relationClass of [CORRECTION, CONFIRMATION]) {
      const row = readScopeVersion(store.db, { endpointId: sourceId, relationClass });
      expect(row?.censusStatus).toBe('established');
      expect(JSON.parse(row!.coverageJson!)).toMatchObject({
        scope: relationClass,
        contributors: [],
      });
    }
  }
});

it('pins the source a legacy correction points at rather than classifying the edge', async () => {
  await seedLegacyEdge(substrate.harness.driver, {
    type: 'CORRECTS',
    fromId: corrector,
    toId: corrected,
    now: NOW,
  });
  await freezeLegacyCohort(deps(), { cohortId: 'legacy-corrected', now: NOW });
  const walked = await runLegacyBackfillBatch(deps(), {
    cohortId: 'legacy-corrected',
    now: NOW,
    reverify: true,
  });

  // The classification vocabulary names CORRECTS only from the stating source's side, so the
  // source it points AT carries a relationship nobody here can classify and the member pins. A
  // pin is what every scope proof over that endpoint needs and cannot get: `proveEndpoint` counts
  // a scope only where every contributor is a VERIFIED member, so this walk certifies nothing
  // about it. The source rule added here changes which scopes are considered, never that test.
  expect(walked.pinned).toBeGreaterThan(0);
  expect(readMigrationProgress(store.db, 'legacy-corrected', corrected)).toMatchObject({
    status: 'pinned',
  });
  expect(readMigrationProgress(store.db, 'legacy-corrected', corrected)?.reason).toContain(
    'CORRECTS',
  );
});
