import type { TimelineEvent } from '@aion/core';
import { describe, expect, it } from 'vitest';

import { parseTimelineFlags, renderTimeline, runTimelineCommand, toJson } from './timeline.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseTimelineFlags', () => {
  it('reads a bare episode id', () => {
    expect(parseTimelineFlags(['episode-1'])).toEqual({
      target: 'episode',
      episodeId: 'episode-1',
      json: false,
    });
  });

  it('reads --session and --json', () => {
    expect(parseTimelineFlags(['--session', 'session-1', '--json'])).toEqual({
      target: 'session',
      sessionId: 'session-1',
      json: true,
    });
  });

  it('rejects neither an id nor --session, and both at once', () => {
    expect(() => parseTimelineFlags([])).toThrow('timeline needs an episode id or --session');
    expect(() => parseTimelineFlags(['episode-1', '--session', 'session-1'])).toThrow(
      'pass an episode id or --session, not both',
    );
  });

  it('rejects an unknown option and an extra positional', () => {
    expect(() => parseTimelineFlags(['episode-1', '--bogus'])).toThrow(
      "unknown option '--bogus' for timeline",
    );
    expect(() => parseTimelineFlags(['episode-1', 'episode-2'])).toThrow(
      "unexpected extra argument 'episode-2' for timeline",
    );
  });
});

const EVENTS: readonly TimelineEvent[] = [
  {
    kind: 'occurred',
    at: new Date('2026-01-01T00:00:00.000Z'),
    clock: 'world',
    summary: 'the episode happened',
    detail: { episode_occurred_at: '2026-01-01T00:00:00.000Z', matches_episode: true },
  },
  {
    kind: 'archived',
    at: new Date('2026-01-01T00:05:00.000Z'),
    clock: 'tx',
    summary: 'archived under pipeline v1',
    detail: { pipeline_version: 'v1', lane: undefined, origin: undefined },
  },
  {
    kind: 'run_applied',
    at: new Date('2026-01-01T00:07:00.000Z'),
    clock: 'tx',
    summary: 'the run applied in 820ms',
    detail: { summary: { durationMs: 820 } },
  },
];

describe('renderTimeline', () => {
  it('prints one line per event, oldest first, tagged with its clock', () => {
    const { lines, write } = collector();

    renderTimeline('episode-1', EVENTS, write);

    expect(lines[0]).toBe('episode  episode-1');
    expect(lines[1]).toContain('world');
    expect(lines[1]).toContain('the episode happened');
    expect(lines[2]).toContain('tx');
    expect(lines[3]).toContain('the run applied in 820ms');
  });

  it('says plainly when every source came back empty', () => {
    const { lines, write } = collector();

    renderTimeline('episode-1', [], write);

    expect(lines).toEqual([
      'episode  episode-1',
      '  nothing found: no archive row, no graph node, no queue row',
    ]);
  });
});

describe('toJson', () => {
  it('maps every event to its wire shape, one document per episode', () => {
    const document = toJson('episode-1', EVENTS);

    expect(document).toEqual({
      episode_id: 'episode-1',
      events: [
        {
          kind: 'occurred',
          at: '2026-01-01T00:00:00.000Z',
          clock: 'world',
          summary: 'the episode happened',
          detail: { episode_occurred_at: '2026-01-01T00:00:00.000Z', matches_episode: true },
        },
        {
          kind: 'archived',
          at: '2026-01-01T00:05:00.000Z',
          clock: 'tx',
          summary: 'archived under pipeline v1',
          detail: { pipeline_version: 'v1', lane: undefined, origin: undefined },
        },
        {
          kind: 'run_applied',
          at: '2026-01-01T00:07:00.000Z',
          clock: 'tx',
          summary: 'the run applied in 820ms',
          detail: { summary: { durationMs: 820 } },
        },
      ],
    });
  });

  it('round-trips through JSON.stringify with no undefined leaking through', () => {
    const wire = JSON.parse(JSON.stringify(toJson('episode-1', EVENTS))) as {
      events: readonly { detail: Record<string, unknown> }[];
    };

    expect(Object.keys(wire.events[0]?.detail ?? {})).toEqual([
      'episode_occurred_at',
      'matches_episode',
    ]);
  });
});

describe('aion timeline --help', () => {
  it('prints the usage line without opening the substrate', async () => {
    const { lines, write } = collector();

    await expect(runTimelineCommand(['--help'], write)).resolves.toBe(0);

    expect(lines[0]).toContain('usage: aion timeline <episode_id>');
  });
});
