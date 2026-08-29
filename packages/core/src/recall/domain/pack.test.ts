import { MemoryPackSchema, type Cue, type StageTimingsMs } from '@aion/protocol';
import { describe, expect, it } from 'vitest';
import type { FusedItem } from './fusion.js';
import {
  assemblePack,
  bucketFor,
  CHARS_PER_TOKEN,
  estimateTokens,
  type AssemblePackInput,
  type BucketCaps,
} from './pack.js';

const TIMINGS: StageTimingsMs = { embed: 12, cues: 340, seeds: 55, activation: 80, fusion: 4 };

const CUES: readonly Cue[] = [{ text: 'webhooks', source: 'query', weight: 3 }];

const CAPS: BucketCaps = {
  facts: 15,
  episodes: 5,
  narratives: 5,
  preferences: 3,
  resonant: 5,
};

type ItemOverrides = {
  readonly labels?: readonly string[];
  readonly content?: string;
  readonly score?: number;
  readonly occurredAt?: Date;
  readonly path?: string;
  readonly superseded?: boolean;
  readonly sourceEpisodeId?: string;
};

function item(id: string, overrides: ItemOverrides = {}): FusedItem {
  const path = overrides.path;
  return {
    id,
    labels: overrides.labels ?? ['Episode', 'Memory', 'AionNode'],
    content: overrides.content ?? `content of ${id}`,
    ...(overrides.occurredAt === undefined ? {} : { occurredAt: overrides.occurredAt }),
    rationale: {
      method: path === undefined ? 'vector' : 'activation',
      score: 0.8,
      ...(path === undefined ? {} : { path }),
    },
    relevance: 0.8,
    score: overrides.score ?? 0.02,
    ...(overrides.sourceEpisodeId === undefined
      ? {}
      : { sourceEpisodeId: overrides.sourceEpisodeId }),
    ...(overrides.superseded === true
      ? {
          currency: 'superseded' as const,
          supersededBy: { id: `${id}-successor`, at: new Date('2026-08-10T00:00:00.000Z') },
        }
      : { currency: 'current' as const }),
  };
}

function assemble(items: readonly FusedItem[], overrides: Partial<AssemblePackInput> = {}) {
  return assemblePack({
    items,
    caps: CAPS,
    tokenBudget: 1200,
    cues: CUES,
    timings: TIMINGS,
    ...overrides,
  });
}

describe('bucket routing', () => {
  it('routes conversational memory to episodes and entity-derived content to facts', () => {
    expect(bucketFor(['Episode', 'Memory', 'AionNode'])).toBe('episodes');
    expect(bucketFor(['Turn', 'Memory', 'AionNode'])).toBe('episodes');
    expect(bucketFor(['Entity', 'AionNode'])).toBe('facts');
    expect(bucketFor(['Member', 'Entity', 'AionNode'])).toBe('facts');
  });

  it('routes a narrative to its own bucket rather than folding it into episodes', () => {
    expect(bucketFor(['Narrative', 'Memory', 'AionNode'])).toBe('narratives');
  });

  it('routes every cognitive type to facts, which is where a decision belongs', () => {
    for (const label of ['Goal', 'Plan', 'Decision', 'Insight', 'Concept', 'Context', 'Event', 'Pattern', 'Trend']) {
      expect(bucketFor([label, 'Memory', 'AionNode'])).toBe('facts');
    }
  });

  it('has no bucket for a node type nothing packs yet', () => {
    expect(bucketFor(['Session', 'AionNode'])).toBeUndefined();
  });

  it('drops an item whose label routes nowhere instead of guessing a bucket', () => {
    const pack = assemble([item('s1', { labels: ['Session', 'AionNode'] }), item('e1')]);

    expect(pack.facts).toBeUndefined();
    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e1']);
  });

  it('omits a bucket that no item landed in rather than sending an empty array', () => {
    const pack = assemble([item('e1')]);

    expect(pack.episodes).toHaveLength(1);
    expect(pack.facts).toBeUndefined();
    expect(pack.narratives).toBeUndefined();
    expect(pack.preferences).toBeUndefined();
    expect(pack.resonant).toBeUndefined();
  });
});

