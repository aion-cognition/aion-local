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

  it('drops a root that is the item itself, since a capture is its own source', () => {
    const item = toPackItem(fused({ id: 'ep-1' }), 1, {
      provenance: { roots: ['ep-1'], complete: true },
    });

    expect(item.derivation).toBeUndefined();
  });

  it('keeps a real ancestor and reports whether the chain was cut', () => {
    const item = toPackItem(fused({ id: 'claim-1' }), 1, {
      provenance: { roots: ['ep-1', 'ep-2'], complete: false },
    });

    expect(item.derivation).toEqual({ roots: ['ep-1', 'ep-2'], complete: false });
  });
});

describe('what kind of statement the line is', () => {
  it('reads a recorded utterance and its role without turning the role into a person', () => {
    const line = renderItem({
      item: toPackItem(fused({ id: 't1', labels: ['Turn', 'Memory', 'AionNode'] }), 1, {
        provenance: { roots: [], complete: true, recordedRole: 'user' },
      }),
      gloss: false,
    });

    expect(line).toContain('utterance, role user, authorship unknown');
    expect(line).not.toContain('confirmed by');
  });

  /**
   * The mark exists so a quotation is never read as a conclusion. An extracted claim is the
   * default and the wire item still names its kind, so the rendered line spends nothing on it.
   */
  it('leaves an extracted claim unmarked and still names its kind on the wire', () => {
    const item = toPackItem(fused(), 1);

    expect(item.standing?.kind).toBe('extracted_interpretation');
    expect(renderItem({ item, gloss: false })).not.toContain('utterance');
  });

  it('names a decision as one', () => {
    const line = renderItem({
      item: toPackItem(fused({ labels: ['Decision', 'Memory', 'AionNode'] }), 1),
      gloss: false,
    });

    expect(line).toContain('decision');
  });

  it('names the confirmer only against evidence, and cites the evidence', () => {
    const line = renderItem({
      item: toPackItem(fused(), 1, {
        provenance: {
          roots: [],
          complete: true,
          confirmation: {
            by: 'Ryan Huber',
            at: new Date('2026-09-01T10:00:00.000Z'),
            evidence: 'review thread 41',
          },
        },
      }),
      gloss: false,
    });

    expect(line).toContain(
      'confirmed by Ryan Huber at 2026-09-01T10:00:00.000Z, evidence: review thread 41',
    );
    expect(line).not.toContain('authorship unknown');
  });
});

describe('the source line', () => {
  it('says who else in the pack came from the same place', () => {
    const line = renderItem({
      item: toPackItem(fused({ id: 'claim-2' }), 2, {
        provenance: { roots: ['ep-1'], complete: true },
        sharedWith: ['claim-1'],
      }),
      gloss: false,
    });

    expect(line).toContain('shares this origin with claim-1: not independent corroboration');
  });

  it('marks a stated correction as stated and closed by nothing', () => {
    const line = renderItem({
      item: toPackItem(fused(), 1, {
        provenance: {
          roots: [],
          complete: true,
          claimedCorrection: { by: 'ep-9', at: new Date('2026-09-02T08:00:00.000Z') },
        },
      }),
      gloss: false,
    });

    expect(line).toContain(
      'correction stated by ep-9 at 2026-09-02T08:00:00.000Z, nothing has closed it',
    );
  });
});
