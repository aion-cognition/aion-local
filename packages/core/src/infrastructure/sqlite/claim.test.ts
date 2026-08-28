import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STALE_CLAIM_TIMEOUT_MS, ReflectionQueueClaimant, reclaimStaleReflectionJobs } from './claim.js';
import { SqliteStore } from './database.js';
import { enqueueReflectionJob, getReflectionJob } from './reflection-queue.js';

describe('reflection job claiming', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-claim-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('claims the oldest unclaimed job in enqueue order', () => {
    const first = enqueueReflectionJob(store.db, 'integrate', { n: 1 });
    const second = enqueueReflectionJob(store.db, 'integrate', { n: 2 });
    const claimant = new ReflectionQueueClaimant();

    expect(claimant.claimNext(store.db)?.id).toBe(first);
    expect(claimant.claimNext(store.db)?.id).toBe(second);
    expect(claimant.claimNext(store.db)).toBeUndefined();
  });

  it('stamps claimed_at and claimed_by, and skips an already-claimed row', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const claimant = new ReflectionQueueClaimant();

    const claimed = claimant.claimNext(store.db);
    expect(claimed?.claimedBy).toBe(claimant.id);
    expect(claimed?.claimedAt).not.toBeNull();

    const other = new ReflectionQueueClaimant();
    expect(other.claimNext(store.db)).toBeUndefined();
    expect(getReflectionJob(store.db, id)?.claimedBy).toBe(claimant.id);
  });

  it('returns undefined against an empty queue', () => {
    expect(new ReflectionQueueClaimant().claimNext(store.db)).toBeUndefined();
  });

  it('release clears the claim, counts the attempt, and records the error', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const claimant = new ReflectionQueueClaimant();
    claimant.claimNext(store.db);

    const released = claimant.release(store.db, id, 'ollama timeout');
    expect(released).toBe(true);

    const job = getReflectionJob(store.db, id);
    expect(job?.claimedAt).toBeNull();
    expect(job?.claimedBy).toBeNull();
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toBe('ollama timeout');
  });

  it('a released job is claimable again', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const claimant = new ReflectionQueueClaimant();
    claimant.claimNext(store.db);
    claimant.release(store.db, id, 'boom');

    const reclaimed = claimant.claimNext(store.db);
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(1);
  });

  it('skips a row that has spent the attempts the caller allows, and still claims it unbounded', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const claimant = new ReflectionQueueClaimant();
    claimant.claimNext(store.db, 2);
    claimant.release(store.db, id, 'boom');
    claimant.claimNext(store.db, 2);
    claimant.release(store.db, id, 'boom again');

    expect(claimant.claimNext(store.db, 2)).toBeUndefined();
    expect(claimant.claimNext(store.db)?.attempts).toBe(2);
  });

  it('release no-ops for a claim this instance does not hold', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const owner = new ReflectionQueueClaimant();
    owner.claimNext(store.db);

    const impostor = new ReflectionQueueClaimant();
    expect(impostor.release(store.db, id, 'boom')).toBe(false);
    expect(getReflectionJob(store.db, id)?.claimedBy).toBe(owner.id);
  });

  it('release no-ops on an unclaimed id', () => {
    expect(new ReflectionQueueClaimant().release(store.db, 'does-not-exist', 'boom')).toBe(false);
  });

  it('complete deletes the row on success', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const claimant = new ReflectionQueueClaimant();
    claimant.claimNext(store.db);

    expect(claimant.complete(store.db, id)).toBe(true);
    expect(getReflectionJob(store.db, id)).toBeUndefined();
  });

  it('complete no-ops for a claim this instance does not hold, leaving the row intact', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const owner = new ReflectionQueueClaimant();
    owner.claimNext(store.db);

    const impostor = new ReflectionQueueClaimant();
    expect(impostor.complete(store.db, id)).toBe(false);
    expect(getReflectionJob(store.db, id)).toBeDefined();
  });

  it('complete no-ops on an unclaimed row', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    expect(new ReflectionQueueClaimant().complete(store.db, id)).toBe(false);
    expect(getReflectionJob(store.db, id)).toBeDefined();
  });

  it('reclaims a claim older than the timeout, leaving attempts and last_error untouched', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const claimant = new ReflectionQueueClaimant();
    claimant.claimNext(store.db);

    const farFuture = new Date(Date.now() + DEFAULT_STALE_CLAIM_TIMEOUT_MS + 1000);
    const reclaimedCount = reclaimStaleReflectionJobs(store.db, DEFAULT_STALE_CLAIM_TIMEOUT_MS, farFuture);

    expect(reclaimedCount).toBe(1);
    const job = getReflectionJob(store.db, id);
    expect(job?.claimedAt).toBeNull();
    expect(job?.claimedBy).toBeNull();
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toBeNull();
  });

  it('leaves a fresh claim alone', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', {});
    const claimant = new ReflectionQueueClaimant();
    claimant.claimNext(store.db);

    const reclaimedCount = reclaimStaleReflectionJobs(store.db, DEFAULT_STALE_CLAIM_TIMEOUT_MS, new Date());

    expect(reclaimedCount).toBe(0);
    expect(getReflectionJob(store.db, id)?.claimedBy).toBe(claimant.id);
  });

  it('leaves an unclaimed job alone', () => {
    enqueueReflectionJob(store.db, 'integrate', {});
    expect(reclaimStaleReflectionJobs(store.db, DEFAULT_STALE_CLAIM_TIMEOUT_MS, new Date())).toBe(0);
  });
});
