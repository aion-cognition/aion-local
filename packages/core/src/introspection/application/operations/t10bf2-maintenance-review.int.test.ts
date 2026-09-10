import { afterEach, expect, it, vi } from 'vitest';

import { narrativeCleanupOperation } from './narrative-cleanup-operation.js';
import { narrativeRegroundingOperation } from './narrative-regrounding.js';
import { narrativeSealOperation } from './narrative-seal.js';
import { commitSourceState } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import * as cleanupQueries from '../../../infrastructure/graph/narrative-cleanup-queries.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { chunkOfSource } from '../../../infrastructure/sqlite/chunk-manifest.js';
import { reconsiderableBlockedAttempts } from '../../../infrastructure/sqlite/chunk-nomination.js';
import {
  CHUNK_REVISION_FAMILY,
  readPublishedRevision,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import {
  publishChunkNarrative,
  sealSessionChunk,
} from '../../../reflection/application/chunk-narrative.js';
import {
  acceptCorrection,
  acceptSource,
  chunks,
  driver,
  NOW,
  sealFor,
  sessionOf,
  store,
} from '../../../reflection/application/test-support/t10b-review.fixture.js';
import { SUPPRESSION_BLOCK_REASONS } from '../../../reflection/domain/chunk-outcome.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { readSealDemand } from '../seal-census.js';

const scales = { batch: 1, maxSpanMs: 86400000, renderedInputAllowance: 32768 };

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([1, 40])(
  'does not report a potential input candidate as a proved eligible group (size=%s)',
  async (size) => {
    const input = { now: NOW, ...scales, maxMembers: 64 };
    const before = readSealDemand(store.db, input).eligibleGroups;
    const source = await acceptSource(`small-tail-demand:${String(size)}`, 'small '.repeat(size));
    const result = await sealSessionChunk(chunks, sessionOf(source), {
      now: NOW,
      policy: { ...scales, maxMembers: 64 },
    });
    expect(result.status).toBe('waiting');
    expect(readSealDemand(store.db, input).eligibleGroups).toBe(before);
  },
);
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
      narrativeSeal: readSealDemand(store.db, { now: NOW, ...scales, maxMembers: 64 }),
    }),
  } as OperationContext;
}
async function published(name: string) {
  const source = await acceptSource(name, name);
  const chunk = await sealFor(source);
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  if (result.status !== 'published') {
    throw new Error('fixture failed publication');
  }
  return { source, chunk, nodeId: result.nodeId };
}

it('eventually discovers stale-head demand beyond the collectors unchanged prefix', async () => {
  for (let index = 0; index < 5; index += 1) {
    await published(`collector-current:${String(index)}`);
  }
  const stale = await published('collector-hidden-stale');
  await acceptCorrection('collector-new-evidence', 'changed underneath a later head', stale.source);
  const op = narrativeRegroundingOperation(1);
  let demand = false;
  for (let tick = 0; tick < 12; tick += 1) {
    demand ||= op.relevance(context().health) > 0;
  }
  expect(demand).toBe(true);
});

it('reconsiders an explicit capacity block when its recorded allowance changes', async () => {
  const source = await acceptSource('capacity-policy-wakeup', 'raw member');
  const chunk = await sealFor(source);
  expect(
    await publishChunkNarrative(chunks, chunk, {
      now: NOW,
      policy: { ...scales, maxMembers: 64, renderedInputAllowance: 1 },
    }),
  ).toMatchObject({ status: 'blocked', reason: 'no_admissible_input' });
  const op = narrativeSealOperation({ ...scales, batch: 100 });
  await op.run(context());
  expect(readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunk)).toBeDefined();
});

it('does not infer the blocking cause from any earlier forgotten state', async () => {
  const source = await acceptSource('old-forget-budget', 'restored before attempt');
  const chunk = await sealFor(source);
  const earlier = new Date(NOW.getTime() - 2000);
  commitSourceState(store.db, {
    sourceId: source,
    stateKind: 'forgotten',
    operationId: 'old-forget-before-budget',
    at: earlier,
  });
  commitSourceState(store.db, {
    sourceId: source,
    stateKind: 'unforgotten',
    operationId: 'old-restore-before-budget',
    at: new Date(NOW.getTime() - 1000),
  });
  expect(
    await publishChunkNarrative(chunks, chunk, {
      now: NOW,
      policy: { ...scales, maxMembers: 64, renderedInputAllowance: 1 },
    }),
  ).toMatchObject({ status: 'blocked', reason: 'no_admissible_input' });
  expect(
    reconsiderableBlockedAttempts(store.db, { reasons: SUPPRESSION_BLOCK_REASONS, limit: 100 }).map(
      (row) => row.chunkId,
    ),
  ).not.toContain(chunk);
});

