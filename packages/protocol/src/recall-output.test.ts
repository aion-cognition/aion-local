import { describe, expect, it } from 'vitest';
import { CueSchema, MemoryPackItemSchema, MemoryPackSchema, RationaleSchema } from './recall-output.js';

const baseMetadata = {
  token_estimate: 240,
  stage_timings_ms: { embed: 12, cues: 340, seeds: 55, activation: 80, fusion: 4 },
  cues: [{ text: 'webhooks', source: 'query', weight: 3 }],
  admission: {
    considered: 0,
    admitted: 0,
    dropped_below_floor: 0,
    dropped_unmeasured: 0,
    dropped_duplicate_content: 0,
    dropped_near_duplicate: 0,
    vector_floor: 0.6,
    corroboration_floor: 0.45,
    bm25_mode: 'exact',
  },
};

describe('MemoryPackSchema valid fixtures', () => {
  it('parses an explicitly empty pack: no buckets, metadata and rendered_text still present', () => {
    const pack = { rendered_text: 'No relevant memories found.', metadata: baseMetadata };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('parses a degraded pack: the ladder names itself and the cue carries the raw query', () => {
    const pack = {
      rendered_text: 'No relevant memories found.',
      metadata: {
        ...baseMetadata,
        cues: [{ text: 'why did we pick webhooks', source: 'raw_query', weight: 3 }],
        degraded: [{ stage: 'cues', reason: 'timeout' }],
      },
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('parses a pack naming two rungs at once, which is what a full Ollama outage is', () => {
    const pack = {
      rendered_text: 'No relevant memories found.',
      metadata: {
        ...baseMetadata,
        cues: [{ text: 'why did we pick webhooks', source: 'raw_query', weight: 3 }],
        degraded: [
          { stage: 'cues', reason: 'model_error' },
          { stage: 'embed', reason: 'model_error' },
        ],
      },
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('parses the graph rung, which is an outage rather than an empty substrate', () => {
    const pack = {
      rendered_text: 'No relevant memories found.',
      metadata: { ...baseMetadata, degraded: [{ stage: 'graph', reason: 'unavailable' }] },
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('rejects an empty degraded list: present means at least one rung fired', () => {
    const pack = {
      rendered_text: 'No relevant memories found.',
      metadata: { ...baseMetadata, degraded: [] },
    };
    expect(() => MemoryPackSchema.parse(pack)).toThrow();
  });

  it('parses pending_enrichment alongside the calling session\'s unenriched count', () => {
    const pack = {
      rendered_text: 'No relevant memories found.',
      metadata: { ...baseMetadata, pending_enrichment: 3 },
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('rejects pending_enrichment: 0 — a healthy pack omits it rather than stating zero', () => {
    const pack = {
      rendered_text: 'No relevant memories found.',
      metadata: { ...baseMetadata, pending_enrichment: 0 },
    };
    expect(() => MemoryPackSchema.parse(pack)).toThrow();
  });

  it('parses a pack with a direct-hit item and no path in its rationale', () => {
    const pack = {
      episodes: [
        {
          id: 'episode-1',
          content: 'decided to key the sync on id_slug',
          rank: 1,
          confidence: 0.82,
          rationale: { method: 'vector', score: 0.82 },
          currency: 'current',
        },
      ],
      rendered_text: 'episode-1: decided to key the sync on id_slug',
      metadata: baseMetadata,
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('parses an item reachable only by traversal, carrying a path and occurred_at', () => {
    const pack = {
      facts: [
        {
          id: 'fact-1',
          content: 'Alice works on the API',
          rank: 1,
          confidence: 0,
          occurred_at: '2026-02-14T09:00:00Z',
          rationale: { method: 'graph_traversal', score: 0.41, path: 'Episode-[MENTIONS]->Entity' },
          currency: 'current',
        },
      ],
      rendered_text: 'fact-1: Alice works on the API',
      metadata: baseMetadata,
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('parses a superseded item marked with its lineage', () => {
    const pack = {
      facts: [
        {
          id: 'fact-2',
          content: 'the API redesign targets Q3',
          rank: 2,
          confidence: 0.55,
          rationale: { method: 'bm25', score: 0.55 },
          currency: 'superseded',
          superseded_by: { id: 'fact-9', at: '2026-03-01T00:00:00Z' },
        },
      ],
      rendered_text: 'fact-2 (superseded): the API redesign targets Q3',
      metadata: baseMetadata,
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('parses every bucket populated at once', () => {
    const item = (id: string) => ({
      rank: 1,
      confidence: 0.3,
      id,
      content: id,
      rationale: { method: 'resonance', score: 0.3 },
      currency: 'current',
    });
    const pack = {
      facts: [item('f1')],
      episodes: [item('e1')],
      narratives: [item('n1')],
      preferences: [item('p1')],
      resonant: [item('r1')],
      rendered_text: 'five buckets',
      metadata: baseMetadata,
    };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });
});

describe('MemoryPackSchema invalid shapes', () => {
  it('rejects an empty-array bucket: omission is the only way to say "nothing here"', () => {
    const result = MemoryPackSchema.safeParse({
      facts: [],
      rendered_text: '',
      metadata: baseMetadata,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a pack missing metadata', () => {
    const result = MemoryPackSchema.safeParse({ rendered_text: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects a pack missing rendered_text', () => {
    const result = MemoryPackSchema.safeParse({ metadata: baseMetadata });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown currency value', () => {
    const result = MemoryPackItemSchema.safeParse({
      id: 'x',
      content: 'x',
      rank: 1,
      confidence: 1,
      rationale: { method: 'vector', score: 1 },
      currency: 'stale',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rationale missing method', () => {
    const result = RationaleSchema.safeParse({ score: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a rationale with an unrecognized method', () => {
    const result = RationaleSchema.safeParse({ method: 'guessing', score: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a cue weight outside the pinned 3x/2x/1x set', () => {
    const result = CueSchema.safeParse({ text: 'x', source: 'query', weight: 4 });
    expect(result.success).toBe(false);
  });
});
