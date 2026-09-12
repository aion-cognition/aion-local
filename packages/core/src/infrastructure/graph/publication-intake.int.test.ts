import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { bootstrapBackbone } from './backbone.js';
import { runGraphMigrations } from './migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { episodeIdsInSession, turnsOfEpisode } from './test-support/graph-queries.fixture.js';
import { intakePublication } from '../../reflection/application/intake-publication.js';
import { prepareEpisode, type ReflectionContent } from '../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import type { PublicationBoundary } from '../publication/types.js';
import { SqliteStore } from '../sqlite/database.js';
import { ARCHIVE_SCHEMA_VERSION, experienceArchiveKey } from '../sqlite/experience-archive.js';
import { readActiveGeneration, readGeneration } from '../sqlite/processing-generations.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../sqlite/publication-intents.js';
import { listReflectionJobs } from '../sqlite/reflection-queue.js';
import { listReferenceBatches } from '../sqlite/source-identity.js';
import { readSessionRemainder, transitionSourceResidency } from '../sqlite/source-lifecycle.js';
import { occurrenceCandidates } from '../sqlite/source-occurrence.js';
import { recordSourceStateVersion } from '../sqlite/source-state-versions.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let failAt: PublicationBoundary | undefined;
let serial = 0;

function content(marker: string): ReflectionContent {
  return {
    turns: [
      { role: 'user', text: `why did the sync key on id_slug ${marker}` },
      { role: 'assistant', text: `the external ids churn ${marker}` },
    ],
    observations: [`keyed the sync on id_slug ${marker}`],
  };
}

function payload(marker: string): Record<string, unknown> {
  return {
    identity: 'member-1',
    sessionId,
    payloadJson: JSON.stringify(content(marker)),
    referencesJson: null,
    lane: null,
    originJson: JSON.stringify({ channel: 'mcp' }),
    pipelineVersion: PIPELINE_VERSION,
    occurredAt: NOW.toISOString(),
    indexPolicy: 'archive-v1',
    readiness: { policyRevision: 1, stageNames: ['entities', 'cognitive'] },
  };
}

function archiveRows(): number {
  return (store.db.prepare('SELECT count(*) AS n FROM experience_archive').get() as { n: number })
    .n;
}

function jobsOfType(jobType: string): number {
  return listReflectionJobs(store.db).filter((job) => job.jobType === jobType).length;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-intake-publication-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, {
    embedDimension: EMBED_DIMENSION,
  });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const sessions = new SessionManager(substrate.harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  ({ sessionId } = await sessions.ensureSession({ identity: 'transport-1', now: NOW }));
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, intakePublication],
    now: () => NOW,
    boundary: ({ boundary }) => {
      expect(store.db.inTransaction).toBe(false);
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted intake');
      }
    },
  });
  await coordinator.initialize();
}, 120_000);

beforeEach(() => {
  failAt = undefined;
  serial += 1;
});

