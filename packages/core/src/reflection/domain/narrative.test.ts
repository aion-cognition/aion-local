import { describe, expect, it } from 'vitest';

import {
  assembleNarrative,
  buildNarrativeMessages,
  coverageKey,
  decideSessionNarrative,
  isSessionIdle,
  lastActivityAt,
  narrativeMaxTokens,
  narrativeNodeId,
  narrativeSentenceBudget,
  narrativeSpan,
  NARRATIVE_MAX_SENTENCES,
  NARRATIVE_GROUNDING,
  NarrativeOutputSchema,
  renderNarrativeSource,
  type ExistingNarrative,
  type NarrativeEpisode,
  type NarrativeExtractedNode,
  type NarrativeSourceItem,
} from './narrative.js';

const IDLE_MS = 30 * 60 * 1000;

function episode(id: string, overrides: Partial<NarrativeEpisode> = {}): NarrativeEpisode {
  return { id, text: `body of ${id}`, ...overrides };
}

function decisionNode(episodeId: string): NarrativeExtractedNode {
  return { id: 'd1', kind: 'decision', text: 'hold the launch', episodeId };
}

function sourceItem(handle: string, text: string): NarrativeSourceItem {
  return { handle, id: handle.toLowerCase(), kind: 'episode', text };
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

  it('judges the close against the highest open version, whatever order the read returned', () => {
    const decision = decideSessionNarrative(
      [episode('e1'), episode('e2')],
      [
        existing({ id: 'narrative-1', version: 1, coverageKey: 'key-1', coverageCount: 1 }),
        existing({ id: 'narrative-2', version: 2, coverageKey: 'key-2', coverageCount: 3 }),
      ],
    );

    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('version 2 covers 3 episodes, this close 2');
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
      existing({
        id: 'narrative-2',
        version: 2,
        coverageKey: 'key-2',
        coverageCount: 2,
        open: false,
      }),
      existing({
        id: 'narrative-1',
        version: 1,
        coverageKey: 'key-1',
        coverageCount: 1,
        open: false,
      }),
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

describe('regeneration', () => {
  it('mints the next version over the same episode set and supersedes what stands', () => {
    const episodes = [episode('e1'), episode('e2')];
    const standing = existing({ coverageKey: coverageKey(['e1', 'e2']), coverageCount: 2 });

    const decision = decideSessionNarrative(episodes, [standing], { regenerate: true });

    expect(decision.action).toBe('create');
    expect(decision.version).toBe(2);
    expect(decision.supersedes).toEqual(['narrative-1']);
    expect(decision.coverageKey).toBe(coverageKey(['e1', 'e2']));
  });

  it('separates the regenerated node from the one an ordinary close derives', () => {
    const key = coverageKey(['e1']);

    expect(narrativeNodeId('session-1', key, NARRATIVE_GROUNDING)).not.toBe(
      narrativeNodeId('session-1', key),
    );
    expect(narrativeNodeId('session-1', key, '')).toBe(narrativeNodeId('session-1', key));
  });

  it('still refuses a session with nothing to narrate', () => {
    expect(decideSessionNarrative([], [], { regenerate: true }).action).toBe('skip');
  });
});

describe('compression source', () => {
  it('renders every episode when the session fits the window', () => {
    const source = renderNarrativeSource([episode('e1'), episode('e2')], [], 40, 2000);

    expect(source.renderedCount).toBe(2);
    expect(source.coverage).toBe(1);
    expect(source.items.map((item) => item.handle)).toEqual(['S1', 'S2']);
    expect(source.text).toContain('[S1] episode\nbody of e1');
    expect(source.text).toContain('[S2] episode\nbody of e2');
  });

  it('keeps the most recent episodes and records the fraction the model saw', () => {
    const episodes = ['e1', 'e2', 'e3', 'e4'].map((id) => episode(id));

    const source = renderNarrativeSource(episodes, [], 2, 2000);

    expect(source.renderedCount).toBe(2);
    expect(source.coverage).toBe(0.5);
    expect(source.text).not.toContain('body of e2');
    expect(source.text).toContain('body of e4');
  });

  it('prefers an episode summary over its rendered body and clips a long one', () => {
    const long = episode('e1', { summary: 'x'.repeat(50) });

    const source = renderNarrativeSource([long], [], 40, 10);

    expect(source.text).toContain(`${'x'.repeat(10)}…`);
    expect(source.text).not.toContain('body of e1');
  });

  it('stamps the episode time into the rendered line when the episode carries one', () => {
    const stamped = episode('e1', { occurredAt: new Date('2026-04-02T10:00:00Z') });

    expect(renderNarrativeSource([stamped], [], 40, 2000).text).toContain(
      '2026-04-02T10:00:00.000Z',
    );
  });

  it('files each extracted node behind the episode it came from', () => {
    const source = renderNarrativeSource(
      [episode('e1'), episode('e2')],
      [decisionNode('e1')],
      40,
      2000,
    );

    expect(source.items.map((item) => [item.handle, item.kind, item.id])).toEqual([
      ['S1', 'episode', 'e1'],
      ['S2', 'decision', 'd1'],
      ['S3', 'episode', 'e2'],
    ]);
  });

  it('drops an extracted node whose episode fell outside the window', () => {
    const source = renderNarrativeSource(
      [episode('e1'), episode('e2')],
      [decisionNode('e1')],
      1,
      2000,
    );

    expect(source.items.map((item) => item.id)).toEqual(['e2']);
  });
});

describe('length scaling', () => {
  it('gives one thin episode one sentence', () => {
    const thin = episode('e1', { summary: 'close-mode probe terminate' });

    expect(renderNarrativeSource([thin], [], 40, 2000).sentenceBudget).toBe(1);
  });

  it('grows the budget with the source and stops at the ceiling', () => {
    const wordy = Array.from({ length: 12 }, (_, slot) =>
      episode(`e${String(slot)}`, { summary: 'a'.repeat(300) }),
    );

    expect(renderNarrativeSource(wordy, [], 40, 2000).sentenceBudget).toBe(NARRATIVE_MAX_SENTENCES);
  });

  it('never asks for more sentences than there are source items', () => {
    const single = episode('e1', { summary: 'a'.repeat(3000) });

    expect(renderNarrativeSource([single], [], 40, 5000).sentenceBudget).toBe(1);
  });

  it('scales the token ceiling of the answer with the budget, at every budget', () => {
    expect(narrativeMaxTokens(1)).toBe(310);
    expect(narrativeMaxTokens(NARRATIVE_MAX_SENTENCES)).toBe(1_060);
    // The wide budget is why the old fixed ceiling went: 1,200 tokens cut a twelve-sentence
    // answer mid-JSON, which parses as nothing rather than as a shorter narrative.
    expect(narrativeMaxTokens(12)).toBe(1_960);
  });

  it('honors a caller-supplied sentence ceiling above the local one', () => {
    const wordy = Array.from({ length: 20 }, (_, slot) =>
      sourceItem(`S${String(slot + 1)}`, 'a'.repeat(300)),
    );

    expect(narrativeSentenceBudget(wordy)).toBe(NARRATIVE_MAX_SENTENCES);
    expect(narrativeSentenceBudget(wordy, 12)).toBe(12);
  });

  it('still floors at one sentence and never exceeds the items it was given', () => {
    expect(narrativeSentenceBudget([sourceItem('S1', 'short')], 12)).toBe(1);
    expect(narrativeSentenceBudget([sourceItem('S1', 'a'.repeat(3_000))], 12)).toBe(1);
  });

  it('renders a wider source at the wider ceiling', () => {
    const episodes = Array.from({ length: 60 }, (_, slot) =>
      episode(`e${String(slot)}`, { summary: 'a'.repeat(300) }),
    );

    expect(renderNarrativeSource(episodes, [], 120, 4_000, 12).sentenceBudget).toBe(12);
    expect(renderNarrativeSource(episodes, [], 120, 4_000).sentenceBudget).toBe(
      NARRATIVE_MAX_SENTENCES,
    );
  });
});

describe('grounded assembly', () => {
  const source = renderNarrativeSource(
    [episode('e1'), episode('e2')],
    [decisionNode('e1')],
    40,
    2000,
  );

  it('keeps a cited sentence and records the node id it cited', () => {
    const grounded = assembleNarrative(
      { sentences: [{ text: 'The pair shipped the worker.', source_ids: ['S2'] }] },
      source,
    );

    expect(grounded.kept).toBe(1);
    expect(grounded.narrative).toBe('The pair shipped the worker.');
    expect(grounded.summary).toBe('The pair shipped the worker.');
    expect(grounded.citations).toEqual(['d1']);
  });

  it('drops a sentence that cites nothing, and one that cites a tag the prompt never carried', () => {
    const grounded = assembleNarrative(
      {
        sentences: [
          { text: 'The probe was gathering detailed data from a target.', source_ids: [] },
          { text: 'All stakeholders were informed.', source_ids: ['S9'] },
          { text: 'The pair shipped the worker.', source_ids: ['S1'] },
        ],
      },
      source,
    );

    expect(grounded.kept).toBe(1);
    expect(grounded.dropped).toBe(2);
    expect(grounded.narrative).toBe('The pair shipped the worker.');
  });

  it('reads the tag back however the model wrote it', () => {
    const grounded = assembleNarrative(
      { sentences: [{ text: 'The worker shipped.', source_ids: ['[s1]'] }] },
      source,
    );

    expect(grounded.citations).toEqual(['e1']);
  });

  it('stops at the budget the source supports', () => {
    const thin = renderNarrativeSource([episode('e1', { summary: 'one line' })], [], 40, 2000);
    const grounded = assembleNarrative(
      {
        sentences: [
          { text: 'One.', source_ids: ['S1'] },
          { text: 'Two.', source_ids: ['S1'] },
          { text: 'Three.', source_ids: ['S1'] },
        ],
      },
      thin,
    );

    expect(thin.sentenceBudget).toBe(1);
    expect(grounded.kept).toBe(1);
    expect(grounded.dropped).toBe(2);
  });

  it('leaves nothing to store when every sentence was ungrounded', () => {
    const grounded = assembleNarrative(
      { sentences: [{ text: 'A microservices architecture was adopted.', source_ids: [] }] },
      source,
    );

    expect(grounded.kept).toBe(0);
    expect(grounded.narrative).toBe('');
    expect(grounded.summary).toBe('');
  });
});

describe('model contract', () => {
  it('asks for cited sentences and states the budget the source supports', () => {
    const source = renderNarrativeSource(
      [episode('e1', { summary: 'shipped the worker' })],
      [],
      40,
      2000,
    );

    const messages = buildNarrativeMessages(source);

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('source_ids');
    expect(messages[0]?.content).toContain('at most 1 sentences');
    expect(messages[1]?.content).toContain('shipped the worker');
    expect(messages[1]?.content).toContain('[S1]');
  });

  it('rejects an answer that is not a list of sentences with citations', () => {
    expect(NarrativeOutputSchema.safeParse({ summary: 'a session' }).success).toBe(false);
    expect(NarrativeOutputSchema.safeParse({ sentences: [{ text: 'a' }] }).success).toBe(false);
    expect(
      NarrativeOutputSchema.safeParse({ sentences: [{ text: 'a', source_ids: ['S1'] }] }).success,
    ).toBe(true);
  });
});
