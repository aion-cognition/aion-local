import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReflectionQueueClaimant } from './claim.js';
import { SqliteStore } from './database.js';
import { enqueueReflectionJob, type ReflectionJob, type ReflectionLane } from './reflection-queue.js';

/**
 * The claim order the live incident needed and did not have: 4,016 bulk jobs sat ahead of
 * every real episode in one FIFO queue, and wait loops expecting minutes would have
 * resolved in days.
 */

describe('reflection queue claim ordering', () => {
  let dir: string;
  let store: SqliteStore;
  let claimant: ReflectionQueueClaimant;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-lane-claim-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    claimant = new ReflectionQueueClaimant();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function enqueue(sessionId: string, lane: ReflectionLane, label: string): string {
    return enqueueReflectionJob(store.db, 'integrate', { label }, { lane, sessionId });
  }

  function claimAll(maxAttempts?: number): ReflectionJob[] {
    const claimed: ReflectionJob[] = [];
    let job = claimant.claimNext(store.db, maxAttempts);
    while (job !== undefined) {
      claimed.push(job);
      job = claimant.claimNext(store.db, maxAttempts);
    }
    return claimed;
  }

  function labelsOf(jobs: readonly ReflectionJob[]): string[] {
    return jobs.map((job) => (job.payload as { label: string }).label);
  }

  it('claims one interactive job ahead of a hundred bulk jobs already queued', () => {
    for (let index = 0; index < 100; index += 1) {
      enqueue('flood', 'bulk', `bulk-${String(index)}`);
    }
    enqueue('agent', 'interactive', 'live');

    const first = claimant.claimNext(store.db);

    expect(first?.lane).toBe('interactive');
    expect((first?.payload as { label: string }).label).toBe('live');
  });

  it('drains every interactive job before the first bulk one', () => {
    enqueue('flood', 'bulk', 'bulk-0');
    enqueue('agent', 'interactive', 'live-0');
    enqueue('flood', 'bulk', 'bulk-1');
    enqueue('agent', 'interactive', 'live-1');

    expect(labelsOf(claimAll())).toEqual(['live-0', 'live-1', 'bulk-0', 'bulk-1']);
  });

  it('round-robins across sessions inside a lane rather than draining one session first', () => {
    enqueue('noisy', 'interactive', 'noisy-0');
    enqueue('noisy', 'interactive', 'noisy-1');
    enqueue('noisy', 'interactive', 'noisy-2');
    enqueue('quiet', 'interactive', 'quiet-0');

    expect(labelsOf(claimAll())).toEqual(['noisy-0', 'quiet-0', 'noisy-1', 'noisy-2']);
  });

  it('keeps first-in-first-out among the first job of each session', () => {
    enqueue('a', 'interactive', 'a-0');
    enqueue('b', 'interactive', 'b-0');
    enqueue('c', 'interactive', 'c-0');

    expect(labelsOf(claimAll())).toEqual(['a-0', 'b-0', 'c-0']);
  });

  it('round-robins bulk sessions too, so one flood cannot starve another', () => {
    for (let index = 0; index < 5; index += 1) {
      enqueue('flood', 'bulk', `flood-${String(index)}`);
    }
    enqueue('import', 'bulk', 'import-0');

    expect(labelsOf(claimAll()).slice(0, 3)).toEqual(['flood-0', 'import-0', 'flood-1']);
  });

  // A queue row written before the lane column existed reads as interactive, which is the
  // safe direction: an unmigrated job keeps the priority it was enqueued with.
  it('treats a row with no lane or session as interactive and as one group', () => {
    enqueueReflectionJob(store.db, 'integrate', { label: 'legacy-0' });
    enqueueReflectionJob(store.db, 'integrate', { label: 'legacy-1' });
    enqueue('flood', 'bulk', 'bulk-0');

    const claimed = claimAll();

    expect(claimed[0]?.lane).toBe('interactive');
    expect(labelsOf(claimed)).toEqual(['legacy-0', 'legacy-1', 'bulk-0']);
  });

  it('still skips a job that has spent its attempts, in either lane', () => {
    const exhausted = enqueue('agent', 'interactive', 'exhausted');
    enqueue('agent', 'interactive', 'live');
    store.db.prepare('UPDATE reflection_queue SET attempts = 5 WHERE id = ?').run(exhausted);

    const claimed = claimAll(5);

    expect(labelsOf(claimed)).toEqual(['live']);
  });
});