it('repairs a valid old revision even when unbound ids sort ahead of its keeper', async () => {
  const held = await published('keeper-outside-prefix');
  await acceptCorrection('keeper-later-correction', 'second revision', held.source);
  const second = await publishChunkNarrative(chunks, held.chunk, { now: NOW });
  expect(second.status).toBe('published');
  await unsupersedeNode(driver, { id: held.nodeId, now: NOW });
  for (let index = 0; index < 33; index += 1) {
    await writeStampedNode(driver, {
      label: 'Narrative',
      id: `!keeper-prefix:${String(index).padStart(3, '0')}`,
      now: NOW,
      properties: {
        text: 'unbound family revision',
        chunk_id: held.chunk,
        narrative_family: 'chunk',
      },
    });
  }
  const op = narrativeCleanupOperation();
  for (let run = 0; run < 4; run += 1) {
    await op.run({ ...context(), now: new Date(NOW.getTime() + run * 1000) });
  }
  expect((await nodeProperties(driver, held.nodeId)).valid_until).toBeDefined();
});

it('discovers an input-full tail through its canonical archive mapping', async () => {
  const source = await acceptSource('canonical-archive-demand', 'large raw text '.repeat(80));
  const alias = `archive-for:${source}`;
  store.db
    .prepare('UPDATE experience_archive SET episode_id = ? WHERE episode_id = ?')
    .run(alias, source);
  store.db
    .prepare('UPDATE source_records SET canonical_archive_id = ? WHERE source_id = ?')
    .run(alias, source);
  const op = narrativeSealOperation({ ...scales, renderedInputAllowance: 400, batch: 100 });
  const read = readSealDemand(store.db, {
    ...scales,
    now: NOW,
    maxMembers: 64,
    renderedInputAllowance: 400,
  });
  // Other preceding fixtures may themselves owe work; assert this tail is in the input census.
  const { inputFullRemainderGroups } =
    await import('../../../infrastructure/sqlite/chunk-nomination.js');
  expect
    .soft(
      inputFullRemainderGroups(store.db, { allowance: 400, maxMembers: 64, limit: 100 }).map(
        (row) => row.sessionId,
      ),
    )
    .toContain(
      (
        store.db
          .prepare('SELECT session_id FROM source_records WHERE source_id = ?')
          .get(source) as { session_id: string }
      ).session_id,
    );
  await op.run({ ...context(), health: healthFixture({ narrativeSeal: read }) });
  expect(chunkOfSource(store.db, source)).toBeDefined();
});

it('keeps the revision read bound when the configured family batch exceeds half that bound', async () => {
  for (let family = 0; family < 150; family += 1) {
    for (let revision = 0; revision < 2; revision += 1) {
      await writeStampedNode(driver, {
        label: 'Narrative',
        id: `review-family-budget:${String(family)}:${String(revision)}`,
        now: NOW,
        properties: {
          text: 'an unbound revision',
          chunk_id: `zz-budget-family:${String(family).padStart(3, '0')}`,
          narrative_family: 'chunk',
        },
      });
    }
  }
  const original = cleanupQueries.findDuplicateChunkFamilies;
  let materialized = 0;
  vi.spyOn(cleanupQueries, 'findDuplicateChunkFamilies').mockImplementation(async (...args) => {
    const result = await original(...args);
    materialized += result.reduce((total, family) => total + family.versions.length, 0);
    return result;
  });
  const ctx = context();
  await narrativeCleanupOperation().run({
    ...ctx,
    config: {
      ...ctx.config,
      maintenance: { ...ctx.config.maintenance, narrativeCleanupBatch: 150 },
    },
  });
  expect(materialized).toBeLessThanOrEqual(200);
});
