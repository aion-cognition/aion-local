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
import {
  acknowledgeFamilySelection,
  readFamilySelection,
} from '../../infrastructure/sqlite/family-selection.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';

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

/** A token advance that leaves the session on the legacy family, which is what an inventory does. */
function advanceLegacyFamilyToken(sessionId: string): void {
  const held = readFamilySelection(store.db, sessionId);
  const operationId = `token-advance-${sessionId}`;
  preparePublicationIntent(store.db, {
    operationId,
    kind: 'family_cutover',
    payloadDigest: 'digest',
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  store.db
    .transaction(() => {
      acknowledgeFamilySelection(store.db, {
        sessionId,
        expectedVersion: held?.version ?? 0,
        family: 'legacy_session_overview',
        operationId,
      });
    })
    .immediate();
  acknowledgePublicationIntent(store.db, {
    operationId,
    resultDigest: 'result',
    resultJson: '{}',
    observedAckAt: NOW,
  });
}

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

it('waits out a family token advance rather than handing the session to the chunk writer', async () => {
  const id = await acceptSource('family-token-advance', 'old source', false);
  const sessionId = sessionOf(id);
  await seedLegacyFamilyVersion(driver, {
    nodeId: 'token-advance-head',
    sessionId,
    sources: [id],
    now: NOW,
  });
  await acceptSource('family-token-advance', 'new source', false);
  mockCompression();
  const original = legacyNarrativePublication.prepare.bind(legacyNarrativePublication);
  vi.spyOn(legacyNarrativePublication, 'prepare').mockImplementation(async (context, payload) => {
    const planned = await original(context, payload);
    advanceLegacyFamilyToken(sessionId);
    return planned;
  });

  const result = await closeSessionNarrative({ ...chunks, logger }, sessionId, { now: NOW });

  // The session still prefers legacy, so the deferral is contention to wait out and the chunk
  // writer never takes over: a chunk published here would speak for a session that prefers the
  // family it replaces.
  expect(result.status, JSON.stringify(result)).toBe('failed');
  expect(result.summary).toContain('legacy_family_version_changed');
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?').get(sessionId),
  ).toEqual({ n: 0 });
  expect(publications.hasPending()).toBe(false);
});
