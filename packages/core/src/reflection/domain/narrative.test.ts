import { describe, expect, it } from 'vitest';
import {
  buildNarrativeMessages,
  coverageKey,
  decideSessionNarrative,
  isSessionIdle,
  lastActivityAt,
  narrativeNodeId,
  narrativeSpan,
  NarrativeOutputSchema,
  renderNarrativeSource,
  type ExistingNarrative,
  type NarrativeEpisode,
} from './narrative.js';

const IDLE_MS = 30 * 60 * 1000;

function episode(id: string, overrides: Partial<NarrativeEpisode> = {}): NarrativeEpisode {
  return { id, text: `body of ${id}`, ...overrides };
}

function existing(overrides: Partial<ExistingNarrative> = {}): ExistingNarrative {
  return {
    id: 'narrative-1',
    version: 1,
    coverageKey: 'key-1',
    coverageCount: 1,
    open: true,
    ...overrides,
  };
}

describe('coverage identity', () => {
  it('hashes the same episode set the same however it is ordered or repeated', () => {
    expect(coverageKey(['b', 'a', 'c'])).toBe(coverageKey(['a', 'b', 'c', 'a']));
  });

  it('separates one episode set from another', () => {
    expect(coverageKey(['a', 'b'])).not.toBe(coverageKey(['a', 'b', 'c']));
  });

  it('derives the node id from the session and the set, so a retry writes the same node', () => {
    const key = coverageKey(['a', 'b']);

    expect(narrativeNodeId('session-1', key)).toBe(narrativeNodeId('session-1', key));
    expect(narrativeNodeId('session-2', key)).not.toBe(narrativeNodeId('session-1', key));
  });
});

describe('idle boundary', () => {
  const lastActivity = new Date('2026-04-02T10:00:00Z');

  it('holds a session open until the window has fully passed', () => {
    expect(isSessionIdle(lastActivity, new Date('2026-04-02T10:29:59Z'), IDLE_MS)).toBe(false);
  });

  it('closes it at the window', () => {
    expect(isSessionIdle(lastActivity, new Date('2026-04-02T10:30:00Z'), IDLE_MS)).toBe(true);
  });

  it('measures activity on the write, not on the timestamp the caller claimed', () => {
    const backdated = episode('e1', {
      occurredAt: new Date('2020-01-01T00:00:00Z'),
      writtenAt: new Date('2026-04-02T10:00:00Z'),
    });

    expect(lastActivityAt([backdated])).toEqual(new Date('2026-04-02T10:00:00Z'));
  });

  it('has no activity to report for episodes carrying no stamps at all', () => {
    expect(lastActivityAt([episode('e1')])).toBeUndefined();
  });

  it('spans the world time the episodes claim, earliest to latest', () => {
    const span = narrativeSpan([
      episode('e2', { occurredAt: new Date('2026-04-02T11:00:00Z') }),
      episode('e1', { occurredAt: new Date('2026-04-02T09:00:00Z') }),
      episode('e3'),
    ]);

    expect(span.start).toEqual(new Date('2026-04-02T09:00:00Z'));
    expect(span.end).toEqual(new Date('2026-04-02T11:00:00Z'));
  });
});

