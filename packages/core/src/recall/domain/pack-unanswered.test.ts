import { describe, expect, it } from 'vitest';

import type { AdmissionReport } from './admission.js';
import type { FusedItem } from './fusion.js';
import { triggeredIntentionItem } from './intention-triggers.js';
import { STANDING_LEGEND } from './pack-item.js';
import { assemble, item, report } from './test-support/pack.fixture.js';

/**
 * A resonant discovery or a triggered intention reaches the pack without matching the query. A
 * pack holding only those has not answered it, and the text an agent reads says so above them;
 * otherwise the agent takes an association for the answer.
 */

const NOTHING_MATCHED = 'No memories matched this query.';
const ANOTHER_WAY = 'What follows reached the pack another way, and each item names how.';

/** The floor refused every candidate fusion put in front of it. */
const REFUSED: AdmissionReport = { ...report([]), considered: 12, droppedBelowFloor: 12 };

function resonant(id: string, content = `content of ${id}`): FusedItem {
  return item(id, { path: 'related by shape, not keywords', content });
}

describe('a pack holding only what reached it another way', () => {
  it('says nothing matched, and why, above a resonant bucket', () => {
    const pack = assemble([], { admission: REFUSED, resonant: [resonant('r1')] });
    const text = pack.rendered_text;

    expect(pack.resonant).toHaveLength(1);
    expect(text).toContain(
      `${NOTHING_MATCHED} Of 12 candidates: 12 measured under the 0.60 floor. ${ANOTHER_WAY}`,
    );
    expect(text.indexOf(NOTHING_MATCHED)).toBeLessThan(text.indexOf(STANDING_LEGEND));
    expect(text.indexOf(STANDING_LEGEND)).toBeLessThan(text.indexOf('## Resonant'));
  });

  it('says the same above a triggered intention', () => {
    const goal = triggeredIntentionItem(
      { id: 'g1', labels: ['Goal', 'Memory', 'AionNode'], content: 'ship it', currency: 'current' },
      { id: 'g1', kind: 'temporal', score: 1 },
    );
    const pack = assemble([], { admission: REFUSED, intentions: [goal] });

    expect(pack.intentions).toHaveLength(1);
    expect(pack.rendered_text).toContain(ANOTHER_WAY);
  });

  it('keeps the reason the matches are absent when the session already holds them', () => {
    const pack = assemble([item('e1')], {
      suppressed: new Set(['e1']),
      resonant: [resonant('r1')],
    });

    expect(pack.rendered_text).toContain(
      `This session already holds every memory this query matched. ${ANOTHER_WAY}`,
    );
  });

  it('prints no such line once the query matched something', () => {
    const pack = assemble([item('e1')], { resonant: [resonant('r1')] });

    expect(pack.resonant).toHaveLength(1);
    expect(pack.rendered_text).not.toContain(NOTHING_MATCHED);
    expect(pack.rendered_text).not.toContain(ANOTHER_WAY);
  });

  // A superseded answer is placed after every association, and the first association was charged
  // the line. The answer takes that charge back, or the pack loses it to a line it never prints.
  it('gives the line back when an answer lands after an association', () => {
    const stale = item('stale', { superseded: true, content: 'old account' });
    const unbounded = assemble([stale], { resonant: [resonant('r1')] });
    const pack = assemble([stale], {
      resonant: [resonant('r1')],
      tokenBudget: unbounded.metadata.token_estimate,
    });

    expect(pack.episodes).toHaveLength(1);
    expect(pack.resonant).toHaveLength(1);
    expect(pack.rendered_text).not.toContain(ANOTHER_WAY);
  });

  // The line is text the agent pays for, so it is charged like the heading of the bucket it sits
  // over. Uncharged, a budget that just fits the resonant items is overrun by the line.
  it('stays inside every budget it is handed', () => {
    const found = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) =>
      resonant(id, `${id} shares a crew with the anchor `.repeat(3)),
    );

    for (let budget = 60; budget <= 600; budget += 1) {
      const pack = assemble([], { admission: REFUSED, resonant: found, tokenBudget: budget });
      if (pack.resonant === undefined) {
        continue;
      }
      expect(pack.metadata.token_estimate, `budget ${String(budget)}`).toBeLessThanOrEqual(budget);
    }
  });
});
