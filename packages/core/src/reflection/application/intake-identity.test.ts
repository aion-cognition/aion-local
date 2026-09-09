import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readIntakeWatermark } from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  listStageWork,
  readActiveGeneration,
} from '../../infrastructure/sqlite/processing-generations.js';
import { recordReadinessPolicy } from '../../infrastructure/sqlite/readiness-policies.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import {
  listReferenceBatches,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import {
  listEvidenceAcknowledgments,
  readSessionRemainder,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { SessionManager } from '../../session/session-manager.js';
import { directIntakePublisher } from '../test-support/direct-intake.fixture.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';
const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-08T06:00:00.000Z');

const PAYLOAD = {
  turns: [
    { role: 'user', text: 'why did the sync key on id_slug' },
    { role: 'assistant', text: 'the external ids churn' },
  ],
  observations: ['keyed the sync on id_slug'],
};

let graph: FakeGraph;
let db: SqliteHandle;
let dataDir: string;
let deps: ReflectionIntakeDeps;

function fakeVectors(texts: readonly string[]): Vector[] {
  return texts.map((_unused, index) =>
    Array.from({ length: EMBED_DIMENSION }, (__unused, slot) => (index + 1) / (slot + 1)),
  );
}

function sourceParts(sourceId: string): { part_kind: string; ordinal: number }[] {
  return db
    .prepare(
      'SELECT part_kind, ordinal FROM source_parts WHERE source_id = ? ORDER BY part_kind, ordinal',
    )
    .all(sourceId) as { part_kind: string; ordinal: number }[];
}

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);
  dataDir = mkdtempSync(join(tmpdir(), 'aion-intake-identity-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  deps = {
    driver: graph.driver,
    db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    provider: {
      embed: vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts))),
      generate: vi.fn(() => Promise.reject(new Error('intake must never call generate'))),
    },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: 4.5,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications: directIntakePublisher(graph.driver, db),
    acceptHookCapture: true,
  };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The integrate rows alone: an acceptance also enqueues the source-index work it owes. */
function integrateJobs(handle: SqliteHandle): ReturnType<typeof listReflectionJobs> {
  return listReflectionJobs(handle).filter((job) => job.jobType === 'integrate');
}

describe('what an accepted push leaves in the identity records', () => {
  it('records the source, its parts, its ingest position and its first reference batch', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });

    const record = readSourceRecord(db, result.episode_id);
    expect(record).toMatchObject({
      verificationStatus: 'verified',
      captureOrderBasis: 'archive_acceptance',
    });
    expect(record?.canonicalArchiveId).not.toBeNull();
    expect(sourceParts(result.episode_id)).toEqual([
      { part_kind: 'observation', ordinal: 0 },
      { part_kind: 'turn', ordinal: 0 },
      { part_kind: 'turn', ordinal: 1 },
    ]);
    expect(readIntakeWatermark(db)).toBe(1);
    expect(listReferenceBatches(db, result.episode_id)).toHaveLength(1);
    expect(readSessionRemainder(db, record?.sessionId ?? '')).toBeDefined();
  });

  it('names the graph turn nodes as the parts they are', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });

    const turnIds = db
      .prepare(
        "SELECT turn_id FROM source_parts WHERE source_id = ? AND part_kind = 'turn' ORDER BY ordinal",
      )
      .all(result.episode_id) as { turn_id: string | null }[];
    expect(turnIds.every((row) => row.turn_id !== null)).toBe(true);
    expect(new Set(turnIds.map((row) => row.turn_id)).size).toBe(2);
  });

  it('activates one generation and owes the two effects of its accepted batch', async () => {
    recordReadinessPolicy(db, {
      policyRevision: 1,
      pipelineVersion: 'test',
      stageNames: ['entities', 'cognitive'],
      contractDigest: 'digest',
      transferCapabilities: [],
      createdAt: NOW,
    });

    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });

    expect(readActiveGeneration(db, result.episode_id)?.processingGeneration).toBe(1);
    expect(listStageWork(db, result.episode_id, 1).map((row) => row.stageName)).toEqual([
      'cognitive',
      'entities',
    ]);
    expect(
      listEvidenceAcknowledgments(db, result.episode_id).map((entry) => entry.effectKind),
    ).toEqual(['semantic_processing', 'source_index']);
  });

  it('owes a durable inventory obligation when no readiness policy has been published', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });

    const owed = db
      .prepare('SELECT kind, work_key FROM source_work WHERE source_id = ?')
      .all(result.episode_id);
    expect(owed).toEqual([{ kind: 'inventory', work_key: 'inventory:pending_policy' }]);
  });

  it('leaves one set of records behind a re-push of the same experience', async () => {
    const first = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });
    const second = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });

    expect(second.episode_id).toBe(first.episode_id);
    expect(readIntakeWatermark(db)).toBe(1);
    expect(listReferenceBatches(db, first.episode_id)).toHaveLength(1);
    expect(readActiveGeneration(db, first.episode_id)?.processingGeneration).toBe(1);
    expect(integrateJobs(db)).toHaveLength(1);
  });

  it('stores the episode on the queue row rather than only in its payload', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });

    expect(integrateJobs(db).map((job) => job.episodeId)).toEqual([result.episode_id]);
  });
});

describe('a request past its bounds', () => {
  it('writes nothing at all when a count bound is exceeded', async () => {
    const oversized = {
      observations: Array.from({ length: 65 }, (_unused, index) => `observation ${String(index)}`),
    };

    await expect(
      handleReflection(deps, oversized, { identity: 'session-a', now: NOW }),
    ).rejects.toThrow();

    expect(graph.statements).toHaveLength(0);
    expect(integrateJobs(db)).toHaveLength(0);
    expect(readIntakeWatermark(db)).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM source_records').get() as { n: number }).n).toBe(
      0,
    );
    expect(
      (db.prepare('SELECT count(*) AS n FROM experience_archive').get() as { n: number }).n,
    ).toBe(0);
  });

  it('writes nothing at all when the byte bound is exceeded', async () => {
    const oversized = { observations: ['x'.repeat(512 * 1024)] };

    await expect(
      handleReflection(deps, oversized, { identity: 'session-a', now: NOW }),
    ).rejects.toThrow();

    expect(graph.statements).toHaveLength(0);
    expect(
      (db.prepare('SELECT count(*) AS n FROM experience_archive').get() as { n: number }).n,
    ).toBe(0);
  });
});
