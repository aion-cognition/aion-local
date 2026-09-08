import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReflectionNotStoredError } from './errors.js';
import {
  replayExperiences,
  type ReplayCursor,
  type ReplayDeps,
  type ReplayProgress,
} from './replay.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { fromGraphDateTime } from '../../infrastructure/graph/values.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { PIPELINE_VERSION } from '../domain/version.js';
import {
  archiveAllExperiences,
  archiveExperience,
  closeReplaySubstrate,
  contentFor,
  openReplaySubstrate,
  replayDeps,
  unavailableDriver,
  ARCHIVED_AT,
  OCCURRED,
  WALL_NOW,
  type ReplaySubstrate,
  type RunCall,
} from '../test-support/replay-substrate.fixture.js';

let substrate: ReplaySubstrate;
let calls: RunCall[];

beforeEach(() => {
  substrate = openReplaySubstrate();
  ({ calls } = substrate);
});

afterEach(() => {
  closeReplaySubstrate(substrate);
});

/**
 * The archive keyset a pass stopped on. These rows carry no occurrence record, so the fallback
 * pass is the one that walks them, and asserting the kind is what says so.
 */
function archiveCursor(cursor: ReplayCursor | undefined): { occurredAt: string; id: string } {
  if (cursor?.kind !== 'archive') {
    throw new Error(`expected an archive cursor, got ${String(cursor?.kind)}`);
  }
  return { occurredAt: cursor.occurredAt, id: cursor.id };
}

function stampOf(episodeId: string, property: string): string {
  const stamp = fromGraphDateTime(substrate.graph.nodes.get(episodeId)?.properties[property]);
  return stamp?.toISOString() ?? 'missing';
}

/**
 * World time on the episode each run was handed, which identifies the archived row it came
 * from: the rows are a day apart and nothing else about them differs.
 */
function worldClocks(): string[] {
  return calls.map((call) => stampOf(call.episodeId, BITEMPORAL_PROPERTIES.occurredAt));
}

/** Transaction time on those same episodes: the moment the replay committed them. */
function txClocks(): string[] {
  return calls.map((call) => stampOf(call.episodeId, BITEMPORAL_PROPERTIES.txFrom));
}

/** The clock each run was handed, which stamps its writes and ages its locks. */
function runClocks(): string[] {
  return calls.map((call) => call.options.now?.toISOString() ?? 'missing');
}

describe('replaying the whole archive', () => {
  it('visits every row once, oldest first, across three batches of two', async () => {
    archiveAllExperiences(substrate);
    const batches: ReplayProgress[] = [];

    const report = await replayExperiences(substrate.deps, {
      batchSize: 2,
      onBatch: (progress) => batches.push(progress),
    });

    expect(report.scanned).toBe(5);
    expect(report.replayed).toBe(5);
    expect(new Set(calls.map((call) => call.episodeId)).size).toBe(5);
    expect(worldClocks()).toEqual([...OCCURRED]);
    expect(batches.map((batch) => batch.scanned)).toEqual([2, 4, 5]);
    expect(batches.map((batch) => archiveCursor(batch.cursor).occurredAt)).toEqual([
      OCCURRED[1],
      OCCURRED[3],
      OCCURRED[4],
    ]);
    expect(archiveCursor(report.cursor).occurredAt).toBe(OCCURRED[4]);
    expect(report.aborted).toBe(false);
  });

  it('dates each experience to when it happened and each write to the replay', async () => {
    archiveAllExperiences(substrate);

    await replayExperiences(substrate.deps, { batchSize: 10, clock: () => WALL_NOW });

    // World time is the archived row's: a re-derived episode is dated to the conversation.
    expect(worldClocks()).toEqual([...OCCURRED]);
    // Transaction time is the replay's, on the run and on what the run wrote alike. Taking it
    // from the row instead would record a write the substrate never made in January.
    const replayed = Array(OCCURRED.length).fill(WALL_NOW.toISOString());
    expect(runClocks()).toEqual(replayed);
    expect(txClocks()).toEqual(replayed);
    for (const call of calls) {
      expect(call.options.pipelineVersion).toBe(PIPELINE_VERSION);
    }
  });

  it('gates every run on the version it was asked for', async () => {
    archiveAllExperiences(substrate);

    await replayExperiences(substrate.deps, { batchSize: 10, pipelineVersion: 'v2' });

    expect(calls.map((call) => call.options.pipelineVersion)).toEqual(Array(5).fill('v2'));
  });

  it('stops after the row limit even when more pages are waiting', async () => {
    archiveAllExperiences(substrate);

    const report = await replayExperiences(substrate.deps, { batchSize: 2, limit: 3 });

    expect(report.scanned).toBe(3);
    expect(worldClocks()).toEqual([OCCURRED[0], OCCURRED[1], OCCURRED[2]]);
  });

  it('reports nothing scanned against an empty archive', async () => {
    const report = await replayExperiences(substrate.deps, { batchSize: 2 });

    expect(report).toEqual({
      scanned: 0,
      replayed: 0,
      skipped: 0,
      unavailable: 0,
      skippedEvicted: 0,
      unrecorded: 0,
      failed: 0,
      cursor: undefined,
      aborted: false,
    });
    expect(calls).toEqual([]);
  });
});

