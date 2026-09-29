import { expect, it } from 'vitest';

import { adviseTier3 } from './tier3-advisor.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

for (const lesson of [undefined, null, 12]) {
  it(`does not let an optional malformed lesson veto valid advice: ${String(lesson)}`, async () => {
    const outcome = await adviseTier3(
      {
        generate: async () => ({
          operation: 'memory_decay',
          confidence: 0.9,
          rationale: 'A decay pass is due.',
          ...(lesson === undefined ? {} : { lesson }),
        }),
      },
      {
        health: healthFixture(),
        candidates: [{ name: 'memory_decay', relevance: 0.5 }],
        reason: 'idle',
      },
      { model: 'claude-haiku-4-5', timeoutMs: 1000 },
    );
    console.log(JSON.stringify({ case: 'lesson-poisons-advice', lesson, outcome }));
    expect(outcome.status).toBe('advised');
  });
}
