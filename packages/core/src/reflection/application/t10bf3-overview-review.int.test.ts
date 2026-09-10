import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { rollUpOverviews } from './overview-rollup.js';
import { closedWindows, writeMemberCursor } from './overview-windows.js';
import {
  acceptCorrection,
  acceptSource,
  chunks,
  driver,
  NOW,
  sealFor,
  store,
} from './test-support/t10b-review.fixture.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { NARRATIVE_SCOPES } from '../../evidence/domain/scopes.js';
import { renameNodeId } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { publishedScopeToken } from '../../infrastructure/sqlite/evidence-scope.js';
import { readCitationsOf } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { publishedChunkSpans } from '../../infrastructure/sqlite/overview-membership.js';

let onlyFirst = false;
const provider: Provider = {
  embed: async () => {
    throw new Error('no embedding');
  },
  generate: async (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (text.includes('You review a draft memory')) {
      return { unsupported: false, reason: 'scripted supported output' };
    }
    const ids = [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))];
    return {
      sentences: (onlyFirst ? ids.slice(0, 1) : ids).map((id) => ({
        text: 'the window carries this source',
        source_ids: [id],
      })),
    };
  },
};
beforeEach(() => {
  onlyFirst = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});
const options = {
  scope: 'day' as const,
  now: NOW,
  windowLimit: 100,
  renderedInputAllowance: 32768,
};

async function published(name: string, day: string) {
  const source = await acceptSource(name, name);
  store.db
    .prepare('UPDATE source_records SET occurred_at = ? WHERE source_id = ?')
    .run(`${day}T12:00:00.000Z`, source);
  const chunk = await sealFor(source);
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  if (result.status !== 'published') {
    throw new Error('fixture failed to publish');
  }
  return { source, chunk, nodeId: result.nodeId };
}

it('does not declare a stale overview settled just because its member IDs are unchanged', async () => {
  const member = await published('settled-stale-child', '2026-08-03');
  await rollUpOverviews({ ...chunks, provider }, options);
  const head = readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-03')!;
  await acceptCorrection('settled-child-correction', 'correction under the window', member.source);
  expect(
    verifyEvidenceRevision(store.db, JSON.parse(head.evidenceRevisionJson!) as EvidenceRevision)
      .status,
  ).toBe('stale');
  const result = await rollUpOverviews({ ...chunks, provider }, options);
  expect(result.settled).toBe(0);
});

it('does not rewrite an unchanged two-member window merely because only one member is cited', async () => {
  await published('one-supported-member-a', '2026-08-10');
  await published('one-supported-member-b', '2026-08-10');
  onlyFirst = true;
  await rollUpOverviews({ ...chunks, provider }, options);
  const head = readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-10')!;
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(
    readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-10')?.revisionNo,
  ).toBe(head.revisionNo);
});

it('reconsiders a member-body refusal when that body becomes readable under the same allowance', async () => {
  const member = await published('restored-window-body', '2026-08-17');
  await renameNodeId(driver, member.nodeId, `${member.nodeId}:hidden`);
  try {
    await rollUpOverviews({ ...chunks, provider }, options);
    expect(
      readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-17'),
    ).toBeUndefined();
  } finally {
    await renameNodeId(driver, `${member.nodeId}:hidden`, member.nodeId);
  }
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-17')).toBeDefined();
});

it('advances the old targets citation token when the replacement no longer cites it', async () => {
  const member = await published('removed-overview-target', '2026-08-24');
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(readCitationsOf(store.db, member.nodeId).length).toBe(1);
  await acceptCorrection('removed-target-correction', 'corrected member', member.source);
  expect((await publishChunkNarrative(chunks, member.chunk, { now: NOW })).status).toBe(
    'published',
  );
  const newChild = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, member.chunk)!;
  const key = { endpointId: member.nodeId, relationClass: NARRATIVE_SCOPES[0] };
  const before = publishedScopeToken(store.db, key);
  expect(before).toBeDefined();
  const freshKey = { endpointId: newChild.nodeId, relationClass: NARRATIVE_SCOPES[0] };
  const freshBefore = publishedScopeToken(store.db, freshKey);
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(readCitationsOf(store.db, member.nodeId)).toEqual([]);
  expect.soft(publishedScopeToken(store.db, key)).not.toBe(before);
  expect(publishedScopeToken(store.db, freshKey)).not.toBe(freshBefore);
});

it('reads back the whole-window boundary cursor its producer writes', async () => {
  await published('cursor-early', '2026-07-01');
  await published('cursor-late', '2026-07-02');
  writeMemberCursor(store.db, 'day', { spanEnd: '2026-07-02T00:00:00.000Z', familyKey: '' });
  expect
    .soft(closedWindows(store.db, 'day', NOW).windows.map((window) => window.key))
    .not.toContain('2026-07-01');
  const first = publishedChunkSpans(store.db, 1)[0]!;
  writeMemberCursor(store.db, 'day', { spanEnd: first.spanEnd, familyKey: first.familyKey });
  expect(closedWindows(store.db, 'day', NOW).windows.map((window) => window.key)).not.toContain(
    '2026-07-01',
  );
});
