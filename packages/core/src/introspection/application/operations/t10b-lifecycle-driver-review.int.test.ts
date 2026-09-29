import { beforeAll, expect, it } from 'vitest';

import { narrativeRegroundingOperation } from './narrative-regrounding.js';
import { narrativeSealOperation } from './narrative-seal.js';
import { verifyEvidenceRevision } from '../../../evidence/application/dependencies.js';
import { commitSourceState } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { EvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { chunkOfSource } from '../../../infrastructure/sqlite/chunk-manifest.js';
import {
  CHUNK_REVISION_FAMILY,
  readPublishedRevision,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import {
  publishChunkNarrative,
  sealSessionChunk,
} from '../../../reflection/application/chunk-narrative.js';
import { backdateSubstrateBirth } from '../../../reflection/application/test-support/publication-substrate.fixture.js';
import {
  acceptSource,
  acceptCorrection,
  acceptTurn,
  chunks,
  driver,
  forgetSource,
  NOW,
  prompts,
  sealFor,
  sessionOf,
  store,
} from '../../../reflection/application/test-support/t10b-review.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { readSealDemand } from '../seal-census.js';

const DAY = 86400000;
const SCALES = { batch: 2, maxSpanMs: DAY, renderedInputAllowance: 16384 };

// The fixture's coordinator runs on `NOW`, so its substrate is born on that clock too. Left on the
// day of the run, the birth fence refuses the future-dated turn below once the run is more than
// ten days past `NOW`.
beforeAll(async () => {
  await backdateSubstrateBirth(driver, store.db, NOW);
});

function context(now = NOW): OperationContext {
  return {
    driver,
    db: store.db,
    config: DEFAULTS,
    logger: chunks.logger,
    provider: chunks.provider,
    narratives: { resolver: chunks.resolver, publications: chunks.publications },
    health: healthFixture({
      narrativeSeal: readSealDemand(store.db, {
        now,
        batch: SCALES.batch,
        maxSpanMs: DAY,
        maxMembers: 24,
      }),
    }),
    now,
    signal: new AbortController().signal,
  } as OperationContext;
}

it('nominates a fresh tail at the rendered-input boundary before its count or age boundary', async () => {
  const source = await acceptSource('input-trigger', 'a large raw source '.repeat(60));
  const scales = { ...SCALES, renderedInputAllowance: 400 };
  const ctx = context();
  await narrativeSealOperation(scales).run(ctx);
  const chosen = chunkOfSource(store.db, source);
  expect.soft(chosen).toBeDefined();
  // At the failing head, prove this same tail is admissible without changing the expectation.
  if (chosen === undefined) {
    const direct = await sealSessionChunk(chunks, sessionOf(source), {
      now: NOW,
      policy: { ...scales, maxMembers: 24 },
    });
    expect(direct.status).toBe('sealed');
  }
});

it('seals a mature accepted tail even when the stated event lies in the future', async () => {
  const source = await acceptTurn(
    'future-event',
    'a future plan whose capture is mature',
    new Date(NOW.getTime() + 10 * DAY),
  );
  const later = new Date(NOW.getTime() + 2 * DAY);
  const ctx = context(later);
  expect(ctx.health.narrativeSeal.dueRemainders).toBeGreaterThan(0);
  await narrativeSealOperation(SCALES).run(ctx);
  expect(chunkOfSource(store.db, source)).toBeDefined();
});

it('regrounds an invalidated chunk through the existing dependency-aware primitive', async () => {
  const source = await acceptSource('driver-invalidation', 'original driver statement');
  const chunkId = await sealFor(source);
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');
  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId)!;
  await acceptCorrection('driver-correction', 'CURRENT DRIVER CORRECTION', source);
  const evidence = JSON.parse(head.evidenceRevisionJson!) as EvidenceRevision;
  expect(verifyEvidenceRevision(store.db, evidence).status).toBe('stale');
  await narrativeRegroundingOperation(10).run(context());
  const after = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect.soft(after?.revisionNo).toBeGreaterThan(head.revisionNo);
  // At the failing head, the primitive proves these exact records permit the missing work.
  if (after?.revisionNo === head.revisionNo) {
    expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');
  }
  expect(prompts.at(-1)).toContain('CURRENT DRIVER CORRECTION');
});

it('reconsiders a blocked unpublished chunk after its source is unforgotten', async () => {
  const source = await acceptSource('blocked-prerequisite', 'restorable member');
  const chunkId = await sealFor(source);
  forgetSource(source, 'driver-forget');
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('blocked');
  commitSourceState(store.db, {
    sourceId: source,
    stateKind: 'unforgotten',
    operationId: 'driver-unforget',
    at: NOW,
  });
  await narrativeSealOperation({ ...SCALES, batch: 10 }).run(context());
  expect(readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeDefined();
});
