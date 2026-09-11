import { expect, it } from 'vitest';

import { rollUpNarratives } from './narrative-rollup.js';
import {
  driver,
  NOW,
  publications,
  seedSessionScopeNarrative,
  store,
} from './test-support/t10b-review.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';

it('does not turn a truncated windows suffix into a complete window on the next page', async () => {
  const at = new Date('2026-08-01T12:00:00.000Z');
  for (let index = 0; index < 3; index += 1) {
    await seedSessionScopeNarrative({
      id: `split-window:${String(index)}`,
      at,
      text: `member ${String(index)}`,
    });
  }
  const drafts: string[] = [];
  const provider: Provider = {
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    generate: async (request) => {
      const text = request.messages.map((message) => message.content).join('\n');
      if (text.includes('You review a draft memory')) {
        return { unsupported: false, reason: 'scripted supported account' };
      }
      drafts.push(text);
      return { sentences: [{ text: 'a complete window', source_ids: ['S1'] }] };
    },
  };
  const deps = {
    driver,
    db: store.db,
    provider,
    publications,
    logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
  };
  let published = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    published += (
      await rollUpNarratives(deps, {
        scope: 'day',
        now: NOW,
        windowLimit: 1,
        memberLimit: 2,
        renderedInputAllowance: 32768,
      })
    ).created;
  }
  expect.soft(published).toBe(0);
  expect.soft(drafts).toEqual([]);
  if (published === 0) {
    expect(
      (
        await rollUpNarratives(deps, {
          scope: 'day',
          now: NOW,
          windowLimit: 1,
          memberLimit: 4,
          renderedInputAllowance: 32768,
        })
      ).created,
    ).toBe(1);
  }
});
