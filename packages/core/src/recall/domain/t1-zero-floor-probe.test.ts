import { expect, it } from 'vitest';

import { matchIntentionTriggers, triggeredIntentionItem } from './intention-triggers.js';
import { assemble } from './test-support/pack.fixture.js';

it('renders an admitted zero-cosine situation trigger as a measurement, not a literal match', () => {
  const candidate = {
    id: 'orthogonal-intention',
    labels: ['Goal', 'Memory', 'AionNode'],
    content: 'Review the pending work',
    currency: 'current' as const,
  };
  const intentions = [{ id: candidate.id, triggerVector: [0, 1] }];
  const context = {
    activatedIds: new Set<string>(),
    centroid: [1, 0],
    now: new Date('2026-09-08T00:00:00.000Z'),
    situationFloor: 0,
    limit: 3,
  };

  const matches = matchIntentionTriggers(intentions, context);
  expect(matches).toEqual([{ id: candidate.id, kind: 'situation', score: 0 }]);
  expect(matchIntentionTriggers(intentions, { ...context, situationFloor: 0.5 })).toEqual([]);

  const match = matches[0];
  if (match === undefined) {
    throw new Error('Expected the zero-floor situation trigger to be admitted');
  }
  const fused = triggeredIntentionItem(candidate, match);
  expect(fused.admittedBy).toBeUndefined();
  expect(fused.measured).toBe(0);
  const pack = assemble([], { intentions: [fused] });
  expect(pack.intentions?.map((entry) => entry.id)).toEqual([candidate.id]);
  expect(pack.intentions?.[0]?.confidence).toBe(0);
  expect(pack.rendered_text).toContain('intention_trigger | confidence 0.00');
  expect(pack.rendered_text).not.toContain('exact match');
});
