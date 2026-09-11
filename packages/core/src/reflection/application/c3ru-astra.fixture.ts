import { expect } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { readFamilyFence } from './family-fence.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import { cutoverSessionFamily } from './narrative-family.js';
import { chunks, driver, NOW, publications, store } from './test-support/t10b-review.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import {
  DERIVES_FROM_TYPE,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import { recordMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { rememberMigrationPolicy } from '../../infrastructure/sqlite/migration-partition.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';
import { coverageKey, NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * The calendar pass against sessions that have moved to chunks.
 *
 * The member read nominates a retired whole-session narrative exactly as it always did, because
 * a cutover moves no clock and closes no interval. What must not happen after it is a calendar
 * summary published over that narrative, or the narrative absorbed into one. A day summary
 * written before the cutover is the same question one scope up: the week above it reads that
 * summary, and what the summary rests on is retired.
 *
 * The cutover here is the real one, through the coordinator, with the census, the sealed
 * partition and the published chunk it requires.
 */

const drafts: string[] = [];

/** What the pass is holding a synthesis open for, which is how the race is staged. */
let suspended: (() => Promise<void>) | undefined;

export const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0])),
  generate: (request) => {
    const prompt = request.messages.map((message) => message.content).join('\n');
    if (prompt.includes('You review a draft memory')) {
      return Promise.resolve({
        unsupported: false,
        reason: 'every sentence stays inside its citations',
      });
    }
    drafts.push(prompt);
    const during = suspended;
    suspended = undefined;
    const handles = [...new Set(prompt.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
    const answer = {
      sentences: [{ text: 'The window carried its work forward.', source_ids: handles }],
    };
    return during === undefined ? Promise.resolve(answer) : during().then(() => answer);
  },
};

export function deps() {
  return {
    driver,
    db: store.db,
    provider,
    publications,
    logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
  };
}

/** The original graph-only whole-session representation, dated into the window under test. */
export async function seedLegacy(input: {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly occurredAt: Date;
  readonly text: string;
}): Promise<void> {
  await writeStampedNode(driver, {
    label: 'Narrative',
    id: input.nodeId,
    now: input.occurredAt,
    occurredAt: input.occurredAt,
    properties: {
      session_id: input.sessionId,
      scope: 'session',
      version: 1,
      coverage_key: coverageKey([input.sourceId]),
      coverage_count: 1,
      coverage: 1,
      grounding: NARRATIVE_GROUNDING,
      text: input.text,
      summary: input.text,
      citations: [input.sourceId],
    },
  });
  for (const edge of [
    { type: DERIVES_FROM_TYPE, sourceId: input.nodeId, targetId: input.sessionId },
    { type: SUMMARIZED_BY_TYPE, sourceId: input.sourceId, targetId: input.nodeId },
  ]) {
    await upsertEdge(driver, {
      ...edge,
      strength: 1,
      confidence: 1,
      signals: [],
      provenance: [],
      count: 0,
      now: input.occurredAt,
    });
  }
}

/** Everything a session family needs before it may choose chunks, then the choice itself. */
export async function cutOver(
  sessionId: string,
  sourceId: string,
  cohortId: string,
): Promise<void> {
  await freezeLegacyCohort(chunks, { cohortId, now: NOW });
  rememberMigrationPolicy(store.db, cohortId, {
    ...CHUNK_BOUNDARY_POLICY,
    partitionPolicyVersion: 1,
  });
  await runLegacyBackfillBatch(chunks, { cohortId, now: NOW });
  await sealLegacyCohortCensus(chunks, { cohortId });
  const sealed = sealChunk(store.db, { sessionId, sourceIds: [sourceId], sealedAt: NOW });
  recordMigrationProgress(store.db, {
    cohortId,
    sourceId,
    status: 'verified',
    partitionAssignment: sealed.chunkId,
  });
  expect((await publishChunkNarrative(chunks, sealed.chunkId, { now: NOW })).status).toBe(
    'published',
  );
  expect((await cutoverSessionFamily(chunks, { sessionId, cohortId })).status).toBe('acknowledged');
  expect(readFamilyFence(store.db, sessionId)?.selection.family).toBe('chunk');
}
