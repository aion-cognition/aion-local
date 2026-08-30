import type { Cue, StageTimingsMs } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { AdmissionReport } from './admission.js';
import type { FusedItem } from './fusion.js';
import { assemblePack, estimateTokens, type AssemblePackInput, type BucketCaps } from './pack.js';

/**
 * What a pack says about itself: which facts it declines to carry, what number it prints
 * beside an item, and the one line that tells a text-only reader the answer is thin.
 * Routing, caps and the budget are `pack.test.ts`.
 */

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
  /** The absolute cosine behind admission; zero for an item a literal match let in. */
  readonly measured?: number;
};

function item(id: string, overrides: ItemOverrides = {}): FusedItem {
  const { path } = overrides;
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
    measured: overrides.measured ?? 0.8,
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

/** A gate that judged exactly the items handed over and dropped nothing, unless a test says otherwise. */
function report(items: readonly FusedItem[]): AdmissionReport {
  return {
    policy: { vectorFloor: 0.6, corroborationFloor: 0.45, bm25Mode: 'exact' },
    considered: items.length,
    admitted: items.length,
    droppedBelowFloor: 0,
    droppedUnmeasured: 0,
    droppedUnmeasuredArrival: 0,
    droppedDuplicateContent: 0,
    droppedNearDuplicate: 0,
    anchored: items.length > 0,
  };
}

function assemble(items: readonly FusedItem[], overrides: Partial<AssemblePackInput> = {}) {
  return assemblePack({
    items,
    admission: report(items),
    caps: CAPS,
    tokenBudget: 1200,
    cues: CUES,
    timings: TIMINGS,
    ...overrides,
  });
}

describe('the facts bucket', () => {
  function gloss(id: string): FusedItem {
    return item(id, {
      labels: ['Entity', 'Memory', 'AionNode'],
      content: `${id} (concept): a gloss`,
    });
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
    const pack = assemble([{ ...gloss('g1'), occurredAt: new Date('2025-11-14T08:30:00.000Z') }]);

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
    const pack = assemble([
      item('s1', { labels: ['Session', 'AionNode'] }),
      item('e1'),
      item('e2'),
    ]);

    expect(pack.episodes?.map((entry) => entry.rank)).toEqual([1, 2]);
  });

  it('carries the absolute measurement the floor read, not the method score', () => {
    // The exact shape the lexical leg produces: BM25 normalizes to the best hit of its cue, so
    // `relevance` is 1.00 for the top hit of any query while the cosine behind admission is
    // 0.62. Printing the first is what made a lexical hit read as the strongest item in a pack.
    const measured: FusedItem = {
      ...item('e1'),
      relevance: 1,
      measured: 0.62,
      rationale: { method: 'bm25', score: 1 },
    };

    const pack = assemble([measured]);

    expect(pack.episodes?.[0]?.confidence).toBe(0.62);
    expect(pack.rendered_text).toContain('bm25 | confidence 0.62');
    expect(pack.rendered_text).not.toContain('confidence 1.00');
  });

  it('says zero for an item a literal match admitted and no cosine measured', () => {
    const exact: FusedItem = {
      ...item('reached'),
      relevance: 1,
      measured: 0,
      rationale: { method: 'bm25', score: 1 },
    };

    const pack = assemble([exact]);

    expect(pack.episodes?.[0]?.confidence).toBe(0);
    // Rendered as what it is. "confidence 0.00" beside a verbatim match reads as no answer.
    expect(pack.rendered_text).toContain('bm25 | exact match');
    expect(pack.rendered_text).not.toContain('confidence 0.00');
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
      '# Memory\n\nnote: degraded graph reads (unavailable)\n\n' +
        'No memories matched this query. Nothing reached the admission gate.',
    );
  });

  /**
   * The three empty packs a caller has to tell apart. Without the verdict all three render the
   * same sentence, and a note about a truncated spread standing over it reads as the reason the
   * pack came back empty when the floor is what actually answered.
   */
  it('says which of the empty packs it is', () => {
    const nothingStored = assemble([]);
    const floorDidItsJob = assemble([], {
      admission: { ...report([]), considered: 29, droppedBelowFloor: 29 },
      truncated: 'activation_budget',
    });
    const nothingMeasured = assemble([], {
      admission: {
        ...report([]),
        considered: 15,
        droppedUnmeasured: 15,
        droppedUnmeasuredArrival: 15,
      },
    });

    expect(nothingStored.rendered_text).toContain('Nothing reached the admission gate.');
    expect(floorDidItsJob.rendered_text).toContain(
      'Of 29 candidates: 29 measured under the 0.60 floor.',
    );
    expect(floorDidItsJob.rendered_text).toContain('spread truncated on the activation budget');
    expect(nothingMeasured.rendered_text).toContain(
      'Of 15 candidates: 15 that nothing measured against it.',
    );
  });

  it('names both refusals when a pack met each of them', () => {
    const pack = assemble([], {
      admission: { ...report([]), considered: 52, droppedBelowFloor: 37, droppedUnmeasured: 15 },
    });

    expect(pack.rendered_text).toContain(
      'Of 52 candidates: 37 measured under the 0.60 floor, 15 that nothing measured against it.',
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
