import { afterEach, expect, it, vi } from 'vitest';

import { publishChunkNarrative, sealSessionChunk } from './chunk-narrative.js';
import {
  acceptCorrection,
  acceptSource,
  chunks,
  driver,
  NOW,
  prompts,
  sealFor,
  sessionOf,
  store,
} from './test-support/t10a-review.fixture.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import {
  commitIncidence,
  establishNodeState,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import * as narrativeQueries from '../../infrastructure/graph/narrative-queries.js';
import {
  countNodesWithId,
  renameNodeId,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { readCitationsFrom } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  readSourceRecord,
  recordSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('keeps an applicable correction of a correction when another member changes later', async () => {
  const first = await acceptSource('nested-requirement', 'FIRST MEMBER');
  const second = await acceptSource('nested-requirement', 'SECOND MEMBER');
  const direct = await acceptCorrection('direct-requirement', 'DIRECT CORRECTION', first);
  const chunk = await sealFor(first);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  await acceptCorrection('refined-requirement', 'REFINEMENT STILL APPLIES', direct);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  expect(prompts.at(-1)).toContain('REFINEMENT STILL APPLIES');
  await acceptCorrection('other-member-change', 'SECOND MEMBER CORRECTION', second);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  expect.soft(prompts.at(-1)).toContain('REFINEMENT STILL APPLIES');
  expect.soft(prompts.at(-1)).toContain('SECOND MEMBER CORRECTION');
});

it('does not certify old enrichment text with tokens acquired after that text changed', async () => {
  const source = await acceptSource('enrichment-read-race', 'SOURCE FOR CONTEXT');
  const id = 'review-enrichment-read-race';
  await writeStampedNode(driver, {
    label: 'Insight',
    id,
    now: NOW,
    properties: { text: 'OLD ENRICHMENT TEXT' },
  });
  await upsertEdge(driver, {
    type: 'EXTRACTED_FROM',
    sourceId: id,
    targetId: source,
    strength: 1,
    confidence: 1,
    count: 0,
    signals: [],
    provenance: ['review'],
    now: NOW,
  });
  commitIncidence(store.db, {
    sourceId: source,
    nodeId: id,
    role: 'extraction',
    operationId: 'review-enrichment-source',
    at: NOW,
  });
  for (const { role, direction } of OWNERSHIP_SCOPES) {
    establishScope(store.db, id, durableRoleScope(role, direction), NOW);
  }
  establishNodeState(store.db, id, { revision: 1, at: NOW });
  const chunk = await sealFor(source);
  const original = narrativeQueries.loadMemberSourceNodes;
  let moved = false;
  vi.spyOn(narrativeQueries, 'loadMemberSourceNodes').mockImplementation(async (...args) => {
    const rows = await original(...args);
    if (!moved && rows.some((row) => row.id === id)) {
      moved = true;
      await writeStampedNode(driver, {
        label: 'Insight',
        id,
        now: NOW,
        properties: { text: 'NEW ENRICHMENT TEXT' },
      });
      establishNodeState(store.db, id, { revision: 2, at: NOW });
    }
    return rows;
  });
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(moved).toBe(true);
  if (prompts.some((prompt) => prompt.includes('OLD ENRICHMENT TEXT'))) {
    expect(result.status).not.toBe('published');
  }
});

it('rechecks initial verification inside the transaction that freezes membership', async () => {
  const source = await acceptSource('membership-write-race', 'A VERIFIED SOURCE AT FIRST READ');
  const row = readSourceRecord(store.db, source)!;
  const original = chunks.resolver.resolveSources.bind(chunks.resolver);
  let moved = false;
  vi.spyOn(chunks.resolver, 'resolveSources').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!moved) {
      moved = true;
      recordSourceRecord(store.db, {
        sourceId: source,
        sessionId: row.sessionId,
        verificationStatus: 'pinned',
        verificationReason: 'verification withdrawn before seal',
        occurredAt: row.occurredAt,
        createdAt: new Date(row.createdAt),
      });
    }
    return result;
  });
  const result = await sealSessionChunk(chunks, sessionOf(source), {
    now: NOW,
    sessionClosing: true,
  });
  expect(moved).toBe(true);
  expect(readSourceRecord(store.db, source)?.verificationStatus).toBe('pinned');
  expect(result.status).not.toBe('sealed');
});

it('control: regrounds entirely from archived members with their original projection ids absent', async () => {
  const first = await acceptSource('all-evicted-control', 'FIRST ARCHIVED MEMBER');
  const second = await acceptSource('all-evicted-control', 'SECOND ARCHIVED MEMBER');
  const chunk = await sealFor(first);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  const hidden: string[] = [];
  try {
    for (const id of [first, second]) {
      transitionSourceResidency(store.db, {
        sourceId: id,
        state: 'evicted',
        operationId: `evict:${id}`,
        transitionedAt: NOW,
      });
      await renameNodeId(driver, id, `review-hidden:${id}`);
      hidden.push(id);
      expect(await countNodesWithId(driver, 'Episode', id)).toBe(0);
    }
    establishScope(store.db, first, durableRoleScope('stated_confirmation', 'in'), NOW);
    const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
    expect(result.status).toBe('published');
    if (result.status !== 'published') {
      throw new Error('the complete archive-backed control did not publish');
    }
    expect(prompts.at(-1)).toContain('FIRST ARCHIVED MEMBER');
    expect(prompts.at(-1)).toContain('SECOND ARCHIVED MEMBER');
    expect(
      readCitationsFrom(store.db, result.nodeId)
        .map((row) => row.targetId)
        .sort(),
    ).toEqual([first, second].sort());
    for (const id of [first, second]) {
      expect(await countNodesWithId(driver, 'Episode', id)).toBe(0);
    }
  } finally {
    for (const id of hidden) {
      await renameNodeId(driver, `review-hidden:${id}`, id);
    }
  }
});
