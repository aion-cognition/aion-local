import { describe, expect, it } from 'vitest';

import {
  chunkMemberUnits,
  joinedUnits,
  renderSealedChunk,
  selectSubmittedRanges,
  type ChunkEnrichmentNode,
  type ChunkMemberText,
} from './chunk-render.js';
import { renderNarrativeSource, type NarrativeEpisode } from './narrative.js';

const OCCURRED = new Date('2026-09-09T11:00:00.000Z');

function member(sourceId: string, text: string): ChunkMemberText {
  return { sourceId, occurredAt: OCCURRED, text, parts: [{ address: sourceId, text }] };
}

function enrichment(id: string, sourceId: string, text: string): ChunkEnrichmentNode {
  return { id, kind: 'decision', text, sourceId };
}

const HUGE = 1_000_000;

describe('the chunk renderer', () => {
  /**
   * The whole reason the chunk path has a renderer of its own. `renderNarrativeSource` prefers a
   * summary and clips to the per-episode cap, so a misleading one-line summary is what the model
   * reads and the raw sentence that matters never arrives.
   */
  it('submits the raw text where the legacy renderer would have submitted a summary', () => {
    const raw = `${'filler. '.repeat(300)}the sync keyed on id_slug, not on npi`;
    const legacy: NarrativeEpisode = { id: 's1', text: raw, summary: 'we talked about billing' };
    const old = renderNarrativeSource([legacy], [], 40, 2_000);
    expect(old.text).toContain('we talked about billing');
    expect(old.text).not.toContain('id_slug');

    const chunk = renderSealedChunk({
      members: [member('s1', raw)],
      enrichment: [],
      allowance: HUGE,
    });
    expect(chunk.source.text).toContain('id_slug, not on npi');
    expect(chunk.source.text).not.toContain('we talked about billing');
    expect(chunk.complete).toBe(true);
  });

  it('renders whole a member between the old per-member clip and the chunk allowance', () => {
    const body = 'b'.repeat(6_000);
    const clipped = renderNarrativeSource([{ id: 's1', text: body }], [], 40, 2_000);
    expect(clipped.text).toContain('…');

    const chunk = renderSealedChunk({
      members: [member('s1', body)],
      enrichment: [],
      allowance: HUGE,
    });
    expect(chunk.source.text).toContain(body);
    expect(chunk.source.text).not.toContain('…');
    expect(chunk.complete).toBe(true);
    expect(chunk.source.coverage).toBe(1);
  });

  it('reports coverage 1.0 and no submitted ranges for a complete input', () => {
    const chunk = renderSealedChunk({
      members: [member('s1', 'one'), member('s2', 'two')],
      enrichment: [],
      allowance: HUGE,
    });
    expect(chunk.source.coverage).toBe(1);
    expect(chunk.submitted).toEqual([]);
    expect(chunk.source.items.map((item) => item.id)).toEqual(['s1', 's2']);
  });

  it('spends the allowance on members first and enrichment only from what is left', () => {
    const body = 'm'.repeat(400);
    const members = [member('s1', body)];
    const floor = joinedUnits([chunkMemberUnits(0, member('s1', body))]);
    const node = enrichment('n1', 's1', 'e'.repeat(100));

    const tight = renderSealedChunk({ members, enrichment: [node], allowance: floor + 10 });
    expect(tight.enrichmentCount).toBe(0);
    expect(tight.source.text).toContain(body);

    const roomy = renderSealedChunk({ members, enrichment: [node], allowance: HUGE });
    expect(roomy.enrichmentCount).toBe(1);
    expect(roomy.renderedUnits).toBeLessThanOrEqual(HUGE);
  });

  it('drops an enrichment node supported only by a member this render does not carry', () => {
    const rendered = renderSealedChunk({
      members: [member('s1', 'kept')],
      enrichment: [enrichment('n1', 's2', 'the forgotten member said this')],
      allowance: HUGE,
    });
    expect(rendered.enrichmentCount).toBe(0);
    expect(rendered.source.text).not.toContain('the forgotten member said this');
  });

  describe('a member no allowance carries whole', () => {
    const parts: ChunkMemberText = {
      sourceId: 's1',
      occurredAt: OCCURRED,
      text: `${'a'.repeat(100)}\n${'b'.repeat(100)}\n${'c'.repeat(100)}`,
      parts: [
        { address: 'part:s1:turn:0', text: 'a'.repeat(100) },
        { address: 'part:s1:turn:1', text: 'b'.repeat(100) },
        { address: 'part:s1:turn:2', text: 'c'.repeat(100) },
      ],
    };

    it('selects whole parts in their recorded order, then a prefix of the first that does not fit', () => {
      expect(selectSubmittedRanges(parts, 250)).toEqual([
        { address: 'part:s1:turn:0', start: 0, end: 100 },
        { address: 'part:s1:turn:1', start: 0, end: 100 },
        { address: 'part:s1:turn:2', start: 0, end: 49 },
      ]);
    });

    it('records exactly what was submitted and reports the render incomplete', () => {
      const allowance = chunkMemberUnits(0, { ...parts, text: '' }) + 150;
      const rendered = renderSealedChunk({
        members: [parts],
        enrichment: [],
        allowance,
        boundedPartialOf: 's1',
      });
      expect(rendered.complete).toBe(false);
      expect(rendered.submitted.length).toBeGreaterThan(0);
      const submitted = rendered.submitted.reduce(
        (sum, range) => sum + (range.end - range.start),
        0,
      );
      expect(submitted).toBeLessThan(parts.text.length);
      expect(rendered.source.coverage).toBeLessThan(1);
      // Every unit named by a range is in the rendered input, and nothing outside them is.
      expect(rendered.source.text).toContain('a'.repeat(100));
      expect(rendered.source.text).not.toContain('c'.repeat(1));
    });

    it('names a source with no recorded parts at its own address', () => {
      const whole: ChunkMemberText = {
        sourceId: 's9',
        text: 'z'.repeat(50),
        parts: [],
      };
      expect(selectSubmittedRanges(whole, 20)).toEqual([{ address: 's9', start: 0, end: 20 }]);
    });
  });
});
