import {
  enqueueReflectionJob,
  listReflectionJobs,
  ReflectionQueueClaimant,
  SOURCE_INDEX_JOB_TYPE,
  SqliteStore,
  type ReflectionLane,
} from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseQueueFlags, renderQueueJobs, runQueue } from './queue.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseQueueFlags', () => {
  it('defaults to ls with no filters', () => {
    expect(parseQueueFlags([])).toEqual({ subcommand: 'ls', reEnqueue: false, yes: false });
  });

  it('reads every option', () => {
    expect(
      parseQueueFlags(['drop', '--session', 's-1', '--lane', 'bulk', '--limit', '5', '--yes']),
    ).toEqual({
      subcommand: 'drop',
      session: 's-1',
      lane: 'bulk',
      limit: 5,
      reEnqueue: false,
      yes: true,
    });
  });

  it('rejects an unknown subcommand, option, missing value, or bad lane', () => {
    expect(() => parseQueueFlags(['purge'])).toThrow("unknown queue subcommand 'purge'");
    expect(() => parseQueueFlags(['ls', '--everything'])).toThrow(
      "unknown option '--everything' for queue",
    );
    expect(() => parseQueueFlags(['ls', '--session'])).toThrow('--session needs a value');
    expect(() => parseQueueFlags(['ls', '--lane', 'urgent'])).toThrow(
      "--lane got 'urgent', expected",
    );
    expect(() => parseQueueFlags(['ls', '--limit', 'lots'])).toThrow(
      "--limit got 'lots', expected a positive integer",
    );
    expect(() => parseQueueFlags(['ls', '--job-type', 'reflect'])).toThrow(
      "--job-type got 'reflect', expected",
    );
  });

  it('refuses to promote index rows, since promoting them breaks pending_ahead', () => {
    expect(() => parseQueueFlags(['promote', '--job-type', SOURCE_INDEX_JOB_TYPE])).toThrow(
      'promote does not move source_index rows',
    );
    expect(parseQueueFlags(['drop', '--job-type', SOURCE_INDEX_JOB_TYPE]).jobType).toBe(
      SOURCE_INDEX_JOB_TYPE,
    );
  });
});

describe('renderQueueJobs', () => {
  it('says so when nothing matched', () => {
    const { lines, write } = collector();
    renderQueueJobs([], new Date(), write);
    expect(lines).toEqual(['no matching jobs']);
  });
});

