import { MemoryPackSchema } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { FusedItem } from './fusion.js';
import { bucketFor } from './pack-buckets.js';
import { MAX_WHY_CHARS } from './pack-item.js';
import { CHARS_PER_TOKEN, estimateTokens, packMethods } from './pack.js';
import { assemble, CAPS, CUES, item, TIMINGS } from './test-support/pack.fixture.js';

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
    for (const label of [
      'Goal',
      'Plan',
      'Decision',
      'Insight',
      'Concept',
      'Context',
      'Event',
      'Pattern',
      'Trend',
    ]) {
      expect(bucketFor([label, 'Memory', 'AionNode'])).toBe('facts');
    }
  });

  it('routes a bridge to facts, since it carries a content vector retrieval returns', () => {
    expect(bucketFor(['Bridge', 'Memory', 'AionNode'])).toBe('facts');

    const pack = assemble([item('b1', { labels: ['Bridge', 'Memory', 'AionNode'] })]);
    expect(pack.facts?.map((entry) => entry.id)).toEqual(['b1']);
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

  it("names the calling session's unenriched episode count", () => {
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

  it('leaves why absent on an item whose node carries no rationale', () => {
    const pack = assemble([item('e1')]);
    expect(pack.episodes?.[0]?.why).toBeUndefined();
  });

  it("carries the node's own reason as a distinct field from the retrieval rationale", () => {
    const pack = assemble([
      item('d1', {
        labels: ['Decision', 'Memory', 'AionNode'],
        why: 'PostgreSQL already owns the ledger row.',
      }),
    ]);

    expect(pack.facts?.[0]?.why).toBe('PostgreSQL already owns the ledger row.');
    expect(pack.facts?.[0]?.rationale).toEqual({ method: 'vector', score: 0.8 });
  });

  it('caps a why past the length limit at the last whole word', () => {
    const long = `${'reason '.repeat(40)}word`;
    const pack = assemble([item('d1', { labels: ['Decision', 'Memory', 'AionNode'], why: long })]);

    const capped = pack.facts?.[0]?.why ?? '';
    expect(capped.length).toBeLessThanOrEqual(MAX_WHY_CHARS + 1);
    expect(capped.endsWith('…')).toBe(true);
    expect(long.startsWith(capped.slice(0, -1))).toBe(true);
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

  it('renders why as its own line directly under the claim, ahead of the provenance line', () => {
    const pack = assemble([
      item('d1', {
        labels: ['Decision', 'Memory', 'AionNode'],
        why: 'A Redis mutex would duplicate a guarantee Postgres already gives.',
      }),
    ]);

    const lines = pack.rendered_text.split('\n');
    const claimIndex = lines.findIndex((line) => line.includes('1. content of d1'));
    expect(lines[claimIndex + 1]).toBe(
      '   why: A Redis mutex would duplicate a guarantee Postgres already gives.',
    );
    expect(lines[claimIndex + 2]).toContain('[d1] | vector | confidence 0.80');
  });

  it('omits the why line entirely for an item whose node carries no rationale', () => {
    const pack = assemble([item('e1')]);
    expect(pack.rendered_text).not.toContain('why:');
  });
});

/**
 * The spirit metric is only as honest as its input. Fusion and resonance offer more than a
 * pack can hold, and the counter has to be fed by what survived assembly: crediting an
 * associative mechanism for items the budget or a cap dropped inflates the exact claim the
 * measurement exists to test.
 */
describe('packMethods', () => {
  it('reports one method per item the pack holds, in bucket order', () => {
    const pack = assemble([item('e1'), item('e2', { path: 'Episode-[MENTIONS]->Entity' })], {
      resonant: [item('r1', { path: 'Episode-[RELATED_TO]->Episode' })],
    });

    expect(packMethods(pack)).toEqual(['vector', 'activation', 'activation']);
  });

  it('counts nothing for items a bucket cap dropped', () => {
    const admitted = [
      item('r1', { path: 'a' }),
      item('r2', { path: 'a' }),
      item('r3', { path: 'a' }),
    ];
    const pack = assemble([item('e1')], { caps: { ...CAPS, resonant: 1 }, resonant: admitted });

    // Three resonant items admitted, one served: the counter follows the pack.
    expect(pack.resonant).toHaveLength(1);
    expect(packMethods(pack)).toEqual(['vector', 'activation']);
  });

  it('counts nothing for items the token budget dropped', () => {
    const long = 'a long memory that costs more than the budget has left '.repeat(20);
    const pack = assemble([item('e1'), item('e2', { content: long, path: 'a' })], {
      tokenBudget: 60,
    });

    expect(packMethods(pack)).toEqual(['vector']);
  });

  it('is empty for a pack that served nothing', () => {
    expect(packMethods(assemble([]))).toEqual([]);
  });
});
