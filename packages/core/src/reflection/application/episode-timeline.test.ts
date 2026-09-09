import { describe, expect, it } from 'vitest';

import { buildEpisodeTimeline, type EpisodeTimelineInput } from './episode-timeline.js';
import type { ExperienceArchiveRow } from '../../infrastructure/sqlite/experience-archive.js';
import type { OpsLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import type { ReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';

const EPISODE_ID = 'episode-1';

function archiveRow(overrides: Partial<ExperienceArchiveRow> = {}): ExperienceArchiveRow {
  return {
    id: 'archive-1',
    idempotencyKey: 'key-1',
    schemaVersion: 1,
    pipelineVersion: 'v1',
    identity: 'identity-1',
    sessionId: 'session-1',
    episodeId: EPISODE_ID,
    contentHash: 'hash-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    archivedAt: '2026-01-01T00:05:00.000Z',
    lane: undefined,
    origin: undefined,
    payload: { turns: [] },
    ...overrides,
  };
}

function queueJob(overrides: Partial<ReflectionJob> = {}): ReflectionJob {
  return {
    id: 'job-1',
    jobType: 'integrate',
    payload: { episode_id: EPISODE_ID },
    enqueuedAt: '2026-01-01T00:05:00.000Z',
    attempts: 0,
    claimedAt: null,
    claimedBy: null,
    lastError: null,
    lane: 'interactive',
    sessionId: 'session-1',
    episodeId: EPISODE_ID,
    ...overrides,
  };
}

function ledgerEntry(appliedAt: string, summary: unknown): OpsLedgerEntry {
  return { key: 'k', appliedAt, summary };
}

/** A fully-populated, undisturbed input: every source present, nothing stale or missing. */
function baseInput(): EpisodeTimelineInput {
  return {
    episodeId: EPISODE_ID,
    archive: archiveRow(),
    episodeOccurredAt: new Date('2026-01-01T00:00:00.000Z'),
    episodeValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    episodeTxFrom: new Date('2026-01-01T00:04:50.000Z'),
    queueJob: queueJob(),
    stages: [
      {
        name: 'entities',
        entry: ledgerEntry('2026-01-01T00:06:00.000Z', {
          status: 'ok',
          summary: 'extracted 3 entities',
        }),
      },
    ],
    runEntry: ledgerEntry('2026-01-01T00:07:00.000Z', {
      episodeId: EPISODE_ID,
      durationMs: 820,
      stages: [],
      counts: {},
      skippedStages: [],
    }),
    derivedNodes: [
      {
        id: 'entity-1',
        labels: ['Entity', 'Memory'],
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        txFrom: new Date('2026-01-01T00:06:05.000Z'),
      },
    ],
  };
}

describe('buildEpisodeTimeline over injected rows', () => {
  it('orders every event oldest first with the right clock class on each', () => {
    const events = buildEpisodeTimeline(baseInput());

    expect(events.map((event) => [event.kind, event.clock, event.at.toISOString()])).toEqual([
      ['occurred', 'world', '2026-01-01T00:00:00.000Z'],
      ['stored', 'world', '2026-01-01T00:00:00.000Z'],
      ['derived_node', 'world', '2026-01-01T00:00:00.000Z'],
      ['stored', 'tx', '2026-01-01T00:04:50.000Z'],
      ['archived', 'tx', '2026-01-01T00:05:00.000Z'],
      ['enqueued', 'tx', '2026-01-01T00:05:00.000Z'],
      ['stage_applied', 'tx', '2026-01-01T00:06:00.000Z'],
      ['derived_node', 'tx', '2026-01-01T00:06:05.000Z'],
      ['run_applied', 'tx', '2026-01-01T00:07:00.000Z'],
    ]);
  });

  it('carries the cross-check and the queue detail a reader needs', () => {
    const events = buildEpisodeTimeline(baseInput());

    const occurred = events.find((event) => event.kind === 'occurred');
    expect(occurred?.detail).toMatchObject({ matches_episode: true });

    const enqueued = events.find((event) => event.kind === 'enqueued');
    expect(enqueued?.detail).toMatchObject({ lane: 'interactive', last_error: null });

    const stage = events.find((event) => event.kind === 'stage_applied');
    expect(stage?.detail).toMatchObject({ stage: 'entities', status: 'ok' });
  });

  it('renders a completed job with no gap when the queue row is gone', () => {
    const input: EpisodeTimelineInput = { ...baseInput(), queueJob: undefined };

    const events = buildEpisodeTimeline(input);

    expect(events.some((event) => event.kind === 'enqueued')).toBe(false);
    const completed = events.find((event) => event.kind === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.at.toISOString()).toBe('2026-01-01T00:07:00.000Z');
    expect(completed?.summary).toContain('completed');
  });

  it('shows the queue last_error and no run-applied key for a failed stage', () => {
    const input: EpisodeTimelineInput = {
      ...baseInput(),
      queueJob: queueJob({
        attempts: 1,
        lastError: '1 stage(s) failed for episode-1: cognitive: the stage threw',
      }),
      stages: [
        {
          name: 'entities',
          entry: ledgerEntry('2026-01-01T00:06:00.000Z', {
            status: 'ok',
            summary: 'extracted 3 entities',
          }),
        },
        { name: 'cognitive', entry: undefined },
        {
          name: 'associations',
          entry: ledgerEntry('2026-01-01T00:06:10.000Z', {
            status: 'ok',
            summary: 'inferred 1 association',
          }),
        },
      ],
      runEntry: undefined,
    };

    const events = buildEpisodeTimeline(input);

    expect(events.some((event) => event.kind === 'run_applied')).toBe(false);
    const enqueued = events.find((event) => event.kind === 'enqueued');
    expect(enqueued?.detail.last_error).toBe(
      '1 stage(s) failed for episode-1: cognitive: the stage threw',
    );
    expect(
      events.filter((event) => event.kind === 'stage_applied').map((event) => event.detail.stage),
    ).toEqual(['entities', 'associations']);
  });

  it('orders publications by knowledge time and keeps the sequence exact', () => {
    // Above Number.MAX_SAFE_INTEGER on purpose: the store hands the sequence over as a string
    // and it has to survive the whole way to the rendered event without becoming a double.
    const huge = '9007199254740993';
    const events = buildEpisodeTimeline({
      ...baseInput(),
      publications: [
        {
          sequence: huge,
          operationId: 'later',
          kind: 'stated_references',
          state: 'acknowledged',
          knownFrom: '2026-01-01T00:09:00.000Z',
          observedAckAt: '2026-01-01T00:08:30.000Z',
          clockClamped: false,
          createdAt: '2026-01-01T00:08:00.000Z',
        },
        {
          sequence: '7',
          operationId: 'earlier',
          kind: 'intake',
          state: 'acknowledged',
          knownFrom: '2026-01-01T00:03:00.000Z',
          observedAckAt: '2026-01-01T00:03:00.000Z',
          clockClamped: false,
          createdAt: '2026-01-01T00:02:00.000Z',
        },
      ],
    });
    const published = events.filter((event) => event.kind === 'published');

    expect(published.map((event) => event.detail.operation_id)).toEqual(['earlier', 'later']);
    expect(published[1]?.detail.sequence).toBe(huge);
    expect(String(published[1]?.detail.sequence)).not.toBe(String(Number(huge)));
    expect(published[1]?.at.toISOString()).toBe('2026-01-01T00:09:00.000Z');
  });

  it('shows a clamped publication with both clocks, and holds input apart from evidence', () => {
    const events = buildEpisodeTimeline({
      ...baseInput(),
      publications: [
        {
          sequence: '11',
          operationId: 'clamped',
          kind: 'stated_references',
          state: 'acknowledged',
          // The knowledge clock was held back to a predecessor's, so it sits after the moment
          // the acknowledgment was observed. Reporting one number would hide exactly that.
          knownFrom: '2026-01-01T00:09:00.000Z',
          observedAckAt: '2026-01-01T00:05:00.000Z',
          clockClamped: true,
          createdAt: '2026-01-01T00:04:00.000Z',
        },
        {
          sequence: '12',
          operationId: 'not-yet',
          kind: 'stated_references',
          state: 'prepared',
          clockClamped: false,
          createdAt: '2026-01-01T00:06:30.000Z',
        },
      ],
    });
    const clamped = events.find((event) => event.detail.operation_id === 'clamped');
    const prepared = events.find((event) => event.detail.operation_id === 'not-yet');

    expect(clamped?.kind).toBe('published');
    expect(clamped?.detail.known_from).toBe('2026-01-01T00:09:00.000Z');
    expect(clamped?.detail.observed_ack_at).toBe('2026-01-01T00:05:00.000Z');
    expect(clamped?.detail.clock_clamped).toBe(true);
    // Input, not evidence: nothing has published it, so it carries no knowledge time and is
    // placed by the only clock it has.
    expect(prepared?.kind).toBe('prepared');
    expect(prepared?.detail.known_from).toBeUndefined();
    expect(prepared?.at.toISOString()).toBe('2026-01-01T00:06:30.000Z');
  });

  it('produces nothing for a source that never existed rather than throwing', () => {
    const input: EpisodeTimelineInput = {
      episodeId: EPISODE_ID,
      archive: undefined,
      episodeOccurredAt: undefined,
      episodeValidFrom: undefined,
      episodeTxFrom: undefined,
      queueJob: undefined,
      stages: [],
      runEntry: undefined,
      derivedNodes: [],
    };

    expect(buildEpisodeTimeline(input)).toEqual([]);
  });
});
