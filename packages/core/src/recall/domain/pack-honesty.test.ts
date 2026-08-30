import type { Cue, StageTimingsMs } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { AdmissionEvidence, AdmissionReport } from './admission.js';
import type { FusedItem } from './fusion.js';
import type { BucketCaps } from './pack-buckets.js';
import { assemblePack, estimateTokens, type AssemblePackInput } from './pack.js';

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
  /** The rule that let the item in, as the gate reports it. */
  readonly admittedBy?: AdmissionEvidence;
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
    ...(overrides.admittedBy === undefined ? {} : { admittedBy: overrides.admittedBy }),
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

/**
 * A number alone cannot say which floor judged it. The gate has four ways in, and the pack
 * that shipped without this printed the strongest cosine anything measured, so an item a
 * verbatim lexical hit admitted could show 0.53 beside a corroboration floor of 0.55 and read
 * as a gate with a hole in it.
 */
describe('the rule that admitted an item', () => {
  function admitted(id: string, evidence: AdmissionEvidence): FusedItem {
    return item(id, { measured: evidence.score, admittedBy: evidence });
  }

  it('prints the cosine that cleared the vector floor', () => {
    const pack = assemble([
      admitted('e1', { rule: 'vector_floor', score: 0.72, qualifying: ['vector 0.72'] }),
    ]);

    expect(pack.episodes?.[0]?.confidence).toBe(0.72);
    expect(pack.episodes?.[0]?.admitted_by).toEqual({
      rule: 'vector_floor',
      evidence: ['vector 0.72'],
    });
    expect(pack.rendered_text).toContain('vector floor: vector 0.72');
  });

  it('prints the literal match and no number, since no rule read one', () => {
    const pack = assemble([
      admitted('e1', { rule: 'exact_match', score: 0, qualifying: ['bm25 exact'] }),
    ]);

    expect(pack.episodes?.[0]?.confidence).toBe(0);
    expect(pack.rendered_text).toContain('exact match: bm25 exact');
    expect(pack.rendered_text).not.toContain('confidence 0.00');
  });

  it('prints both legs that corroborated and the score the rule read', () => {
    const pack = assemble([
      admitted('e1', {
        rule: 'corroborated',
        score: 0.56,
        qualifying: ['vector 0.56', 'bm25 exact'],
      }),
    ]);

    expect(pack.episodes?.[0]?.confidence).toBe(0.56);
    expect(pack.rendered_text).toContain('corroborated: vector 0.56 + bm25 exact');
  });

  it('prints the context threshold on a resonant hit, which no content floor judged', () => {
    const pack = assemble([], {
      resonant: [
        admitted('r1', {
          rule: 'context_threshold',
          score: 0.94,
          qualifying: ['resonance 0.94'],
        }),
      ],
    });

    expect(pack.rendered_text).toContain('context threshold: resonance 0.94');
  });

  it('names the escape hatch when an uncalibrated lexical hit admitted alone', () => {
    const pack = assemble([
      admitted('e1', { rule: 'bm25_any', score: 0, qualifying: ['bm25 1.00'] }),
    ]);

    expect(pack.rendered_text).toContain('uncalibrated lexical hit: bm25 1.00');
  });

  it('falls back to the bare measurement for an item assembled without the gate', () => {
    const pack = assemble([item('e1', { measured: 0.62 })]);

    expect(pack.episodes?.[0]?.admitted_by).toBeUndefined();
    expect(pack.rendered_text).toContain('confidence 0.62');
  });
});

/**
 * A raw turn is captured text. Nothing distils it into a claim and supersession judges
 * extracted nodes, so a belief stated in a turn answers as current for as long as the
 * substrate holds it. When resonance surfaces one alone the pack carries that belief with
 * nothing around it, and the annotation is what puts the current claim in front of the reader.
 */
