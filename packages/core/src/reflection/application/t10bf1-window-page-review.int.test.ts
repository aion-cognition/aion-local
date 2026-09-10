import { expect, it } from 'vitest';

import { rollUpNarratives } from './narrative-rollup.js';
import { driver, NOW, store } from './test-support/t10b-review.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';

it('reaches a fitting later window beyond a full page of blocked earlier members', async () => {
  const day = 86400000;
  for (const [id, text, ago] of [
    ['blocked-page-one', 'long '.repeat(300), 4],
    ['blocked-page-two', 'long '.repeat(300), 3],
    ['fitting-page-three', 'fits', 2],
  ] as const) {
    const at = new Date(NOW.getTime() - ago * day);
    await writeStampedNode(driver, {
      label: 'Narrative',
      id,
      now: at,
      occurredAt: at,
      properties: {
        text,
        summary: text,
        scope: 'session',
        version: 1,
        coverage_count: 1,
        coverage_key: id,
        grounding: 'grounded-1',
      },
    });
  }
  let calls = 0;
  const provider: Provider = {
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    generate: async (request) => {
      calls += 1;
      const prompt = request.messages.map((message) => message.content).join('\n');
      if (prompt.includes('You review a draft memory')) {
        return { unsupported: false, reason: 'scripted supported control' };
      }
      const handles = [...prompt.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]);
      return { sentences: [{ text: 'the fitting window was recorded', source_ids: handles }] };
    },
  };
  const deps = {
    driver,
    db: store.db,
    provider,
    logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
  };
  for (let round = 0; round < 4; round += 1) {
    await rollUpNarratives(deps, {
      scope: 'day',
      now: NOW,
      windowLimit: 2,
      memberLimit: 2,
      renderedInputAllowance: 120,
    });
  }
  expect.soft(calls).toBeGreaterThan(0);
  // At the failing head, prove the third window can render and publish once it is reached.
  if (calls === 0) {
    const control = await rollUpNarratives(deps, {
      scope: 'day',
      now: NOW,
      windowLimit: 2,
      memberLimit: 4,
      renderedInputAllowance: 120,
    });
    expect(control.created).toBe(1);
    expect(calls).toBeGreaterThan(0);
  }
});
