import { describe, expect, it } from 'vitest';

import {
  decideMidSessionBoundary,
  decideSessionBoundary,
  standingCoverage,
  trailingGapMs,
} from './mid-session.js';
import type { ExistingNarrative, NarrativeEpisode } from './narrative.js';

function episode(id: string, overrides: Partial<NarrativeEpisode> = {}): NarrativeEpisode {
  return { id, text: `body of ${id}`, ...overrides };
}

function standing(coverageCount: number, open = true): ExistingNarrative {
  return { id: 'narrative-1', version: 1, coverageKey: 'key-1', coverageCount, open };
}

describe('mid-session boundary', () => {
  const GAP_MS = 10 * 60 * 1000;

  function boundary(overrides: Partial<Parameters<typeof decideMidSessionBoundary>[0]> = {}) {
    return decideMidSessionBoundary({
      episodeCount: 5,
      coveredCount: 0,
      trailingGapMs: 0,
      episodeBoundary: 12,
      gapMs: GAP_MS,
      ...overrides,
    });
  }

  it('measures the pause between the two newest episodes', () => {
    const gap = trailingGapMs([
      episode('e1', { writtenAt: new Date('2026-04-02T09:00:00Z') }),
      episode('e2', { writtenAt: new Date('2026-04-02T09:05:00Z') }),
      episode('e3', { writtenAt: new Date('2026-04-02T09:25:00Z') }),
    ]);

    expect(gap).toBe(20 * 60 * 1000);
  });

  it('reads a session of one episode as having no pause at all', () => {
    expect(trailingGapMs([episode('e1', { writtenAt: new Date('2026-04-02T09:00:00Z') })])).toBe(0);
  });

  it('compresses a run of episodes the standing narrative does not cover', () => {
    const decision = boundary({ episodeCount: 14, coveredCount: 2 });

    expect(decision.cross).toBe(true);
    expect(decision.reason).toBe('12 episodes since the standing narrative');
  });

  it('compresses a session that paused long enough for the work to read as finished', () => {
    const decision = boundary({ trailingGapMs: 15 * 60 * 1000 });

    expect(decision.cross).toBe(true);
    expect(decision.reason).toBe('the session paused for 15 minutes');
  });

  it('leaves a session that is neither long nor paused alone', () => {
    const decision = boundary({ trailingGapMs: 60_000 });

    expect(decision.cross).toBe(false);
    expect(decision.reason).toBe('5 uncovered episodes and no pause');
  });

  it('crosses no boundary once the standing narrative covers every episode', () => {
    const decision = boundary({ episodeCount: 5, coveredCount: 5, trailingGapMs: 60 * GAP_MS });

    expect(decision.cross).toBe(false);
    expect(decision.reason).toBe('the standing narrative covers every episode');
  });
});

describe('the boundary a running session is judged against', () => {
  const IDLE_MS = 30 * 60 * 1000;
  const settings = { now: new Date('2026-04-02T09:30:00Z'), idleMs: IDLE_MS, midSession: true };

  const paused = [
    episode('e1', { writtenAt: new Date('2026-04-02T09:00:00Z') }),
    episode('e2', { writtenAt: new Date('2026-04-02T09:25:00Z') }),
  ];

  it('reads what the standing version covers off the open one', () => {
    expect(standingCoverage([standing(3), standing(9, false)])).toBe(3);
    expect(standingCoverage([standing(3, false)])).toBe(0);
  });

  it('narrates a session that has gone quiet past the idle window', () => {
    const decision = decideSessionBoundary(paused, [], {
      ...settings,
      now: new Date('2026-04-02T10:00:00Z'),
    });

    expect(decision).toEqual({ narrate: true, reason: 'the session has gone quiet' });
  });

  it('narrates a running session that crossed the pause boundary', () => {
    const decision = decideSessionBoundary(paused, [], settings);

    expect(decision.narrate).toBe(true);
    expect(decision.reason).toBe('the session paused for 25 minutes');
  });

  it('waits for the close on the same session once the switch is off', () => {
    const decision = decideSessionBoundary(paused, [], { ...settings, midSession: false });

    expect(decision).toEqual({ narrate: false, reason: 'the session is still active' });
  });

  it('waits while a running session holds nothing the standing version misses', () => {
    const decision = decideSessionBoundary(paused, [standing(2)], settings);

    expect(decision).toEqual({
      narrate: false,
      reason: 'the session is still active: the standing narrative covers every episode',
    });
  });

  it('narrates nothing for a session whose episodes carry no stamps at all', () => {
    const decision = decideSessionBoundary([episode('e1')], [], settings);

    expect(decision).toEqual({
      narrate: false,
      reason: 'the session carries no activity timestamp',
    });
  });
});
