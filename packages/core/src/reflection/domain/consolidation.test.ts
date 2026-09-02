import { describe, expect, it } from 'vitest';

import {
  assembleConsolidation,
  buildConsolidationReviewMessages,
  buildRollupMessages,
  buildSubjectMessages,
  consolidationNodeId,
  derivedDensityFloor,
  readConsolidationReview,
  renderConsolidationSource,
  rollupNodeId,
  type ConsolidationMember,
} from './consolidation.js';

const MEMBERS: readonly ConsolidationMember[] = [
  {
    id: 'narrative-morning',
    kind: 'narrative',
    text:
      'The morning session staged the Ariadne rollout behind a flag and defaulted it off. ' +
      'The flag name was settled as AION_ARIADNE and written into the staging configuration.',
    occurredAt: new Date('2026-04-02T09:00:00.000Z'),
  },
  {
    id: 'narrative-evening',
    kind: 'narrative',
    text:
      'The evening session ran the migration and held the launch until the backfill finished. ' +
      'Every constraint came back green and the backfill had about a day of work left on it.',
    occurredAt: new Date('2026-04-02T18:00:00.000Z'),
  },
];

describe('renderConsolidationSource', () => {
  it('tags every member and renders its header apart from its content', () => {
    const source = renderConsolidationSource(MEMBERS, 2_000);

    expect(source.items.map((item) => item.handle)).toEqual(['S1', 'S2']);
    expect(source.items.map((item) => item.id)).toEqual(['narrative-morning', 'narrative-evening']);
    expect(source.text).toContain('[S1] narrative 2026-04-02T09:00:00.000Z\nThe morning session');
    expect(source.renderedCount).toBe(2);
    expect(source.coverage).toBe(1);
  });

  it('clips a member past the character bound rather than dropping it', () => {
    const long: ConsolidationMember = { id: 'long', kind: 'insight', text: 'x'.repeat(50) };
    const source = renderConsolidationSource([long], 10);

    expect(source.items[0]?.text).toBe(`${'x'.repeat(10)}…`);
    expect(source.renderedCount).toBe(1);
  });
});

describe('assembleConsolidation', () => {
  const source = renderConsolidationSource(MEMBERS, 2_000);

  it('keeps each sentence with the members that sentence cited', () => {
    const grounded = assembleConsolidation(
      {
        sentences: [
          { text: 'The rollout was staged behind a flag.', source_ids: ['S1'] },
          { text: 'The launch waited on the backfill.', source_ids: ['S2'] },
        ],
      },
      source,
    );

    expect(grounded.sentences.map((sentence) => sentence.citations)).toEqual([
      ['narrative-morning'],
      ['narrative-evening'],
    ]);
    expect(grounded.citations).toEqual(['narrative-morning', 'narrative-evening']);
    expect(grounded.summary).toBe('The rollout was staged behind a flag.');
    expect(grounded.kept).toBe(2);
    expect(grounded.dropped).toBe(0);
  });

  it('drops a sentence citing nothing the prompt offered', () => {
    const grounded = assembleConsolidation(
      {
        sentences: [
          { text: 'The team was pleased with the result.', source_ids: ['S9'] },
          { text: 'The migration ran.', source_ids: ['s2'] },
        ],
      },
      source,
    );

    expect(grounded.sentences.map((sentence) => sentence.text)).toEqual(['The migration ran.']);
    expect(grounded.dropped).toBe(1);
  });
});

describe('buildConsolidationReviewMessages', () => {
  it('shows the reviewer each drafted sentence beside the tags it cites', () => {
    const source = renderConsolidationSource(MEMBERS, 2_000);
    const draft = assembleConsolidation(
      { sentences: [{ text: 'The launch waited on the backfill.', source_ids: ['S2'] }] },
      source,
    );

    const messages = buildConsolidationReviewMessages(source, draft);

    expect(messages[1]?.content).toContain('1. The launch waited on the backfill.\n   cites: S2');
  });
});

describe('readConsolidationReview', () => {
  it('reads an answer that found nothing unsupported as unanimous', () => {
    expect(readConsolidationReview({ unsupported: false, reason: '' })).toEqual({
      outcome: 'unanimous',
    });
  });

  it('carries the reviewerreason onto a veto', () => {
    expect(
      readConsolidationReview({ unsupported: true, reason: 'sentence 2 invents a deadline' }),
    ).toEqual({ outcome: 'vetoed', reason: 'sentence 2 invents a deadline' });
  });

  it('refuses an answer the schema cannot read', () => {
    expect(readConsolidationReview({ verdict: 'fine' })).toBeUndefined();
  });
});

describe('derivedDensityFloor', () => {
  it('has no floor to derive from an empty distribution', () => {
    expect(derivedDensityFloor([])).toBeUndefined();
  });

  it('takes the upper quartile of the sizes the substrate actually holds', () => {
    expect(derivedDensityFloor([2, 3, 4, 30])).toBe(4);
    expect(derivedDensityFloor([2, 2, 2, 2, 3, 4, 9, 12])).toBe(4);
  });

  it('never falls below the two members compression needs', () => {
    expect(derivedDensityFloor([1, 1, 1])).toBe(2);
  });
});

describe('derived ids', () => {
  it('gives one window and member set one rollup id', () => {
    expect(rollupNodeId('day', '2026-04-02', 'key')).toBe(rollupNodeId('day', '2026-04-02', 'key'));
    expect(rollupNodeId('day', '2026-04-02', 'key')).not.toBe(
      rollupNodeId('week', '2026-04-02', 'key'),
    );
  });

  it('gives one member set one consolidation id', () => {
    expect(consolidationNodeId('key')).toBe(consolidationNodeId('key'));
    expect(consolidationNodeId('key')).not.toBe(consolidationNodeId('other'));
  });
});

describe('synthesis prompts', () => {
  it('names the day and the week apart, and the subject axis apart from both', () => {
    const source = renderConsolidationSource(MEMBERS, 2_000);

    expect(buildRollupMessages(source, 'day')[0]?.content).toContain(
      "one day's session narratives",
    );
    expect(buildRollupMessages(source, 'week')[0]?.content).toContain(
      "one week's daily narratives",
    );
    expect(buildSubjectMessages(source)[0]?.content).toContain(
      'several standing claims about one subject',
    );
  });
});