describe('per-category caps', () => {
  it('cuts a bucket at its cap and leaves the other buckets their own room', () => {
    const episodes = ['e1', 'e2', 'e3'].map((id) => item(id));
    const facts = ['f1', 'f2'].map((id) => item(id, { labels: ['Entity', 'AionNode'] }));

    const pack = assemble([...episodes, ...facts], {
      caps: { ...CAPS, episodes: 2, facts: 1 },
    });

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e1', 'e2']);
    expect(pack.facts?.map((entry) => entry.id)).toEqual(['f1']);
  });

  it('drops a bucket entirely at a cap of zero', () => {
    const pack = assemble([item('e1')], { caps: { ...CAPS, episodes: 0 } });

    expect(pack.episodes).toBeUndefined();
    expect(pack.rendered_text).toContain('No memories matched this query.');
  });
});

describe('turns fold into the episode they came from', () => {
  function turnOf(episodeId: string, index: number): FusedItem {
    return item(`${episodeId}-t${String(index)}`, {
      labels: ['Turn', 'Memory', 'AionNode'],
      content: `line ${String(index)} of ${episodeId}`,
      sourceEpisodeId: episodeId,
    });
  }

  it('spends one episode slot on an episode and its own turns', () => {
    const pack = assemble([item('e1'), turnOf('e1', 0), turnOf('e1', 1), item('e2')]);

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e1', 'e2']);
  });

  it('keeps a chatty episode from filling the bucket by itself', () => {
    const turns = [0, 1, 2, 3, 4].map((index) => turnOf('e1', index));

    const pack = assemble([...turns, item('e2'), item('e3')], {
      caps: { ...CAPS, episodes: 3 },
    });

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e1-t0', 'e2', 'e3']);
  });

  it('packs a turn whose episode never surfaced, so an exact-token hit is not lost', () => {
    const pack = assemble([turnOf('e1', 2), item('e2')]);

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e1-t2', 'e2']);
  });
});

describe('the token budget', () => {
  it('stays inside the budget it was given', () => {
    const items = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) =>
      item(id, { content: 'x'.repeat(400) }),
    );

    const pack = assemble(items, { tokenBudget: 200 });

    expect(pack.metadata.token_estimate).toBeLessThanOrEqual(200);
    expect(pack.episodes?.length ?? 0).toBeLessThan(items.length);
  });

  it('skips one oversized memory rather than letting it starve the smaller ones under it', () => {
    const pack = assemble(
      [item('huge', { content: 'x'.repeat(4000) }), item('small', { content: 'concise' })],
      { tokenBudget: 120 },
    );

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['small']);
  });

  it('estimates tokens from the rendered block at the documented characters-per-token', () => {
    const pack = assemble([item('e1')]);

    expect(CHARS_PER_TOKEN).toBe(4);
    expect(pack.metadata.token_estimate).toBe(estimateTokens(pack.rendered_text));
  });
});

describe('the explicitly empty pack', () => {
  it('says so plainly and still carries cues, timings, and an estimate', () => {
    const pack = assemble([]);

    expect(pack.facts).toBeUndefined();
    expect(pack.episodes).toBeUndefined();
    expect(pack.rendered_text).toContain('No memories matched this query.');
    expect(pack.metadata.stage_timings_ms).toEqual(TIMINGS);
    expect(pack.metadata.cues).toEqual(CUES);
    expect(pack.metadata.token_estimate).toBeGreaterThan(0);
  });

  it('names the degradation ladder when the cue model failed', () => {
    const pack = assemble([], { degraded: [{ stage: 'cues', reason: 'timeout' }] });

    expect(pack.metadata.degraded).toEqual([{ stage: 'cues', reason: 'timeout' }]);
  });

  it('names every rung that fired, in stage order', () => {
    const pack = assemble([], {
      degraded: [
        { stage: 'cues', reason: 'model_error' },
        { stage: 'embed', reason: 'model_error' },
      ],
    });

    expect(pack.metadata.degraded).toEqual([
      { stage: 'cues', reason: 'model_error' },
      { stage: 'embed', reason: 'model_error' },
    ]);
  });

  it('leaves the marker absent rather than empty when no rung fired', () => {
    expect(assemble([], { degraded: [] }).metadata.degraded).toBeUndefined();
  });

  it('leaves the degraded marker absent on a normal recall', () => {
    expect(assemble([item('e1')]).metadata.degraded).toBeUndefined();
  });

  it('names the calling session\'s unenriched episode count', () => {
    expect(assemble([], { pendingEnrichment: 3 }).metadata.pending_enrichment).toBe(3);
  });

  it('leaves pending_enrichment absent at zero rather than stating it', () => {
    expect(assemble([], { pendingEnrichment: 0 }).metadata.pending_enrichment).toBeUndefined();
  });

  it('leaves pending_enrichment absent when the caller never measured it', () => {
    expect(assemble([]).metadata.pending_enrichment).toBeUndefined();
  });
});