afterEach(async () => {
  failAt = undefined;
  await coordinator.recover();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('mints one source, projects it, and only then makes its work claimable', async () => {
  const marker = `plain-${String(serial)}`;
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-${marker}`,
    payload: payload(marker),
  });

  expect(outcome.status).toBe('acknowledged');
  const result = outcome.status === 'acknowledged' ? outcome.result : undefined;
  const { sourceId } = result as { sourceId: string };
  expect((result as { created: boolean }).created).toBe(true);
  expect(await episodeIdsInSession(substrate.harness.driver, sessionId)).toContain(sourceId);
  expect(await turnsOfEpisode(substrate.harness.driver, sourceId)).toHaveLength(2);
  expect(readActiveGeneration(store.db, sourceId)?.processingGeneration).toBe(1);
  expect(listReferenceBatches(store.db, sourceId)).toHaveLength(1);
  expect(readSessionRemainder(store.db, sessionId)).toBeDefined();
  const jobs = listReflectionJobs(store.db).filter((job) => job.episodeId === sourceId);
  expect(jobs.map((job) => job.jobType).sort()).toEqual(['integrate', 'source_index']);
});

it('keeps the queue empty and the generation inactive until the acknowledgment runs', async () => {
  const marker = `before-ack-${String(serial)}`;
  failAt = 'before_ack';
  await expect(
    coordinator.publish({
      kind: 'intake',
      operationId: `intake-${marker}`,
      payload: payload(marker),
    }),
  ).rejects.toThrow();

  const [sourceId] = occurrenceCandidatesFor(marker);
  expect(sourceId).toBeDefined();
  expect(readGeneration(store.db, sourceId ?? '', 1)?.state).toBe('allocated');
  expect(readActiveGeneration(store.db, sourceId ?? '')).toBeUndefined();
  expect(listReflectionJobs(store.db).filter((job) => job.episodeId === sourceId)).toEqual([]);
});

it('resumes the ids it already minted when the graph write never happened', async () => {
  const marker = `crash-${String(serial)}`;
  const request = {
    kind: 'intake' as const,
    operationId: `intake-${marker}`,
    payload: payload(marker),
  };
  failAt = 'prepared';
  await expect(coordinator.publish(request)).rejects.toThrow();
  const beforeRetry = occurrenceCandidatesFor(marker);
  expect(beforeRetry).toHaveLength(1);
  expect(await episodeIdsInSession(substrate.harness.driver, sessionId)).not.toContain(
    beforeRetry[0],
  );

  const outcome = await coordinator.publish(request);

  expect(outcome.status).toBe('acknowledged');
  expect(occurrenceCandidatesFor(marker)).toEqual(beforeRetry);
  const sourceId = beforeRetry[0] ?? '';
  expect(await episodeIdsInSession(substrate.harness.driver, sessionId)).toContain(sourceId);
  expect(listReferenceBatches(store.db, sourceId)).toHaveLength(1);
  expect(listReflectionJobs(store.db).filter((job) => job.episodeId === sourceId)).toHaveLength(2);
});

it('converges two identical first acceptances on one source and one part set', async () => {
  const marker = `converge-${String(serial)}`;
  const first = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-a-${marker}`,
    payload: payload(marker),
  });
  const before = archiveRows();
  const second = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-b-${marker}`,
    payload: payload(marker),
  });

  const firstId =
    first.status === 'acknowledged' ? (first.result as { sourceId: string }) : undefined;
  const secondResult =
    second.status === 'acknowledged'
      ? (second.result as { sourceId: string; created: boolean })
      : undefined;
  expect(secondResult?.sourceId).toBe(firstId?.sourceId);
  expect(secondResult?.created).toBe(false);
  expect(archiveRows()).toBe(before);
  expect(occurrenceCandidatesFor(marker)).toHaveLength(1);
  expect(listReferenceBatches(store.db, firstId?.sourceId ?? '')).toHaveLength(1);
});

it('returns its own recorded result to a driver retry of the same request', async () => {
  const marker = `retry-${String(serial)}`;
  const request = {
    kind: 'intake' as const,
    operationId: `intake-${marker}`,
    payload: payload(marker),
  };
  const first = await coordinator.publish(request);
  const before = jobsOfType('integrate');

  expect(await coordinator.publish(request)).toEqual(first);
  expect(jobsOfType('integrate')).toBe(before);
});

it('mints a new occurrence for a push that arrives after its predecessor was forgotten', async () => {
  const marker = `forgotten-${String(serial)}`;
  const first = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-a-${marker}`,
    payload: payload(marker),
  });
  const original =
    first.status === 'acknowledged' ? (first.result as { sourceId: string }) : undefined;
  recordSourceStateVersion(store.db, {
    sourceId: original?.sourceId ?? '',
    stateKind: 'forgotten',
    operationId: `forget-${marker}`,
    observedAt: NOW,
    knownFrom: NOW,
  });
  // The statement counts once its own publication is acknowledged, which is what a committed
  // read asks for: a timestamp on the row is not an acknowledgment.
  preparePublicationIntent(store.db, {
    operationId: `forget-${marker}`,
    kind: 'source_suppression',
    payloadDigest: `digest-${marker}`,
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  acknowledgePublicationIntent(store.db, {
    operationId: `forget-${marker}`,
    resultDigest: `result-${marker}`,
    resultJson: '{}',
    observedAckAt: NOW,
  });

  const second = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-b-${marker}`,
    payload: payload(marker),
  });

  const replacement =
    second.status === 'acknowledged'
      ? (second.result as { sourceId: string; created: boolean })
      : undefined;
  expect(replacement?.created).toBe(true);
  expect(replacement?.sourceId).not.toBe(original?.sourceId);
  expect(occurrenceCandidatesFor(marker)).toHaveLength(2);
  expect(readActiveGeneration(store.db, replacement?.sourceId ?? '')?.processingGeneration).toBe(1);
  expect(readActiveGeneration(store.db, original?.sourceId ?? '')?.processingGeneration).toBe(1);
});

it('answers with the original id for an evicted duplicate and rebuilds no projection', async () => {
  const marker = `evicted-${String(serial)}`;
  const first = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-a-${marker}`,
    payload: payload(marker),
  });
  const original =
    first.status === 'acknowledged' ? (first.result as { sourceId: string }) : undefined;
  const sourceId = original?.sourceId ?? '';
  transitionSourceResidency(store.db, {
    sourceId,
    state: 'evicted',
    operationId: 'operation-evict',
    transitionedAt: NOW,
  });
  const before = archiveRows();
  const episodesBefore = await episodeIdsInSession(substrate.harness.driver, sessionId);

  const second = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-b-${marker}`,
    payload: payload(marker),
  });

  const duplicate =
    second.status === 'acknowledged'
      ? (second.result as { sourceId: string; created: boolean })
      : undefined;
  expect(duplicate).toEqual({ sourceId, created: false, turnIds: [] });
  expect(archiveRows()).toBe(before);
  expect(await episodeIdsInSession(substrate.harness.driver, sessionId)).toEqual(episodesBefore);
  expect(await turnsOfEpisode(substrate.harness.driver, sourceId)).toHaveLength(2);
  expect(listReferenceBatches(store.db, sourceId)).toHaveLength(1);
});

it('pins an ambiguous key and mints nothing for it', async () => {
  const marker = `ambiguous-${String(serial)}`;
  await coordinator.publish({
    kind: 'intake',
    operationId: `intake-a-${marker}`,
    payload: payload(marker),
  });
  const [held] = occurrenceCandidatesFor(marker);
  store.db
    .prepare(
      `INSERT INTO source_records (source_id, session_id, identity_hash, verification_status,
         verification_reason, occurred_at, created_at)
       SELECT 'rival-' || ?, session_id, identity_hash, 'pinned', 'fixture rival',
              occurred_at, created_at
       FROM source_records WHERE source_id = ?`,
    )
    .run(marker, held ?? '');
  const before = archiveRows();

  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-b-${marker}`,
    payload: payload(marker),
  });

  expect(outcome).toMatchObject({ status: 'rejected', reason: 'occurrence_ambiguous' });
  expect(archiveRows()).toBe(before);
  // The pin is the durable intent itself: it records the rejection and the candidates that
  // produced it, so the ambiguity is inspectable rather than lost with the refused call.
  const pinned = store.db
    .prepare(
      `SELECT error, prepared_actions_json AS actions FROM publication_intents
       WHERE operation_id = ?`,
    )
    .get(`intake-b-${marker}`) as { error: string; actions: string };
  expect(pinned.error).toBe('occurrence_ambiguous');
  expect(JSON.parse(pinned.actions)).toMatchObject({
    data: { decision: 'pinned', pinnedCandidates: [held, `rival-${marker}`] },
  });
});

/** The occurrences a marker's payload resolves to, read straight out of the records. */
function occurrenceCandidatesFor(marker: string): readonly string[] {
  const identityHash = experienceArchiveKey(
    'member-1',
    prepareEpisode(content(marker), NOW).contentHash,
    ARCHIVE_SCHEMA_VERSION,
  );
  return occurrenceCandidates(store.db, { identityHash, sessionId });
}