describe('aion queue against a seeded substrate', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-cli-queue-'));
    process.env.AION_SQLITE_PATH = join(dir, 'aion.sqlite');
    process.env.AION_LOG_FILE = join(dir, 'aion.jsonl');
    process.env.AION_LOG_LEVEL = 'fatal';
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    delete process.env.AION_SQLITE_PATH;
    delete process.env.AION_LOG_FILE;
    delete process.env.AION_LOG_LEVEL;
    rmSync(dir, { recursive: true, force: true });
  });

  function enqueue(sessionId: string, lane: ReflectionLane, label: string): string {
    return enqueueReflectionJob(store.db, 'integrate', { episode_id: label }, { lane, sessionId });
  }

  function seed(): void {
    enqueue('flood', 'bulk', 'flood-0');
    enqueue('flood', 'bulk', 'flood-1');
    enqueue('agent', 'interactive', 'live-0');
  }

  /** The other row an acceptance writes, always bulk, owned by the index drainer. */
  function enqueueIndex(sessionId: string, label: string): string {
    return enqueueReflectionJob(
      store.db,
      SOURCE_INDEX_JOB_TYPE,
      { episode_id: label },
      { lane: 'bulk', sessionId },
    );
  }

  it('lists the queue with lanes, sessions and a per-lane depth', async () => {
    seed();
    const { lines, write } = collector();

    expect(await runQueue(['ls'], write)).toBe(0);

    const output = lines.join('\n');
    expect(output).toContain('bulk');
    expect(output).toContain('flood');
    expect(output).toContain('matched  3 jobs: 3 unclaimed, 0 claimed, 0 exhausted');
    expect(output).toContain('pending  interactive=1 bulk=2');
  });

  it('filters a listing by session', async () => {
    seed();
    const { lines, write } = collector();

    await runQueue(['ls', '--session', 'agent'], write);

    expect(lines.join('\n')).toContain('matched  1 jobs');
  });

  it('reports what a drop would remove and changes nothing without --yes', async () => {
    seed();
    const { lines, write } = collector();

    expect(await runQueue(['drop', '--session', 'flood'], write)).toBe(0);

    expect(lines.join('\n')).toContain('would drop 2 unclaimed jobs matching session=flood');
    expect(listReflectionJobs(store.db)).toHaveLength(3);
  });

  it('drops one session with --yes and leaves the rest queued', async () => {
    seed();
    const { lines, write } = collector();

    await runQueue(['drop', '--session', 'flood', '--yes'], write);

    expect(lines.join('\n')).toContain('dropped 2 unclaimed jobs');
    expect(listReflectionJobs(store.db).map((job) => job.sessionId)).toEqual(['agent']);
  });

  it('never drops a job a worker is running', async () => {
    enqueue('flood', 'bulk', 'flood-0');
    const claimed = new ReflectionQueueClaimant().claimNext(store.db);
    const { lines, write } = collector();

    await runQueue(['drop', '--yes'], write);

    expect(lines.join('\n')).toContain('nothing to drop');
    expect(listReflectionJobs(store.db).map((job) => job.id)).toEqual([claimed?.id]);
  });

  it('promotes a session out of the bulk lane', async () => {
    seed();
    const { lines, write } = collector();

    await runQueue(['promote', '--session', 'flood'], write);

    expect(lines.join('\n')).toContain('promoted 2 unclaimed jobs to the interactive lane');
    expect(listReflectionJobs(store.db).every((job) => job.lane === 'interactive')).toBe(true);
  });

  it('counts the reflection backlog and the index rows as two numbers, never one', async () => {
    seed();
    enqueueIndex('flood', 'flood-0');
    enqueueIndex('flood', 'flood-1');
    enqueueIndex('agent', 'live-0');
    const { lines, write } = collector();

    expect(await runQueue(['ls'], write)).toBe(0);

    const output = lines.join('\n');
    expect(output).toContain('matched  6 jobs: 6 unclaimed, 0 claimed, 0 exhausted');
    // The per-lane line is the reflection backlog alone: all three index rows are bulk.
    expect(output).toContain('pending  interactive=1 bulk=2');
    expect(output).toContain('index    3 source_index rows pending');
    expect(output).toContain(SOURCE_INDEX_JOB_TYPE);
  });

  it('leaves index rows alone on a drop, and says how many it spared', async () => {
    seed();
    enqueueIndex('flood', 'flood-0');
    const { lines, write } = collector();

    await runQueue(['drop', '--session', 'flood', '--yes'], write);

    const output = lines.join('\n');
    expect(output).toContain('1 unclaimed source_index rows are excluded');
    expect(output).toContain('dropped 2 unclaimed jobs matching session=flood job-type=integrate');
    expect(
      listReflectionJobs(store.db)
        .map((job) => job.jobType)
        .sort(),
    ).toEqual(['integrate', SOURCE_INDEX_JOB_TYPE]);
  });

  it('drops index rows only when asked for them by name', async () => {
    seed();
    enqueueIndex('flood', 'flood-0');
    const { lines, write } = collector();

    await runQueue(['drop', '--job-type', SOURCE_INDEX_JOB_TYPE, '--yes'], write);

    expect(lines.join('\n')).toContain('dropped 1 unclaimed jobs');
    expect(listReflectionJobs(store.db).every((job) => job.jobType === 'integrate')).toBe(true);
  });

  it('promotes the reflection backlog and leaves the index rows in the bulk lane', async () => {
    seed();
    const indexId = enqueueIndex('flood', 'flood-0');
    const { write } = collector();

    await runQueue(['promote', '--session', 'flood'], write);

    const promoted = listReflectionJobs(store.db);
    expect(promoted.filter((job) => job.lane === 'interactive')).toHaveLength(3);
    // `pending_ahead` reads the interactive lane, so an index row that moved would be counted
    // against every live turn until it drained.
    expect(promoted.find((job) => job.id === indexId)?.lane).toBe('bulk');
  });

  it('rejects a bad option before opening anything', async () => {
    const { lines, write } = collector();

    expect(await runQueue(['ls', '--nope'], write)).toBe(1);
    expect(lines).toEqual([]);
  });
});
