import { expect, it } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { rollUpOverviews } from './overview-rollup.js';
import { acceptSource, chunks, NOW, sealFor, store } from './test-support/t10b-review.fixture.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  OVERVIEW_REVISION_FAMILY,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';

it('does not revive an abandoned overview allocation after a newer actor has published', async () => {
  const source = await acceptSource('overview-two-actors', 'a complete member');
  store.db
    .prepare('UPDATE source_records SET occurred_at = ? WHERE source_id = ?')
    .run('2026-08-10T12:00:00.000Z', source);
  const chunk = await sealFor(source);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  let enter!: () => void;
  let release!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const firstHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  let drafts = 0;
  const provider: Provider = {
    embed: async () => {
      throw new Error('no embedding');
    },
    generate: async (request) => {
      const text = request.messages.map((message) => message.content).join('\n');
      if (text.includes('You review a draft memory')) {
        return { unsupported: false, reason: 'scripted supported output' };
      }
      drafts += 1;
      if (drafts === 1) {
        enter();
        await firstHeld;
      }
      return { sentences: [{ text: 'a grounded overview', source_ids: ['S1'] }] };
    },
  };
  const opts = { scope: 'day' as const, now: NOW, windowLimit: 1, renderedInputAllowance: 32768 };
  const deps = { ...chunks, provider };
  const first = rollUpOverviews(deps, opts).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await firstEntered;
  try {
    const second = await rollUpOverviews(deps, opts);
    expect(second.published).toBe(1);
    expect(
      readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-10')?.revisionNo,
    ).toBe(2);
  } finally {
    release();
  }
  expect.soft(await first).not.toHaveProperty('error');
  expect.soft(chunks.publications.hasPending()).toBe(false);
  const recovered = await chunks.publications.recover().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  expect.soft(recovered).not.toHaveProperty('error');
  expect
    .soft(readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-10')?.revisionNo)
    .toBe(2);
});
