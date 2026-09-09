import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { reflectionCompletionPublication } from './completion-publication.js';
import { intakePublication } from './intake-publication.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { legacyMaterializationPublication } from './legacy-materialization.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { relationshipTypesBetween } from '../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listStatedLinks } from '../../infrastructure/sqlite/evidence-links.js';
import { mergeExperienceProvenance } from '../../infrastructure/sqlite/experience-archive.js';
import { archiveRowidBounds } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { listEvidenceAcknowledgments } from '../../infrastructure/sqlite/source-lifecycle.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The two converted writers, driven through a real coordinator against real stores.
 *
 * The subject is the wiring rather than the operations: an acceptance and a completion each
 * reaching their stores only through a publication, and each resuming what it already minted
 * when the process is interrupted between the graph write and the acknowledgment.
 *
 * No provider is constructed anywhere in this file's import graph and nothing generates or
 * embeds: the pipeline is a stub runner reporting dispositions.
 */

const NOW = new Date('2026-09-08T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const STAGES = ['entities', 'cognitive'];

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let failAt: PublicationBoundary | undefined;
let serial = 0;

/** A stub pipeline: the run says what it settled, and nothing calls a model. */

function payload(marker: string): Record<string, unknown> {
  return { observations: [`the sync keyed on id_slug ${marker}`] };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-converted-writers-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, {
    embedDimension: EMBED_DIMENSION,
  });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [
      ...PUBLICATION_HANDLERS,
      intakePublication,
      reflectionCompletionPublication,
      legacyMaterializationPublication,
    ],
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
    // Never called: intake embeds after acknowledgment and every case here asserts before that.
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
}, 120_000);

beforeEach(() => {
  failAt = undefined;
  serial += 1;
});

afterEach(async () => {
  failAt = undefined;
  await coordinator.recover();
  // Each case owns its own queue: a row an earlier case left would be claimed by the next
  // worker and would spend that case's single injected interruption on somebody else's job.
  store.db.prepare('DELETE FROM reflection_queue').run();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

async function accept(): Promise<string> {
  const marker = `review-${serial}`;
  return (
    await handleReflection(intake, payload(marker), { identity: `session-${marker}`, now: NOW })
  ).episode_id;
}

it('projects legacy accepted references before acknowledging their settlement', async () => {
  const id = await accept();
  await writeStampedNode(substrate.harness.driver, {
    id: 'legacy-existing-target',
    label: 'Decision',
    now: NOW,
    properties: { text: 'a stated assertion' },
  });
  const ordinary = await handleReflection(
    intake,
    {
      observations: ['the ordinary statement control'],
      provenance: { derived_from: ['legacy-existing-target'] },
    },
    { identity: 'ordinary-control', now: NOW },
  );
  expect(
    await relationshipTypesBetween(
      substrate.harness.driver,
      ordinary.episode_id,
      'legacy-existing-target',
    ),
  ).toContain('DERIVES_FROM');
  mergeExperienceProvenance(store.db, id, { derived_from: ['legacy-existing-target'] });
  const bounds = archiveRowidBounds(store.db);
  const outcome = await coordinator.publish({
    kind: 'legacy_materialization',
    operationId: 'legacy-reference-check',
    payload: {
      mode: 'source',
      sourceId: id,
      cohortId: 'references',
      archiveRowidLow: bounds.low,
      archiveRowidHigh: bounds.high,
      relationLimit: 500,
      reverify: true,
    },
  });
  expect(outcome.status).toBe('acknowledged');
  expect(listStatedLinks(store.db, id).filter((link) => link.kind === 'derived_from')).toHaveLength(
    1,
  );
  expect(listEvidenceAcknowledgments(store.db, id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ effectKind: 'stated_references', state: 'completed' }),
    ]),
  );
  expect(getLedgerEntry(store.db, `stated-references:${id}`)).toBeDefined();
  expect(
    await relationshipTypesBetween(substrate.harness.driver, id, 'legacy-existing-target'),
  ).toContain('DERIVES_FROM');
});