describe('narrative versioning', () => {
  it('creates version 1 for a session that has none', () => {
    const decision = decideSessionNarrative([episode('e1'), episode('e2')], []);

    expect(decision.action).toBe('create');
    expect(decision.version).toBe(1);
    expect(decision.supersedes).toEqual([]);
    expect(decision.episodeIds).toEqual(['e1', 'e2']);
  });

  it('skips a session with no episodes', () => {
    const decision = decideSessionNarrative([], []);

    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('no episodes');
  });

  it('skips a re-close over the same episode set', () => {
    const episodes = [episode('e1'), episode('e2')];
    const standing = existing({ coverageKey: coverageKey(['e1', 'e2']), coverageCount: 2 });

    const decision = decideSessionNarrative(episodes, [standing]);

    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('already covers');
    expect(decision.supersedes).toEqual([]);
  });

  it('mints the next version and supersedes the standing one when more episodes arrive', () => {
    const episodes = [episode('e1'), episode('e2'), episode('e3')];
    const standing = existing({ coverageKey: coverageKey(['e1', 'e2']), coverageCount: 2 });

    const decision = decideSessionNarrative(episodes, [standing]);

    expect(decision.action).toBe('create');
    expect(decision.version).toBe(2);
    expect(decision.supersedes).toEqual(['narrative-1']);
    expect(decision.coverageKey).toBe(coverageKey(['e1', 'e2', 'e3']));
  });

  it('counts versions from the highest ever written, not from the open ones', () => {
    const episodes = [episode('e1'), episode('e2'), episode('e3')];
    const decision = decideSessionNarrative(episodes, [
      existing({ id: 'narrative-2', version: 2, coverageKey: 'key-2', coverageCount: 2, open: false }),
      existing({ id: 'narrative-1', version: 1, coverageKey: 'key-1', coverageCount: 1, open: false }),
    ]);

    expect(decision.action).toBe('create');
    expect(decision.version).toBe(3);
    expect(decision.supersedes).toEqual([]);
  });

  it('leaves the standing narrative alone when the set shrank', () => {
    const episodes = [episode('e1')];
    const standing = existing({ coverageKey: coverageKey(['e1', 'e2']), coverageCount: 2 });

    const decision = decideSessionNarrative(episodes, [standing]);

    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('covers 2 episodes');
  });

  it('does not resurrect a set a later version already superseded', () => {
    const episodes = [episode('e1'), episode('e2')];
    const decision = decideSessionNarrative(episodes, [
      existing({ id: 'narrative-2', version: 2, coverageKey: 'key-2', coverageCount: 3 }),
      existing({
        id: 'narrative-1',
        version: 1,
        coverageKey: coverageKey(['e1', 'e2']),
        coverageCount: 2,
        open: false,
      }),
    ]);

    expect(decision.action).toBe('skip');
    expect(decision.supersedes).toEqual([]);
  });

  it('closes a straggler a crash left open beside the matching version', () => {
    const episodes = [episode('e1'), episode('e2')];
    const decision = decideSessionNarrative(episodes, [
      existing({
        id: 'narrative-2',
        version: 2,
        coverageKey: coverageKey(['e1', 'e2']),
        coverageCount: 2,
      }),
      existing({ id: 'narrative-1', version: 1, coverageKey: 'key-1', coverageCount: 1 }),
    ]);

    expect(decision.action).toBe('skip');
    expect(decision.supersedes).toEqual(['narrative-1']);
  });
});

describe('compression source', () => {
  it('renders every episode when the session fits the window', () => {
    const source = renderNarrativeSource([episode('e1'), episode('e2')], 40, 2000);

    expect(source.renderedCount).toBe(2);
    expect(source.coverage).toBe(1);
    expect(source.text).toContain('body of e1');
    expect(source.text).toContain('body of e2');
  });

  it('keeps the most recent episodes and records the fraction the model saw', () => {
    const episodes = ['e1', 'e2', 'e3', 'e4'].map((id) => episode(id));

    const source = renderNarrativeSource(episodes, 2, 2000);

    expect(source.renderedCount).toBe(2);
    expect(source.coverage).toBe(0.5);
    expect(source.text).not.toContain('body of e2');
    expect(source.text).toContain('body of e4');
  });

  it('prefers an episode summary over its rendered body and clips a long one', () => {
    const long = episode('e1', { summary: 'x'.repeat(50) });

    const source = renderNarrativeSource([long], 40, 10);

    expect(source.text).toContain(`${'x'.repeat(10)}…`);
    expect(source.text).not.toContain('body of e1');
  });

  it('stamps the episode time into the rendered line when the episode carries one', () => {
    const stamped = episode('e1', { occurredAt: new Date('2026-04-02T10:00:00Z') });

    expect(renderNarrativeSource([stamped], 40, 2000).text).toContain('2026-04-02T10:00:00.000Z');
  });
});

describe('model contract', () => {
  it('asks for both a one-line summary and the narrative body', () => {
    const messages = buildNarrativeMessages('episode: shipped the worker');

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('"summary"');
    expect(messages[0]?.content).toContain('"narrative"');
    expect(messages[1]?.content).toContain('shipped the worker');
  });

  it('rejects an answer missing either field', () => {
    expect(NarrativeOutputSchema.safeParse({ summary: 'a session' }).success).toBe(false);
    expect(NarrativeOutputSchema.safeParse({ summary: '', narrative: 'body' }).success).toBe(false);
    expect(NarrativeOutputSchema.safeParse({ summary: 'a session', narrative: 'body' }).success).toBe(
      true,
    );
  });
});
