import { expect, it } from 'vitest';

import { narrativeCleanupOperation } from './narrative-cleanup-operation.js';
import { reconsiderBlockedAttempts } from './seal-reconsider.js';
import { durableRoleScope } from '../../../evidence/domain/scopes.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import {
  CHUNK_REVISION_FAMILY,
  readNarrativeRevision,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import { publishChunkNarrative } from '../../../reflection/application/chunk-narrative.js';
import { REPAIR_SCAN_LIMIT } from '../../../reflection/application/narrative-repair.js';
import { rollUpNarratives } from '../../../reflection/application/narrative-rollup.js';
import {
  acceptCorrection,
  acceptSource,
  census,
  chunks,
  driver,
  dropCensus,
  NOW,
  sealFor,
  store,
} from '../../../reflection/application/test-support/t10b-review.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

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
    health: healthFixture(),
  } as OperationContext;
}

it('continues repair across runs beyond a full scan of protected unbound versions', async () => {
  const source = await acceptSource('repair-beyond-scan', 'a legitimate source');
  const chunk = await sealFor(source);
  const first = await publishChunkNarrative(chunks, chunk, { now: NOW });
  if (first.status !== 'published') {
    throw new Error('first publication failed');
  }
  await acceptCorrection('repair-beyond-scan-correction', 'second reading', source);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  await unsupersedeNode(driver, { id: first.nodeId, now: NOW });
  for (let index = 0; index <= REPAIR_SCAN_LIMIT; index += 1) {
    await writeStampedNode(driver, {
      label: 'Narrative',
      id: `!beyond-scan:${String(index).padStart(4, '0')}`,
      now: NOW,
      properties: {
        text: 'protected unknown revision',
        chunk_id: chunk,
        narrative_family: 'chunk',
      },
    });
  }
  for (let pass = 0; pass < 3; pass += 1) {
    await narrativeCleanupOperation().run({
      ...context(),
      now: new Date(NOW.getTime() + pass * 1000),
    });
  }
  expect.soft((await nodeProperties(driver, first.nodeId)).valid_until).toBeDefined();
  expect((await nodeProperties(driver, '!beyond-scan:0000')).valid_until).toBeUndefined();
});

it('reaches a cleared block behind unchanged blocked attempts', async () => {
  const rows: { source: string; chunk: string; revision: number }[] = [];
  for (let index = 0; index < 3; index += 1) {
    const source = await acceptSource(`blocked-page:${String(index)}`, 'uncounted source', false);
    dropCensus(source);
    const chunk = await sealFor(source);
    const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
    expect(result).toMatchObject({ status: 'blocked', reason: 'member_scope_census_missing' });
    if (result.status !== 'blocked') {
      throw new Error('fixture did not block');
    }
    rows.push({ source, chunk, revision: result.revisionNo });
  }
  const target = rows.sort((left, right) => left.chunk.localeCompare(right.chunk)).at(-1)!;
  census(target.source);
  for (let pass = 0; pass < 4; pass += 1) {
    reconsiderBlockedAttempts(context(), 1, { renderedInputAllowance: 16384, maxMembers: 64 });
  }
  expect(
    readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, target.chunk, target.revision)
      ?.blockedReason,
  ).toBeNull();
});

it('reaches a later legacy window after stepping past one oversized calendar window', async () => {
  for (let index = 0; index < 4; index += 1) {
    const at = new Date(index < 3 ? '2026-08-01T12:00:00.000Z' : '2026-08-02T12:00:00.000Z');
    const id = `whole-window-page:${String(index)}`;
    await writeStampedNode(driver, {
      label: 'Narrative',
      id,
      now: at,
      occurredAt: at,
      properties: {
        text: index < 3 ? 'earlier member' : 'LATER FITTING WINDOW',
        scope: 'session',
        version: 1,
        coverage_count: 1,
        coverage_key: id,
        grounding: 'grounded-1',
      },
    });
  }
  const prompts: string[] = [];
  const provider: Provider = {
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    generate: async (request) => {
      const text = request.messages.map((message) => message.content).join('\n');
      if (text.includes('You review a draft memory')) {
        return { unsupported: false, reason: 'scripted supported output' };
      }
      prompts.push(text);
      return { sentences: [{ text: 'the later window is recorded', source_ids: ['S1'] }] };
    },
  };
  for (let pass = 0; pass < 4; pass += 1) {
    await rollUpNarratives(
      { ...chunks, provider, logger: openLogger({ filePath: '/dev/null', level: 'fatal' }) },
      {
        scope: 'day',
        now: NOW,
        windowLimit: 1,
        memberLimit: 2,
        renderedInputAllowance: 32768,
      },
    );
  }
  expect(prompts.some((prompt) => prompt.includes('LATER FITTING WINDOW'))).toBe(true);
});

it('control: keeps an external-scope refusal until that external census is established', async () => {
  const source = await acceptSource('external-block-member', 'member whose own scopes are counted');
  const external = await acceptCorrection(
    'external-block-correction',
    'required external source',
    source,
  );
  const scope = durableRoleScope('stated_correction', 'in');
  store.db
    .prepare(
      "UPDATE evidence_scope_versions SET census_status = 'unknown' WHERE endpoint_id = ? AND relation_class = ?",
    )
    .run(external, scope);
  const chunk = await sealFor(source);
  const blocked = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(blocked).toMatchObject({ status: 'blocked', reason: 'member_scope_census_missing' });
  if (blocked.status !== 'blocked') {
    throw new Error('fixture did not block on the external scope');
  }
  const inForce = { renderedInputAllowance: 16384, maxMembers: 64 };
  reconsiderBlockedAttempts(context(), 100, inForce);
  expect(
    readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunk, blocked.revisionNo)
      ?.blockedReason,
  ).toBe('member_scope_census_missing');
  census(external);
  reconsiderBlockedAttempts(context(), 100, inForce);
  expect(
    readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunk, blocked.revisionNo)
      ?.blockedReason,
  ).toBeNull();
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
});