describe('the structured items', () => {
  it('carries the rationale, the occurrence time, and the lineage of every item', () => {
    const pack = assemble([
      item('stale', { occurredAt: new Date('2026-08-01T00:00:00.000Z'), superseded: true }),
    ]);

    expect(pack.episodes?.[0]).toEqual({
      id: 'stale',
      content: 'content of stale',
      occurred_at: '2026-08-01T00:00:00.000Z',
      rank: 1,
      confidence: 0.8,
      rationale: { method: 'vector', score: 0.8 },
      currency: 'superseded',
      superseded_by: { id: 'stale-successor', at: '2026-08-10T00:00:00.000Z' },
    });
  });

  it('conforms to the protocol schema it is handed to the agent under', () => {
    const pack = assemble([item('e1'), item('f1', { labels: ['Entity', 'AionNode'] })]);
    expect(MemoryPackSchema.safeParse(pack).success).toBe(true);
  });
});

describe('the rendered text block', () => {
  it('sections by bucket, numbers within it, and keeps schema order between sections', () => {
    const pack = assemble([item('e1'), item('f1', { labels: ['Entity', 'AionNode'] }), item('e2')]);

    expect(pack.rendered_text).toContain('## Facts');
    expect(pack.rendered_text).toContain('## Episodes');
    expect(pack.rendered_text.indexOf('## Facts')).toBeLessThan(
      pack.rendered_text.indexOf('## Episodes'),
    );
    // The list number is the item's rank across the whole pack, so f1 at facts rank 1 is
    // globally 2 and the reader can order it against the two episodes.
    expect(pack.rendered_text).toContain('1. content of e1');
    expect(pack.rendered_text).toContain('2. content of f1');
    expect(pack.rendered_text).toContain('3. content of e2');
  });

  it('shows the traversal path of an activated item', () => {
    const pack = assemble([item('reached', { path: 'a -[PARTICIPATES_IN]-> b -[FOLLOWS]-> c' })]);

    expect(pack.rendered_text).toContain('activation | confidence 0.80');
    expect(pack.rendered_text).toContain('path a -[PARTICIPATES_IN]-> b -[FOLLOWS]-> c');
  });

  it('marks a superseded item with what replaced it and when', () => {
    const pack = assemble([item('stale', { superseded: true })]);

    expect(pack.rendered_text).toContain(
      'superseded by stale-successor at 2026-08-10T00:00:00.000Z',
    );
  });
});

