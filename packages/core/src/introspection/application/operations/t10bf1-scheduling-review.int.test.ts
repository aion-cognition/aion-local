import { expect, it } from 'vitest';

import { narrativeRegroundingOperation } from './narrative-regrounding.js';
import { narrativeSealOperation } from './narrative-seal.js';
import { verifyEvidenceRevision } from '../../../evidence/application/dependencies.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { findStaleNarratives } from '../../../infrastructure/graph/narrative-queries.js';
import type { EvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { chunkOfSource } from '../../../infrastructure/sqlite/chunk-manifest.js';
import { reconsiderableBlockedAttempts } from '../../../infrastructure/sqlite/chunk-nomination.js';
import {
  CHUNK_REVISION_FAMILY,
  readPublishedRevision,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import { publishChunkNarrative } from '../../../reflection/application/chunk-narrative.js';
import {
  acceptSource,
  acceptCorrection,
  census,
  chunks,
  driver,
  dropCensus,
  NOW,
  sealFor,
  store,
} from '../../../reflection/application/test-support/t10b-review.fixture.js';
import { SUPPRESSION_BLOCK_REASONS } from '../../../reflection/domain/chunk-outcome.js';
import { NARRATIVE_GROUNDING } from '../../../reflection/domain/narrative.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { readSealDemand } from '../seal-census.js';

const SCALES = { batch: 2, maxSpanMs: 86400000, renderedInputAllowance: 400 };
function context(): OperationContext {
  return {
    driver,
    db: store.db,
    config: DEFAULTS,
    provider: chunks.provider,
    logger: chunks.logger,
    narratives: { publications: chunks.publications, resolver: chunks.resolver },
    now: NOW,
    signal: new AbortController().signal,
    health: healthFixture({
      narrativeSeal: readSealDemand(store.db, {
        now: NOW,
        batch: SCALES.batch,
        maxSpanMs: SCALES.maxSpanMs,
        maxMembers: 24,
      }),
    }),
  } as OperationContext;
}

async function published(session: string): Promise<{ source: string; chunkId: string }> {
  const source = await acceptSource(session, 'a member of this narrative');
  const chunkId = await sealFor(source);
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');
  return { source, chunkId };
}

it('gives the ordinary scheduler demand for an input-full young tail', async () => {
  const source = await acceptSource('scheduled-input-trigger', 'a full input '.repeat(80));
  const op = narrativeSealOperation(SCALES);
  const ctx = context();
  expect.soft(op.relevance(ctx.health)).toBeGreaterThan(0);
  await op.run(ctx);
  expect(chunkOfSource(store.db, source)).toBeDefined();
});

it('gives an invalidated chunk demand when no legacy graph marker is stale', async () => {
  const held = await published('scheduled-invalidation');
  await acceptCorrection('scheduled-corrector', 'the member is corrected', held.source);
  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, held.chunkId)!;
  expect(
    verifyEvidenceRevision(store.db, JSON.parse(head.evidenceRevisionJson!) as EvidenceRevision)
      .status,
  ).toBe('stale');
  expect(await findStaleNarratives(driver, NARRATIVE_GROUNDING, 100)).toEqual([]);
  const op = narrativeRegroundingOperation(100);
  const ctx = context();
  expect(ctx.health.graph.staleNarratives).toBe(0);
  expect.soft(op.relevance(ctx.health)).toBeGreaterThan(0);
  await op.run(ctx);
  expect(
    readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, held.chunkId)?.revisionNo,
  ).toBeGreaterThan(head.revisionNo);
});

it('advances past unchanged heads to reach a later invalidated family', async () => {
  await published('prefix-current-one');
  await published('prefix-current-two');
  const later = await published('prefix-stale-later');
  await acceptCorrection('prefix-correction', 'a later correction', later.source);
  const op = narrativeRegroundingOperation(1);
  for (let round = 0; round < 20; round += 1) {
    await op.run(context());
  }
  expect(
    readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, later.chunkId)?.revisionNo,
  ).toBeGreaterThan(1);
});

it('wakes a blocked member-scope read when its census becomes proved', async () => {
  const source = await acceptSource('census-wakeup', 'initially uncounted', false);
  dropCensus(source);
  const chunkId = await sealFor(source);
  expect(await publishChunkNarrative(chunks, chunkId, { now: NOW })).toMatchObject({
    status: 'blocked',
    reason: 'member_scope_census_missing',
  });
  census(source);
  await narrativeSealOperation({ ...SCALES, batch: 100 }).run(context());
  expect(readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeDefined();
});

it('does not infer an unforget transition from a no-input budget refusal', async () => {
  const source = await acceptSource('no-input-cause', 'a wholly present source');
  const chunkId = await sealFor(source);
  const blocked = await publishChunkNarrative(chunks, chunkId, {
    now: NOW,
    policy: { renderedInputAllowance: 1, maxMembers: 24, maxSpanMs: 86400000 },
  });
  expect(blocked).toMatchObject({ status: 'blocked', reason: 'no_admissible_input' });
  const ready = reconsiderableBlockedAttempts(store.db, {
    reasons: SUPPRESSION_BLOCK_REASONS,
    limit: 100,
  });
  expect(ready.map((row) => row.chunkId)).not.toContain(chunkId);
});