describe('selecting which archived rows replay', () => {
  it('takes only the rows another pipeline version wrote', async () => {
    archiveExperience(substrate, 0, 'v0');
    archiveExperience(substrate, 1);
    archiveExperience(substrate, 2, 'v0');

    const report = await replayExperiences(substrate.deps, {
      batchSize: 10,
      selection: { stale: true },
    });

    expect(report.scanned).toBe(2);
    expect(worldClocks()).toEqual([OCCURRED[0], OCCURRED[2]]);
  });

  it('takes one archived episode by id', async () => {
    archiveAllExperiences(substrate);

    const report = await replayExperiences(substrate.deps, {
      batchSize: 10,
      selection: { episodeId: 'archived-episode-3' },
    });

    expect(report.scanned).toBe(1);
    expect(worldClocks()).toEqual([OCCURRED[3]]);
  });

  it('takes one session and leaves the rest of the archive alone', async () => {
    archiveAllExperiences(substrate);
    insertExperience(substrate.store.db, {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      identity: 'other-session',
      sessionId: 'other-session',
      episodeId: 'other-episode',
      contentHash: 'hash-other',
      occurredAt: OCCURRED[0],
      archivedAt: ARCHIVED_AT,
      payload: contentFor(0),
    });

    const report = await replayExperiences(substrate.deps, {
      batchSize: 10,
      selection: { sessionId: 'other-session' },
    });

    expect(report.scanned).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('what a replay counts', () => {
  it('counts a row the ledger already closed as skipped rather than replayed', async () => {
    archiveAllExperiences(substrate);
    substrate.answers.push(
      'already_applied',
      'already_applied',
      'already_applied',
      'already_applied',
    );

    const report = await replayExperiences(substrate.deps, { batchSize: 10 });

    expect({ replayed: report.replayed, skipped: report.skipped }).toEqual({
      replayed: 1,
      skipped: 4,
    });
  });

  it('counts an episode the graph cannot read back apart from a real replay', async () => {
    archiveAllExperiences(substrate);
    substrate.answers.push('episode_unavailable');

    const report = await replayExperiences(substrate.deps, { batchSize: 10 });

    expect({ replayed: report.replayed, unavailable: report.unavailable }).toEqual({
      replayed: 4,
      unavailable: 1,
    });
  });

  it('counts a row whose run throws and keeps going through the rest', async () => {
    archiveAllExperiences(substrate);
    substrate.answers.push('completed', 'completed', 'throws');

    const report = await replayExperiences(substrate.deps, { batchSize: 2 });

    expect({ scanned: report.scanned, replayed: report.replayed, failed: report.failed }).toEqual({
      scanned: 5,
      replayed: 4,
      failed: 1,
    });
    expect(worldClocks()).toEqual([...OCCURRED]);
  });

  it('stops the whole pass when the graph will not take a write', async () => {
    archiveAllExperiences(substrate);

    await expect(
      replayExperiences(
        replayDeps(
          unavailableDriver(),
          substrate.store,
          substrate.dataDir,
          calls,
          substrate.answers,
        ),
        { batchSize: 10 },
      ),
    ).rejects.toBeInstanceOf(ReflectionNotStoredError);
    expect(calls).toEqual([]);
  });
});

describe('aborting a replay', () => {
  it('stops between batches and reports the cursor it reached', async () => {
    archiveAllExperiences(substrate);
    const controller = new AbortController();

    const report = await replayExperiences(substrate.deps, {
      batchSize: 2,
      signal: controller.signal,
      onBatch: () => {
        controller.abort();
      },
    });

    expect(report.aborted).toBe(true);
    expect(report.scanned).toBe(2);
    expect(archiveCursor(report.cursor).occurredAt).toBe(OCCURRED[1]);
    expect(archiveCursor(report.cursor).id).toEqual(expect.any(String));
    expect(calls).toHaveLength(2);
  });

  it('stops inside the batch, without running the rows behind the one that aborted it', async () => {
    archiveAllExperiences(substrate);
    const controller = new AbortController();
    const aborting: ReplayDeps = {
      ...substrate.deps,
      runner: {
        run: async (episodeId, options) => {
          controller.abort();
          return substrate.deps.runner.run(episodeId, options);
        },
      },
    };

    const report = await replayExperiences(aborting, {
      batchSize: 4,
      signal: controller.signal,
    });

    expect(report.aborted).toBe(true);
    expect(report.scanned).toBe(1);
    expect(archiveCursor(report.cursor).occurredAt).toBe(OCCURRED[0]);
    expect(calls).toHaveLength(1);
  });

  it('replays nothing when the signal is already aborted', async () => {
    archiveAllExperiences(substrate);

    const report = await replayExperiences(substrate.deps, {
      batchSize: 2,
      signal: AbortSignal.abort(),
    });

    expect({ aborted: report.aborted, scanned: report.scanned, cursor: report.cursor }).toEqual({
      aborted: true,
      scanned: 0,
      cursor: undefined,
    });
    expect(calls).toEqual([]);
  });
});