describe('a raw turn in the resonant bucket', () => {
  const TURN = ['Turn', 'Memory', 'AionNode'];

  const CLAIM = {
    id: 'insight-1',
    text: 'Background shell tasks are not reliable overnight on this machine.',
  };

  function turn(id: string): FusedItem {
    return item(id, { labels: TURN, content: `${id}: background shell tasks are reliable` });
  }

  it('carries the current claim from its subject family and renders it under the item', () => {
    const pack = assemble([], {
      resonant: [turn('t1')],
      relatedClaims: new Map([['t1', CLAIM]]),
    });

    expect(pack.resonant?.[0]?.related_claim).toEqual(CLAIM);
    expect(pack.rendered_text).toContain(`current related claim: ${CLAIM.text} [insight-1]`);
  });

  it('says nothing at all when the family holds no current claim', () => {
    const pack = assemble([], { resonant: [turn('t1')], relatedClaims: new Map() });

    expect(pack.resonant?.[0]?.related_claim).toBeUndefined();
    expect(pack.rendered_text).not.toContain('current related claim');
  });

  /** The annotation answers a turn surfaced alone; a turn the query matched has its own context. */
  it('leaves a turn the first pass admitted unannotated', () => {
    const pack = assemble([turn('t1')], { relatedClaims: new Map([['t1', CLAIM]]) });

    expect(pack.episodes?.[0]?.related_claim).toBeUndefined();
  });

  it('charges the annotation to the item that carries it', () => {
    const withClaim = assemble([], {
      resonant: [turn('t1')],
      relatedClaims: new Map([['t1', CLAIM]]),
    });
    const without = assemble([], { resonant: [turn('t1')] });

    expect(withClaim.metadata.token_estimate).toBeGreaterThan(without.metadata.token_estimate);
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

/**
 * What the pack says about the memories it declined to repeat. A shrinking pack mid-session
 * reads as retrieval going quiet unless the pack says out loud that it withheld a repeat, and
 * an agent reading only the rendered block is the one that would otherwise ask again.
 */
describe('repeats this session already holds', () => {
  it('leaves a suppressed item out of its bucket entirely', () => {
    const pack = assemble([item('e1'), item('e2')], { suppressed: new Set(['e1']) });

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e2']);
  });

  it('omits a bucket whose every item was already served, rather than sending it empty', () => {
    const pack = assemble([item('e1'), item('f1', { labels: ['Entity', 'AionNode'] })], {
      suppressed: new Set(['e1']),
    });

    expect(pack.episodes).toBeUndefined();
    expect(pack.facts?.map((entry) => entry.id)).toEqual(['f1']);
  });

  it('withholds a resonant discovery this session was already handed', () => {
    const pack = assemble([], {
      resonant: [item('r1', { path: 'a' }), item('r2', { path: 'a' })],
      suppressed: new Set(['r2']),
    });

    expect(pack.resonant?.map((entry) => entry.id)).toEqual(['r1']);
  });

  it('counts what it withheld and names it in the line', () => {
    const pack = assemble([item('e1'), item('e2'), item('e3')], {
      suppressed: new Set(['e1', 'e2']),
    });

    expect(pack.metadata.suppressed_repeats).toBe(2);
    expect(pack.rendered_text).toContain('note: 2 items already served this session, unchanged');
  });

  it('agrees with the singular when it withheld exactly one', () => {
    const pack = assemble([item('e1'), item('e2')], { suppressed: new Set(['e1']) });

    expect(pack.rendered_text).toContain('note: 1 item already served this session, unchanged');
  });

  it('says nothing when it withheld nothing, on either shape of an absent record', () => {
    const empty = assemble([item('e1')], { suppressed: new Set() });
    const absent = assemble([item('e1')]);

    expect(empty.metadata.suppressed_repeats).toBeUndefined();
    expect(empty).toEqual(absent);
    expect(empty.rendered_text).not.toContain('note:');
  });

  /**
   * An empty pack here is legal, and the reason matters: "no memories matched" would send the
   * caller looking for a substrate problem when every match is already in front of it.
   */
  it('explains an empty pack that emptied because the session already holds it all', () => {
    const pack = assemble([item('e1')], { suppressed: new Set(['e1']) });

    expect(pack.episodes).toBeUndefined();
    expect(pack.rendered_text).toBe(
      '# Memory\n\nnote: 1 item already served this session, unchanged\n\n' +
        'This session already holds every memory this query matched.',
    );
  });

  it('still reports what the floor refused beside what it withheld', () => {
    const pack = assemble([item('e1')], {
      admission: { ...report([item('e1')]), considered: 30, admitted: 1, droppedBelowFloor: 29 },
      suppressed: new Set(['e1']),
    });

    expect(pack.rendered_text).toContain(
      'This session already holds every memory this query matched. ' +
        'Of 30 candidates: 29 measured under the 0.60 floor.',
    );
  });

  it('spends the freed budget on what the session has not seen', () => {
    const long = 'a memory long enough that two of them will not fit together '.repeat(4);
    const budget = 120;

    const withRepeat = assemble([item('e1', { content: long }), item('e2', { content: long })], {
      tokenBudget: budget,
    });
    const deduped = assemble([item('e1', { content: long }), item('e2', { content: long })], {
      tokenBudget: budget,
      suppressed: new Set(['e1']),
    });

    expect(withRepeat.episodes?.map((entry) => entry.id)).toEqual(['e1']);
    expect(deduped.episodes?.map((entry) => entry.id)).toEqual(['e2']);
  });
});
