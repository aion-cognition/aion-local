import { afterEach, expect, it, vi } from 'vitest';

import { freezeLegacyCohort, runLegacyBackfillBatch } from './legacy-backfill.js';
import * as legacyCompression from './narrative-compress.js';
import { closeSessionNarrative } from './narratives.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import { driftEpisodeDigest } from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import { LegacyNarrativeGraph } from '../../infrastructure/graph/test-support/legacy-narrative-regression.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { listSessionChunks, listChunkMembers } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';

afterEach(() => {
  vi.restoreAllMocks();
});
it('routes a new session close to one bounded chunk without invoking whole-session compression', async () => {
  const sourceId = await acceptSource(
    'new-session-close',
    'the source at the new close boundary',
    false,
  );
  const sessionId = sessionOf(sourceId);
  const legacy = vi.spyOn(legacyCompression, 'compress');
  const result = await closeSessionNarrative(
    { ...chunks, logger: openLogger({ filePath: '/dev/null', level: 'fatal' }) },
    sessionId,
    { now: NOW },
  );
  expect(result).toMatchObject({ status: 'created', episodes: 1 });
  expect(legacy).not.toHaveBeenCalled();
  expect(readFamilySelection(store.db, sessionId)?.family).toBe('chunk');
  const sealed = listSessionChunks(store.db, sessionId);
  expect(sealed).toHaveLength(1);
  expect(listChunkMembers(store.db, sealed[0]!.chunkId)).toEqual([sourceId]);
  const nodes = await new LegacyNarrativeGraph(driver).nodesWithLabel('Narrative');
  expect(
    nodes
      .filter((node) => node.properties.session_id === sessionId)
      .map((node) => node.properties.narrative_family),
  ).toEqual(['chunk']);
});

it('deliberately re-verifies an already verified cohort member instead of relying on the repair selector', async () => {
  const sourceId = await acceptSource(
    'explicit-old-verification',
    'a source whose old proof must be checked again',
    false,
  );
  const cohortId = 'explicit-old-verification';
  await freezeLegacyCohort(chunks, { cohortId, now: NOW });
  const first = await runLegacyBackfillBatch(chunks, { cohortId, now: NOW });
  expect(first.outcomes.find((outcome) => outcome.sourceId === sourceId)?.status).toBe('verified');
  await driftEpisodeDigest(driver, sourceId, 'changed-after-its-recorded-proof');
  const ordinary = await runLegacyBackfillBatch(chunks, { cohortId, now: NOW, reverify: true });
  expect(ordinary.outcomes.map((outcome) => outcome.sourceId)).not.toContain(sourceId);
  expect(readSourceRecord(store.db, sourceId)?.verificationStatus).toBe('verified');
  const explicit = await runLegacyBackfillBatch(chunks, {
    cohortId,
    now: NOW,
    reverify: true,
    sourceIds: [sourceId],
    limit: 1,
  });
  expect(explicit.outcomes).toEqual([
    expect.objectContaining({ sourceId, status: 'pinned', published: 'acknowledged' }),
  ]);
  expect(readSourceRecord(store.db, sourceId)?.verificationStatus).toBe('pinned');
});
