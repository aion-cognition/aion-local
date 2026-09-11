import { afterEach, expect, it, vi } from 'vitest';

import { legacyNarrativePublication } from './legacy-narrative-publication.js';
import { sweepIdleSessions } from './narratives.js';
import {
  deps,
  NOW,
  SESSION_ID,
  OTHER_SESSION_ID,
  seedEpisode,
} from './test-support/legacy-regression.fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});
it('reports a deferred legacy publication and still narrates the next idle session', async () => {
  await seedEpisode('first-source', '2026-04-02T10:00:00Z', SESSION_ID);
  await seedEpisode('second-source', '2026-04-02T10:05:00Z', OTHER_SESSION_ID);
  const original = legacyNarrativePublication.check.bind(legacyNarrativePublication);
  vi.spyOn(legacyNarrativePublication, 'check').mockImplementation(async (context, plan) => {
    if ((plan.data as { sessionId: string }).sessionId === SESSION_ID) {
      return { status: 'deferred', reason: 'legacy_family_revision_changed' };
    }
    return original(context, plan);
  });
  const results = await sweepIdleSessions(deps, { now: NOW, limit: 10 });
  expect(results.find((result) => result.sessionId === SESSION_ID)).toMatchObject({
    status: 'failed',
    summary: expect.stringContaining('legacy_family_revision_changed'),
  });
  expect(results.find((result) => result.sessionId === OTHER_SESSION_ID)?.status).toBe('created');
});
