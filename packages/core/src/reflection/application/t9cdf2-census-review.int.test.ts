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
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
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

async function newSource(name: string): Promise<string> {
  return (await handleReflection(intake, { observations: [name] }, { identity: name, now: NOW }))
    .episode_id;
}
function freeze(id: string, members: string[]): void {
  const bounds = archiveRowidBounds(store.db);
  freezeMigrationCohort(store.db, {
    cohortId: id,
    cohortDigest: id,
    intakeWatermark: readIntakeWatermark(store.db),
    archiveRowidLow: bounds.low,
    archiveRowidHigh: bounds.high,
    graphCensusDigest: id,
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members,
  });
}
it('does not certify a mention census with a raw contributor whose source is unknown', async () => {
  const source = await newSource('known-owner-source');
  const entity = 'unknown-owner-entity';
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: source,
    entityId: entity,
    name: entity,
    now: NOW,
  });
  await writeStampedNode(substrate.harness.driver, {
    label: 'Turn',
    id: 'unowned-turn',
    now: NOW,
    properties: { text: 'unowned source text', role: 'user', sequence: 0 },
  });
  await seedLegacyEdge(substrate.harness.driver, {
    type: 'MENTIONS',
    fromId: 'unowned-turn',
    toId: entity,
    now: NOW,
  });
  freeze('unknown-owner', [source]);
  expect(
    (await runLegacyBackfillBatch(deps(), { cohortId: 'unknown-owner', now: NOW })).verified,
  ).toBe(1);
  await sealLegacyCohortCensus(deps(), { cohortId: 'unknown-owner' });
  expect(countCurrentMentionSources(store.db, entity).status).toBe('unavailable');
});
it('does not treat a source verified before an unmaterialized new relationship as complete proof', async () => {
  const first = await newSource('before-new-edge-first');
  const second = await newSource('before-new-edge-second');
  const entity = 'changed-population';
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: second,
    entityId: entity,
    name: entity,
    now: NOW,
  });
  freeze('changed-population', [first, second]);
  expect(
    (await runLegacyBackfillBatch(deps(), { cohortId: 'changed-population', now: NOW })).verified,
  ).toBe(2);
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: first,
    entityId: entity,
    name: entity,
    now: NOW,
  });
  await sealLegacyCohortCensus(deps(), { cohortId: 'changed-population' });
  expect(countCurrentMentionSources(store.db, entity).status).toBe('unavailable');
});
it('does not verify a raw turn whose text property is absent', async () => {
  const result = await handleReflection(
    intake,
    { turns: [{ role: 'user', text: 'required raw bytes' }] },
    { identity: 'missing-bytes', now: NOW },
  );
  const id = result.episode_id;
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
  await corruptRawTurn(substrate.harness.driver, id, { text: null });
  const raw = await findLegacyRawNodes(substrate.harness.driver, id);
  expect(raw?.turns[0]?.text).toBeUndefined();
  expect(
    planSourceVerification(store.db, {
      sourceId: id,
      bounds: archiveRowidBounds(store.db),
      raw,
      now: NOW,
      reverify: true,
    }).status,
  ).toBe('pinned');
});
it('finalizes the same explicit re-verification after its acknowledged reply is lost', async () => {
  const source = await newSource('reverify-lost-reply');
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: source,
    entityId: 'reverify-entity',
    name: 'reverify entity',
    now: NOW,
  });
  freeze('lost-reply', [source]);
  expect(
    (await runLegacyBackfillBatch(deps(), { cohortId: 'lost-reply', now: NOW, relationLimit: 1 }))
      .pinned,
  ).toBe(1);
  let lost = true;
  const faulted = {
    ...deps(),
    publications: {
      publish: async (request: Parameters<typeof coordinator.publish>[0]) => {
        const outcome = await coordinator.publish(request);
        if (lost) {
          lost = false;
          throw new Error('acknowledged reply lost');
        }
        return outcome;
      },
    },
  };
  await expect(
    runLegacyBackfillBatch(faulted, {
      cohortId: 'lost-reply',
      now: NOW,
      reverify: true,
      relationLimit: 500,
    }),
  ).rejects.toThrow('acknowledged reply lost');
  const count = () =>
    store.db
      .prepare('SELECT count(*) AS n FROM publication_intents WHERE operation_id LIKE ?')
      .get(`legacy-materialization:lost-reply:${source}%`) as { n: number };
  expect(count().n).toBe(2);
  expect(
    (
      await runLegacyBackfillBatch(deps(), {
        cohortId: 'lost-reply',
        now: NOW,
        reverify: true,
        relationLimit: 500,
      })
    ).verified,
  ).toBe(1);
  expect(count().n).toBe(2);
});
