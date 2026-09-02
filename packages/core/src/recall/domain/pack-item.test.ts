import type { MemoryPackItem } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { FusedItem } from './fusion.js';
import { renderItem, toPackItem } from './pack-item.js';

const OCCURRED_AT = '2026-06-01T09:00:00.000Z';

function packItem(overrides: Partial<MemoryPackItem> = {}): MemoryPackItem {
  return {
    id: 'fact-1',
    content: 'the ingest queue holds 4.2 million rows',
    occurred_at: OCCURRED_AT,
    rank: 1,
    confidence: 0.61,
    rationale: { method: 'vector', score: 0.61 },
    currency: 'current',
    ...overrides,
  };
}

function fused(overrides: Partial<FusedItem> = {}): FusedItem {
  return {
    id: 'fact-1',
    labels: ['Concept', 'Memory', 'AionNode'],
    content: 'the ingest queue holds 4.2 million rows',
    rationale: { method: 'vector', score: 0.61 },
    relevance: 0.61,
    measured: 0.61,
    score: 0.02,
    currency: 'current',
    ...overrides,
  };
}

describe('the rendered provenance line', () => {
  /**
   * An aged-out reading has no lineage line to carry the news, so without a marker of its own
   * it prints exactly like a memory the substrate still stands behind.
   */
  it('marks an expired reading, which has no successor to name it', () => {
    const line = renderItem({ item: packItem({ currency: 'expired' }), gloss: false });

    expect(line).toContain('expired');
    expect(line).toContain(`occurred ${OCCURRED_AT}`);
    expect(line).not.toContain('superseded');
  });

  it('leaves a current item unmarked', () => {
    const line = renderItem({ item: packItem(), gloss: false });

    expect(line).not.toContain('expired');
  });

  /** A closed reading is superseded, and the lineage line is the stronger statement. */
  it('names the successor and nothing else on an item the substrate corrected', () => {
    const line = renderItem({
      item: packItem({
        currency: 'superseded',
        superseded_by: { id: 'fact-9', at: '2026-07-01T00:00:00.000Z' },
      }),
      gloss: false,
    });

    expect(line).toContain('superseded by fact-9 at 2026-07-01T00:00:00.000Z');
    expect(line).not.toContain('expired');
  });
});

describe('the wire item', () => {
  it('carries the expiry marker onto the wire', () => {
    expect(toPackItem(fused({ currency: 'expired' }), 1).currency).toBe('expired');
  });
});
