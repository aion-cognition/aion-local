import { describe, expect, it } from 'vitest';

import {
  assembleChunkedNarrative,
  narrativeChunks,
  renderChunkSource,
  type NarrativeChunkResult,
} from './narrative-chunks.js';
import type { NarrativeEpisode } from './narrative.js';

const SENTENCES = 12;

function session(count: number): NarrativeEpisode[] {
  return Array.from({ length: count }, (_, slot) => ({
    id: `e${String(slot + 1)}`,
    text: `body of e${String(slot + 1)}`,
  }));
}

function sizes(chunks: readonly (readonly NarrativeEpisode[])[]): number[] {
  return chunks.map((run) => run.length);
}

function order(chunks: readonly (readonly NarrativeEpisode[])[]): string[] {
  return chunks.flatMap((run) => run.map((episode) => episode.id));
}

/** Long enough that the sentence budget is what the chunk count allows, not the character count. */
function chunk(citations: readonly string[]): NarrativeChunkResult {
  return { text: `${citations.join(' and ')} ${'a'.repeat(200)}`, citations };
}

describe('splitting a session', () => {
  it('leaves a session inside the window whole', () => {
    expect(sizes(narrativeChunks(session(3), 40))).toEqual([3]);
    expect(sizes(narrativeChunks(session(40), 40))).toEqual([40]);
  });

  it('splits a longer session into consecutive runs inside the cap', () => {
    const chunks = narrativeChunks(session(90), 40);

    expect(sizes(chunks)).toEqual([30, 30, 30]);
    expect(order(chunks)).toEqual(session(90).map((episode) => episode.id));
  });

  it('spreads an uneven session rather than leaving a thin tail', () => {
    expect(sizes(narrativeChunks(session(41), 40))).toEqual([21, 20]);
    expect(sizes(narrativeChunks(session(100), 40))).toEqual([34, 33, 33]);
  });

  it('draws the same boundaries every time it reads the same session and cap', () => {
    expect(sizes(narrativeChunks(session(90), 40))).toEqual(
      sizes(narrativeChunks(session(90), 40)),
    );
    expect(sizes(narrativeChunks(session(90), 20))).toEqual([18, 18, 18, 18, 18]);
  });

  it('cannot split on a cap below one', () => {
    expect(sizes(narrativeChunks(session(5), 0))).toEqual([5]);
  });
});

describe('the source the final pass reads', () => {
  it('renders one tagged item per chunk, in session order', () => {
    const source = renderChunkSource([chunk(['e1']), chunk(['e2'])], 90, SENTENCES);

    expect(source.items.map((item) => [item.handle, item.kind])).toEqual([
      ['S1', 'passage'],
      ['S2', 'passage'],
    ]);
    expect(source.text).toContain('[S1] passage\ne1 ');
    expect(source.text).toContain('[S2] passage\ne2 ');
  });

  it('records the whole session as read, because every episode reached a chunk', () => {
    const source = renderChunkSource([chunk(['e1']), chunk(['e2'])], 90, SENTENCES);

    expect(source.renderedCount).toBe(90);
    expect(source.coverage).toBe(1);
    expect(source.sentenceBudget).toBe(2);
  });
});

describe('folding the chunks back together', () => {
  const chunks = [chunk(['e1', 'd1']), chunk(['e2'])];
  const source = renderChunkSource(chunks, 90, SENTENCES);

  it('cites the ids behind the chunk the answer cited, and no others', () => {
    const grounded = assembleChunkedNarrative(
      { sentences: [{ text: 'The session closed the migration out.', source_ids: ['S2'] }] },
      source,
      chunks,
    );

    expect(grounded.kept).toBe(1);
    expect(grounded.citations).toEqual(['e2']);
  });

  it('unions the ids when the answer drew on more than one chunk', () => {
    const grounded = assembleChunkedNarrative(
      {
        sentences: [
          { text: 'The session opened on the audit.', source_ids: ['S1'] },
          { text: 'It closed on the cutover.', source_ids: ['S2', 'S1'] },
        ],
      },
      source,
      chunks,
    );

    expect(grounded.narrative).toBe('The session opened on the audit. It closed on the cutover.');
    expect(grounded.citations).toEqual(['e1', 'd1', 'e2']);
  });

  it('drops a sentence citing a tag no chunk answers to', () => {
    const grounded = assembleChunkedNarrative(
      {
        sentences: [
          { text: 'A service mesh was adopted.', source_ids: ['S9'] },
          { text: 'The session opened on the audit.', source_ids: ['S1'] },
        ],
      },
      source,
      chunks,
    );

    expect(grounded.kept).toBe(1);
    expect(grounded.dropped).toBe(1);
    expect(grounded.citations).toEqual(['e1', 'd1']);
  });
});
