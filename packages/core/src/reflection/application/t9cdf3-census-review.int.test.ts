import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { intakePublication } from './intake-publication.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { runLegacyBackfillBatch, sealLegacyCohortCensus } from './legacy-backfill.js';
import { legacyMaterializationPublication } from './legacy-materialization.js';
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
it.each([1, 500])(
  'finalizes an upgraded legacy progress row after a lost reply at bound %s',
  async (bound) => {
    const cohort = `lost-reply-${bound}`;
    const source = await newSource(`reverify-lost-reply-${bound}`);
    await seedLegacyMention(substrate.harness.driver, {
      episodeId: source,
      entityId: `reverify-entity-${bound}`,
      name: `reverify entity ${bound}`,
      now: NOW,
    });
    freeze(cohort, [source]);
    expect(
      (await runLegacyBackfillBatch(deps(), { cohortId: cohort, now: NOW, relationLimit: 1 }))
        .pinned,
    ).toBe(1);
    store.db
      .prepare('UPDATE migration_progress SET walked_by=NULL WHERE cohort_id=? AND source_id=?')
      .run(cohort, source);
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
        cohortId: cohort,
        now: NOW,
        reverify: true,
        relationLimit: bound,
      }),
    ).rejects.toThrow('acknowledged reply lost');
    const count = () =>
      store.db
        .prepare('SELECT count(*) AS n FROM publication_intents WHERE operation_id LIKE ?')
        .get(`legacy-materialization:${cohort}:${source}%`) as { n: number };
    expect(count().n).toBe(2);
    const resumed = await runLegacyBackfillBatch(deps(), {
      cohortId: cohort,
      now: NOW,
      reverify: true,
      relationLimit: bound,
    });
    expect(bound === 1 ? resumed.pinned : resumed.verified).toBe(1);
    expect(count().n).toBe(2);
  },
);

it('does not seal an unmaterialized relationship that shares an older logical link id', async () => {
  const source = (
    await handleReflection(
      intake,
      { turns: [{ role: 'user', text: 'the second witness is in the turn' }] },
      { identity: 'collision-after-walk', now: NOW },
    )
  ).episode_id;
  const entity = 'collision-after-walk-entity';
  await seedLegacyMention(substrate.harness.driver, {
    episodeId: source,
    entityId: entity,
    name: entity,
    now: NOW,
  });
  freeze('collision-after-walk', [source]);
  expect(
    (await runLegacyBackfillBatch(deps(), { cohortId: 'collision-after-walk', now: NOW })).verified,
  ).toBe(1);
  const raw = await findLegacyRawNodes(substrate.harness.driver, source);
  expect(raw?.turns).toHaveLength(1);
  await seedLegacyEdge(substrate.harness.driver, {
    type: 'MENTIONS',
    fromId: raw!.turns[0]!.turnId,
    toId: entity,
    now: NOW,
  });
  await sealLegacyCohortCensus(deps(), { cohortId: 'collision-after-walk' });
  expect.soft(countCurrentMentionSources(store.db, entity).status).toBe('unavailable');
  // The batch cursor skips verified members. This control asks the guarded producer directly
  // whether it can represent the full current relationship set.
  const bounds = archiveRowidBounds(store.db);
  const rechecked = await coordinator.publish({
    kind: 'legacy_materialization',
    operationId: 'collision-full-materialization-control',
    payload: {
      mode: 'source',
      cohortId: 'collision-after-walk',
      sourceId: source,
      relationLimit: 500,
      archiveRowidLow: bounds.low,
      archiveRowidHigh: bounds.high,
      reverify: true,
    },
  });
  expect(rechecked.status).toBe('acknowledged');
  if (rechecked.status !== 'acknowledged') {
    throw new Error('the materialization control did not acknowledge');
  }
  expect(rechecked.result).toMatchObject({ pinned: true });
});