describe('the facts bucket', () => {
  function gloss(id: string): FusedItem {
    return item(id, { labels: ['Entity', 'Memory', 'AionNode'], content: `${id} (concept): a gloss` });
  }

  function goal(id: string): FusedItem {
    return item(id, { labels: ['Goal', 'Memory', 'AionNode'] });
  }

  it('caps entity glosses well under the bucket cap', () => {
    const items = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map(gloss);

    const pack = assemble(items, { entityGlossCap: 4 });

    expect(pack.facts?.map((entry) => entry.id)).toEqual(['g1', 'g2', 'g3', 'g4']);
  });

  it('leaves room for content the glosses would otherwise have crowded out', () => {
    const decision = item('d1', { labels: ['Decision', 'Memory', 'AionNode'] });
    const items = [...['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map(gloss), decision];

    const pack = assemble(items, { entityGlossCap: 2, caps: { ...CAPS, facts: 3 } });

    expect(pack.facts?.map((entry) => entry.id)).toEqual(['g1', 'g2', 'd1']);
  });

  it('leaves the glosses uncapped when the caller measured no cap', () => {
    const pack = assemble(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map(gloss));

    expect(pack.facts).toHaveLength(6);
  });

  it('keeps a query-restating Goal out of the bucket entirely, at any rank', () => {
    const pack = assemble([goal('restating'), goal('answering')], {
      restating: new Set(['restating']),
    });

    expect(pack.facts?.map((entry) => entry.id)).toEqual(['answering']);
  });

  it('leaves an item in another bucket alone even when named as restating', () => {
    const pack = assemble([item('e1')], { restating: new Set(['e1']) });

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e1']);
  });

  it('dates an entity gloss by its first mention rather than by an occurrence', () => {
    const pack = assemble([
      { ...gloss('g1'), occurredAt: new Date('2025-11-14T08:30:00.000Z') },
    ]);

    expect(pack.rendered_text).toContain('from first mention, 2025-11-14');
    expect(pack.rendered_text).not.toContain('occurred 2025-11-14');
  });

  it('keeps the occurrence stamp on everything that is not a gloss', () => {
    const pack = assemble([item('e1', { occurredAt: new Date('2025-11-14T08:30:00.000Z') })]);

    expect(pack.rendered_text).toContain('occurred 2025-11-14T08:30:00.000Z');
    expect(pack.rendered_text).not.toContain('from first mention');
  });
});

describe('rank and confidence', () => {
  it('numbers items by their rank across the whole pack, not within a bucket', () => {
    const pack = assemble([
      item('e1'),
      item('f1', { labels: ['Entity', 'AionNode'] }),
      item('e2'),
      item('f2', { labels: ['Entity', 'AionNode'] }),
    ]);

    expect(pack.episodes?.map((entry) => entry.rank)).toEqual([1, 3]);
    expect(pack.facts?.map((entry) => entry.rank)).toEqual([2, 4]);
  });

  it('leaves no gap in the ranks when an item is dropped before it is packed', () => {
    const pack = assemble([item('s1', { labels: ['Session', 'AionNode'] }), item('e1'), item('e2')]);

    expect(pack.episodes?.map((entry) => entry.rank)).toEqual([1, 2]);
  });

  it('carries the absolute measurement the floor read, not the method score', () => {
    const measured: FusedItem = {
      ...item('e1'),
      relevance: 0.62,
      rationale: { method: 'bm25', score: 1 },
    };

    const pack = assemble([measured]);

    expect(pack.episodes?.[0]?.confidence).toBe(0.62);
    expect(pack.rendered_text).toContain('bm25 | confidence 0.62');
    expect(pack.rendered_text).not.toContain('bm25 1.00');
  });

  it('says zero for an item nothing measured', () => {
    const traversed: FusedItem = { ...item('reached', { path: 'a -[X]-> b' }), relevance: 0 };

    expect(assemble([traversed]).episodes?.[0]?.confidence).toBe(0);
  });
});

describe('the honesty line', () => {
  it('states every signal that fired, in one line at the top', () => {
    const pack = assemble([item('e1')], {
      degraded: [{ stage: 'cues', reason: 'timeout' }],
      truncated: 'activation_budget',
      pendingEnrichment: 2,
    });

    const [heading, note] = pack.rendered_text.split('\n\n');
    expect(heading).toBe('# Memory');
    expect(note).toBe(
      'note: degraded cue extraction (timeout); spread truncated on the activation budget; ' +
        '2 recent episodes not yet enriched',
    );
  });

  it('names each degradation rung separately', () => {
    const pack = assemble([], {
      degraded: [
        { stage: 'cues', reason: 'model_error' },
        { stage: 'embed', reason: 'model_error' },
        { stage: 'graph', reason: 'unavailable' },
      ],
    });

    expect(pack.rendered_text).toContain(
      'note: degraded cue extraction (model_error); degraded embedding (model_error); ' +
        'degraded graph reads (unavailable)',
    );
  });

  it('reaches an empty pack too, which is where a caller most needs it', () => {
    const pack = assemble([], { degraded: [{ stage: 'graph', reason: 'unavailable' }] });

    expect(pack.rendered_text).toBe(
      '# Memory\n\nnote: degraded graph reads (unavailable)\n\nNo memories matched this query.',
    );
  });

  it('says nothing at all on a healthy pack', () => {
    const pack = assemble([item('e1')], { degraded: [], pendingEnrichment: 0 });

    expect(pack.rendered_text).not.toContain('note:');
    expect(pack.metadata.truncated).toBeUndefined();
  });

  it('agrees with the singular when exactly one episode is unenriched', () => {
    expect(assemble([], { pendingEnrichment: 1 }).rendered_text).toContain(
      '1 recent episode not yet enriched',
    );
  });

  it('names the truncation in metadata as well as in the line', () => {
    const pack = assemble([item('e1')], { truncated: 'activation_budget' });

    expect(pack.metadata.truncated).toBe('activation_budget');
  });

  it('charges the note to the token budget rather than letting it overrun', () => {
    const pack = assemble([item('e1', { content: 'x'.repeat(200) })], {
      tokenBudget: 60,
      degraded: [{ stage: 'cues', reason: 'timeout' }],
      pendingEnrichment: 3,
    });

    expect(pack.metadata.token_estimate).toBeLessThanOrEqual(60);
    expect(pack.metadata.token_estimate).toBe(estimateTokens(pack.rendered_text));
  });
});
