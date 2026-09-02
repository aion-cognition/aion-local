import { describe, expect, it } from 'vitest';

import {
  groupRollupWindows,
  isWindowClosed,
  rollupMemberScope,
  rollupWindow,
  type RollupMember,
} from './rollup.js';

function member(id: string, occurredAt?: string): RollupMember {
  return {
    id,
    text: `body of ${id}`,
    ...(occurredAt === undefined ? {} : { occurredAt: new Date(occurredAt) }),
  };
}

describe('rollupMemberScope', () => {
  it('rolls a day up from sessions and a week up from days', () => {
    expect(rollupMemberScope('day')).toBe('session');
    expect(rollupMemberScope('week')).toBe('day');
  });
});

describe('rollupWindow', () => {
  it('names a day by its UTC date and ends it at the next midnight', () => {
    const window = rollupWindow('day', new Date('2026-04-02T23:59:59.000Z'));

    expect(window.key).toBe('2026-04-02');
    expect(window.start.toISOString()).toBe('2026-04-02T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-04-03T00:00:00.000Z');
  });

  it('starts a week on Monday and names it by its ISO week', () => {
    const window = rollupWindow('week', new Date('2026-04-02T12:00:00.000Z'));

    expect(window.key).toBe('2026-W14');
    expect(window.start.toISOString()).toBe('2026-03-30T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-04-06T00:00:00.000Z');
  });

  it('gives a Sunday the week that began the Monday before it', () => {
    expect(rollupWindow('week', new Date('2026-04-05T18:00:00.000Z')).key).toBe('2026-W14');
    expect(rollupWindow('week', new Date('2026-04-06T00:00:00.000Z')).key).toBe('2026-W15');
  });

  it('gives the last days of a year the week their Thursday belongs to', () => {
    expect(rollupWindow('week', new Date('2025-12-31T00:00:00.000Z')).key).toBe('2026-W01');
    expect(rollupWindow('week', new Date('2026-01-01T00:00:00.000Z')).key).toBe('2026-W01');
  });
});

describe('isWindowClosed', () => {
  const window = rollupWindow('day', new Date('2026-04-02T09:00:00.000Z'));

  it('holds a window open while its last instant is still ahead', () => {
    expect(isWindowClosed(window, new Date('2026-04-02T23:59:59.000Z'))).toBe(false);
  });

  it('closes it the moment the next window starts', () => {
    expect(isWindowClosed(window, new Date('2026-04-03T00:00:00.000Z'))).toBe(true);
  });
});

describe('groupRollupWindows', () => {
  it('groups members into their windows, oldest window first', () => {
    const windows = groupRollupWindows(
      [
        member('late', '2026-04-03T08:00:00.000Z'),
        member('early', '2026-04-02T09:00:00.000Z'),
        member('mid', '2026-04-02T17:00:00.000Z'),
      ],
      'day',
    );

    expect(windows.map((window) => window.key)).toEqual(['2026-04-02', '2026-04-03']);
    expect(windows[0]?.members.map((held) => held.id)).toEqual(['early', 'mid']);
    expect(windows[1]?.members.map((held) => held.id)).toEqual(['late']);
  });

  it('folds a whole week of members into one window', () => {
    const windows = groupRollupWindows(
      [member('monday', '2026-03-30T09:00:00.000Z'), member('friday', '2026-04-03T09:00:00.000Z')],
      'week',
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]?.key).toBe('2026-W14');
    expect(windows[0]?.members.map((held) => held.id)).toEqual(['monday', 'friday']);
  });

  it('leaves out a member carrying no world time rather than dating it to the run', () => {
    const windows = groupRollupWindows(
      [member('undated'), member('dated', '2026-04-02T09:00:00.000Z')],
      'day',
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]?.members.map((held) => held.id)).toEqual(['dated']);
  });
});
