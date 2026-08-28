import { describe, expect, it } from 'vitest';
import { CueSchema, MemoryPackItemSchema, MemoryPackSchema, RationaleSchema } from './recall-output.js';

const baseMetadata = {
  token_estimate: 240,
  stage_timings_ms: { embed: 12, cues: 340, seeds: 55, activation: 80, fusion: 4 },
  cues: [{ text: 'webhooks', source: 'query', weight: 3 }],
};

describe('MemoryPackSchema valid fixtures', () => {
  it('parses an explicitly empty pack: no buckets, metadata and rendered_text still present', () => {
    const pack = { rendered_text: 'No relevant memories found.', metadata: baseMetadata };
    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('parses a pack with a direct-hit item and no path in its rationale', () => {
    const pack = {
      episodes: [
        {
          id: 'episode-1',
          content: 'decided to key the sync on id_slug',
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
