import { afterEach, expect, it, vi } from 'vitest';

import { freezeLegacyCohort, runLegacyBackfillBatch } from './legacy-backfill.js';
import * as compression from './narrative-compress.js';
import { closeSessionNarrative } from './narratives.js';
import {
  chunks,
  driver,
  acceptSource,
  store,
  sessionOf,
  NOW,
  publications,
} from './test-support/t10b-review.fixture.js';
import { seedLegacyFamilyVersion } from '../../infrastructure/graph/test-support/family-cutover.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { scopeSupportsVerifiedEmpty } from '../../infrastructure/sqlite/evidence-scope.js';

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

it('establishes the source coverage scope authored by the legacy writer through the existing census', async () => {
  const id = await acceptSource('coverage-census', 'source whose coverage is authored now', false);
  await seedLegacyFamilyVersion(driver, {
    nodeId: 'coverage-old-head',
    sessionId: sessionOf(id),
    sources: [],
    now: NOW,
  });
  const frozen = await freezeLegacyCohort(chunks, { cohortId: 'coverage-census', now: NOW });
  const walked = await runLegacyBackfillBatch(chunks, {
    cohortId: 'coverage-census',
    now: NOW,
    limit: frozen.members,
  });
  expect(walked.pinned, JSON.stringify(walked)).toBe(0);
  mockCompression();
  expect(
    (await closeSessionNarrative({ ...chunks, logger }, sessionOf(id), { now: NOW })).status,
  ).toBe('created');
  const scope = { endpointId: id, relationClass: 'sqlite:source_coverage:out' };
  expect(compression.compress).toHaveBeenCalledOnce();
  expect(
    store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM evidence_links WHERE from_id = ? AND record_source = 'legacy_narrative'",
      )
      .get(id),
  ).toEqual({ n: 1 });
  expect(scopeSupportsVerifiedEmpty(store.db, scope)).toBe(false);
  let after = '';
  for (let page = 0; page < 20; page += 1) {
    const out = await publications.publish({
      kind: 'legacy_materialization',
      operationId: `legacy-census-fence:${page}`,
      payload: {
        mode: 'census',
        cohortId: 'coverage-census',
        endpointLimit: 4,
        relationLimit: 500,
        after,
      },
    });
    expect(out.status, JSON.stringify(out)).toBe('acknowledged');
    if (out.status !== 'acknowledged') {
      throw new Error('census not acknowledged');
    }
    const next = (out.result as { cursor: string }).cursor;
    if (next === after) {
      break;
    }
    after = next;
  }
  expect(scopeSupportsVerifiedEmpty(store.db, scope)).toBe(true);
});
