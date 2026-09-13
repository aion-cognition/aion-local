import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drainSourceIndexQueue } from './source-index-queue.js';
import { runSourceIndexJob, utf8Prefix } from './source-index.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { ReflectionQueueClaimant } from '../../infrastructure/sqlite/claim.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { withoutFts5 } from '../../infrastructure/sqlite/fts-capability.fixture.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import {
  listEvidenceAcknowledgments,
  SOURCE_INDEX_EFFECT,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  listSearchDocumentsForSource,
  readIndexProgress,
  searchIndexPin,
  LIVE_INDEX_STREAM,
} from '../../infrastructure/sqlite/source-search-store.js';
import { INTAKE_JOB_TYPE, enqueueSourceWork } from '../../reflection/application/intake-queue.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';

const H = new Date('2026-09-01T00:00:00.000Z');
const NOW = new Date('2026-09-08T10:00:00.000Z');

const CONTENT: ReflectionContent = {
  summary: 'the deploy conversation',
  turns: [
    { role: 'user', text: 'the costs qualifier seed missed again', occurred_at: NOW.toISOString() },
    { role: 'assistant', text: 'recorded the qualifier', occurred_at: NOW.toISOString() },
  ],
  observations: ['the runbook was out of date'],
};

const logger = { warn: () => undefined, debug: () => undefined };

function stubDriver(): Driver {
  return { executeQuery: () => Promise.resolve({ records: [] }) } as unknown as Driver;
}

describe('the source-index queue path', () => {
  let dir: string;
  let store: SqliteStore;
  let deps: {
    readonly db: SqliteStore['db'];
    readonly resolver: EvidenceResolver;
    readonly now: () => Date;
    readonly logger: typeof logger;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-source-index-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, { activatedAt: H, fieldPolicyVersion: 1 });
    seedSource(store.db, {
      sourceId: 'episode-1',
      sessionId: 'session-1',
      identity: 'agent-1',
      content: CONTENT,
      turnIds: ['turn-a', 'turn-b'],
      now: NOW,
    });
    enqueueSourceWork(
      store.db,
      {
        sourceId: 'episode-1',
        sessionId: 'session-1',
        lane: null,
        indexPolicy: 'index:1',
        acceptedAt: NOW.toISOString(),
      },
      'operation-1',
    );
    deps = {
      db: store.db,
      resolver: new EvidenceResolver({ driver: stubDriver(), db: store.db, logger }),
      now: () => NOW,
      logger,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the index row out of an ordinary reflection claim', () => {
    const claimed = new ReflectionQueueClaimant().claimNext(store.db, undefined, [INTAKE_JOB_TYPE]);
    expect(claimed?.jobType).toBe(INTAKE_JOB_TYPE);
    const again = new ReflectionQueueClaimant().claimNext(store.db, undefined, [INTAKE_JOB_TYPE]);
    expect(again).toBeUndefined();
    expect(
      listReflectionJobs(store.db)
        .map((job) => job.jobType)
        .sort(),
    ).toEqual(['attach_vectors', 'integrate', 'source_index']);
  });

  it('claims the index row, indexes the source, and takes the row off the queue', async () => {
    const drain = await drainSourceIndexQueue(deps);

    expect(drain).toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    expect(drain.documents).toBe(3);
    expect(listSearchDocumentsForSource(store.db, 'episode-1')).toHaveLength(3);
    expect(
      listReflectionJobs(store.db)
        .map((job) => job.jobType)
        .sort(),
    ).toEqual(['attach_vectors', 'integrate']);
  });

  it('discharges the acceptance obligation only when the whole source is indexed', async () => {
    const owed = listEvidenceAcknowledgments(store.db, 'episode-1').filter(
      (row) => row.effectKind === SOURCE_INDEX_EFFECT,
    );
    expect(owed.map((row) => row.state)).toEqual(['owed']);

    await drainSourceIndexQueue(deps);

    const settled = listEvidenceAcknowledgments(store.db, 'episode-1').filter(
      (row) => row.effectKind === SOURCE_INDEX_EFFECT,
    );
    expect(settled.map((row) => row.state)).toEqual(['completed']);
    expect(searchIndexPin(store.db, 'episode-1')).toEqual({ pinned: false });
  });

  it('writes each part once, so a repeated run replaces nothing', async () => {
    const first = await runSourceIndexJob(deps, { sourceId: 'episode-1' });
    const second = await runSourceIndexJob(deps, { sourceId: 'episode-1' });

    expect(first).toMatchObject({ status: 'indexed', documents: 3, replaced: 0 });
    expect(second).toMatchObject({ status: 'indexed', documents: 3, replaced: 0 });
    expect(listSearchDocumentsForSource(store.db, 'episode-1')).toHaveLength(3);
  });

  it('keeps the obligation and the queue row when the capability is gone', async () => {
    const drain = await drainSourceIndexQueue({ ...deps, db: withoutFts5(store.db) });

    expect(drain).toMatchObject({ claimed: 1, completed: 0, deferred: 1 });
    const row = listReflectionJobs(store.db).find((job) => job.jobType === 'source_index');
    expect(row?.lastError).toContain('fts5_unavailable');
    expect(row?.claimedAt).toBeNull();
    const owed = listEvidenceAcknowledgments(store.db, 'episode-1').filter(
      (entry) => entry.effectKind === SOURCE_INDEX_EFFECT,
    );
    expect(owed.map((entry) => entry.state)).toEqual(['owed']);
    expect(searchIndexPin(store.db, 'episode-1')).toMatchObject({ pinned: true });
  });

  it('clears its cursor when the source ends and leaves the generation alone', async () => {
    await runSourceIndexJob(deps, { sourceId: 'episode-1' });
    const progress = readIndexProgress(store.db, LIVE_INDEX_STREAM);

    expect(progress?.cursor).toBe('');
    expect(progress?.state).toBe('idle');
    expect(progress?.generation).toBe(1);
  });

  it('cuts an oversized part on a character boundary rather than mid-sequence', () => {
    const text = 'é'.repeat(10);
    const cut = utf8Prefix(text, 5);

    expect(cut.truncated).toBe(true);
    expect(cut.bytes).toBe(4);
    expect(cut.body).toBe('éé');
    expect(cut.body).not.toContain('�');
    expect(utf8Prefix(text, 1024)).toEqual({ body: text, bytes: 20, truncated: false });
  });
});
