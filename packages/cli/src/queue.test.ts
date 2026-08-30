import {
  enqueueReflectionJob,
  listReflectionJobs,
  ReflectionQueueClaimant,
  SqliteStore,
  type ReflectionLane,
} from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvalidQueueValueError,
  MissingQueueValueError,
  parseQueueFlags,
  renderQueueJobs,
  runQueue,
  UnknownQueueOptionError,
  UnknownSubcommandError,
} from './queue.js';

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
    expect(() => parseQueueFlags(['purge'])).toThrow(UnknownSubcommandError);
    expect(() => parseQueueFlags(['ls', '--everything'])).toThrow(UnknownQueueOptionError);
    expect(() => parseQueueFlags(['ls', '--session'])).toThrow(MissingQueueValueError);
    expect(() => parseQueueFlags(['ls', '--lane', 'urgent'])).toThrow(InvalidQueueValueError);
    expect(() => parseQueueFlags(['ls', '--limit', 'lots'])).toThrow(InvalidQueueValueError);
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

  it('rejects a bad option before opening anything', async () => {
    const { lines, write } = collector();

    expect(await runQueue(['ls', '--nope'], write)).toBe(1);
    expect(lines).toEqual([]);
  });
});
