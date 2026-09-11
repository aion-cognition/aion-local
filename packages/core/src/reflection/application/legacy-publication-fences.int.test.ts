import { afterEach, expect, it, vi } from 'vitest';

import { legacyNarrativePublication } from './legacy-narrative-publication.js';
import * as compression from './narrative-compress.js';
import { closeSessionNarrative } from './narratives.js';
import {
  chunks,
  acceptSource,
  store,
  driver,
  sessionOf,
  NOW,
  publications,
} from './test-support/t10b-review.fixture.js';
import {
  addLegacyCoverageDuringPrepare,
  seedLegacyFamilyVersion,
} from '../../infrastructure/graph/test-support/family-cutover.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';

const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });

function mockCompression(before?: () => void): void {
  vi.spyOn(compression, 'compress').mockImplementation(async (_deps, _settings, episodes) => {
    before?.();
    return {
      output: {
        summary: 'A bounded account.',
        narrative: 'A bounded account.',
        citations: episodes.map((row) => row.id),
        kept: 1,
        dropped: 0,
      },
      source: {
        text: '',
        items: [],
        renderedCount: episodes.length,
        coverage: 1,
        sentenceBudget: 1,
      },
    };
  });
}
afterEach(() => {
  vi.restoreAllMocks();
});

it('refuses output whose source verification was withdrawn during synthesis', async () => {
  const id = await acceptSource('verification-withdrawn', 'source before synthesis', false);
  await seedLegacyFamilyVersion(driver, {
    nodeId: 'verification-old-head',
    sessionId: sessionOf(id),
    sources: [],
    now: NOW,
  });
  mockCompression(() => {
    store.db
      .prepare(
        "UPDATE source_records SET verification_status = 'pinned', verification_reason = 'withdrawn during synthesis' WHERE source_id = ?",
      )
      .run(id);
  });
  const result = await closeSessionNarrative({ ...chunks, logger }, sessionOf(id), { now: NOW });
  expect(compression.compress).toHaveBeenCalledOnce();
  expect(result.status, JSON.stringify(result)).toBe('failed');
  expect(
    store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM evidence_links WHERE record_source = 'legacy_narrative' AND from_id = ?",
      )
      .get(id),
  ).toEqual({ n: 0 });
  expect(publications.hasPending()).toBe(false);
});

it('refuses when the closure set changes after intent planning and before its check', async () => {
  const id = await acceptSource('closure-changed', 'old source', false);
  const sessionId = sessionOf(id);
  await seedLegacyFamilyVersion(driver, {
    nodeId: 'old-closure-head',
    sessionId,
    sources: [id],
    now: NOW,
  });
  await acceptSource('closure-changed', 'new source', false);
  mockCompression();
  const original = legacyNarrativePublication.prepare.bind(legacyNarrativePublication);
  vi.spyOn(legacyNarrativePublication, 'prepare').mockImplementation(async (context, payload) => {
    const planned = await original(context, payload);
    await addLegacyCoverageDuringPrepare(context.graph, id, 'old-closure-head');
    return planned;
  });
  const result = await closeSessionNarrative({ ...chunks, logger }, sessionId, { now: NOW });
  expect(result.status, JSON.stringify(result)).toBe('failed');
  expect(result.summary).toContain('legacy_closure_changed');
  expect(publications.hasPending()).toBe(false);
});
