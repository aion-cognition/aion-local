import { expect, it } from 'vitest';

import { ensureSessionFamily } from './narrative-family.js';
import { chunks, driver } from './test-support/t10b-review.fixture.js';
import { LegacyNarrativeGraph } from '../../infrastructure/graph/test-support/legacy-narrative-regression.fixture.js';

it('reconsiders a refused initialization when its session becomes available', async () => {
  const sessionId = 'session-initialization-retry';
  expect(await ensureSessionFamily(chunks, sessionId)).toMatchObject({
    status: 'deferred',
    reason: 'session_missing',
  });
  await new LegacyNarrativeGraph(driver).seedNode(sessionId, ['Session', 'AionNode']);
  expect(await ensureSessionFamily(chunks, sessionId)).toMatchObject({
    status: 'ready',
    reading: { selection: { family: 'chunk' } },
  });
});
