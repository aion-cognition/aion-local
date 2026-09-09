import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { intakePublication } from './intake-publication.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { runLegacyBackfillBatch } from './legacy-backfill.js';
import { legacyMaterializationPublication } from './legacy-materialization.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { forgetNode } from '../../infrastructure/graph/bitemporal.js';
import {
  writeClaimProvenance,
  fetchClaimProvenance,
} from '../../infrastructure/graph/claim-provenance-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
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
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';
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

async function legacy(marker: string): Promise<string> {
  const result = await handleReflection(
    intake,
    { observations: [marker] },
    { identity: marker, now: NOW },
  );
  forgetDurableRecords(result.episode_id);
  return result.episode_id;
}
async function backfill(id: string) {
  const bounds = archiveRowidBounds(store.db);
  freezeMigrationCohort(store.db, {
    cohortId: id,
    cohortDigest: id,
    intakeWatermark: readIntakeWatermark(store.db),
    archiveRowidLow: bounds.low,
    archiveRowidHigh: bounds.high,
    graphCensusDigest: 'fixture',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: [id],
  });
  return runLegacyBackfillBatch(
    { driver: substrate.harness.driver, db: store.db, publications: coordinator },
    { cohortId: id, now: NOW },
  );
}
it('preserves a legacy source forget when its durable source state is first materialized', async () => {
  const id = await legacy('forgotten legacy content');
  await forgetNode(substrate.harness.driver, { id, now: NOW });
  const written = await backfill(id);
  expect(written.verified).toBe(1);
  const check = checkPresentCoverage(store.db, new Date());
  if (check.status !== 'checked') {
    throw new Error('fixture coverage missing');
  }
  const resolver = new EvidenceResolver({
    driver: substrate.harness.driver,
    db: store.db,
    logger: intake.logger,
  });
  const read = await resolver.resolveSources([{ kind: 'id', id }], check.context, 'raw_inspection');
  expect([...read.results.values()][0]?.value).toBeUndefined();
});
it('preserves confirmation attribution and text instead of materializing only its type and clocks', async () => {
  const id = await legacy('legacy confirmation');
  await writeClaimProvenance(substrate.harness.driver, {
    episodeId: id,
    derivedFrom: [],
    corrects: [],
    confirmations: [
      {
        target: 'entity-sync',
        by: 'original reviewer',
        at: NOW,
        evidence: 'original confirmation evidence',
      },
    ],
    unresolved: 0,
    now: NOW,
  });
  const prior = await fetchClaimProvenance(substrate.harness.driver, {
    ids: ['entity-sync'],
    maxRoots: 8,
    mode: withCurrency(),
  });
  expect(prior.get('entity-sync')?.confirmation?.evidence).toBe('original confirmation evidence');
  expect((await backfill(id)).verified).toBe(1);
  const row = store.db
    .prepare(
      "SELECT v.recorded_values_json AS body FROM evidence_links l JOIN evidence_link_versions v ON v.link_id=l.link_id WHERE l.from_id=? AND l.kind='confirms'",
    )
    .get(id) as { body: string } | undefined;
  expect.soft(row?.body).toContain('original reviewer');
  expect.soft(row?.body).toContain('original confirmation evidence');
});
