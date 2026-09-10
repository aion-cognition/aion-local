import { afterEach, expect, it, vi } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { rollUpOverviews } from './overview-rollup.js';
import {
  acceptSource,
  chunks,
  NOW,
  publications,
  sealFor,
  store,
} from './test-support/t10b-review.fixture.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { JsonValue } from '../../infrastructure/publication/types.js';
import { readCitationsFrom } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const provider: Provider = {
  embed: async () => {
    throw new Error('no embedding');
  },
  generate: async (request) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (text.includes('You review a draft memory')) {
      return { unsupported: false, reason: 'scripted support' };
    }
    return { sentences: [{ text: 'the first member supports this sentence', source_ids: ['S1'] }] };
  },
};

it('distinguishes exact coverage membership from a union of unchanged source dependencies', async () => {
  const children: { chunk: string; nodeId: string }[] = [];
  for (let index = 0; index < 2; index += 1) {
    const source = await acceptSource(`same-proof-${String(index)}`, 'unchanged raw evidence');
    store.db
      .prepare('UPDATE source_records SET occurred_at = ? WHERE source_id = ?')
      .run('2026-08-04T12:00:00.000Z', source);
    const chunk = await sealFor(source);
    const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
    if (result.status !== 'published') {
      throw new Error('fixture publication failed');
    }
    children.push({ chunk, nodeId: result.nodeId });
  }
  const options = {
    scope: 'day' as const,
    now: NOW,
    windowLimit: 10,
    renderedInputAllowance: 32768,
  };
  expect((await rollUpOverviews({ ...chunks, provider }, options)).published).toBe(1);
  const initial = readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-04')!;
  const citations = readCitationsFrom(store.db, initial.nodeId);
  expect(citations).toHaveLength(1);
  expect((await rollUpOverviews({ ...chunks, provider }, options)).settled).toBe(1);
  const replaced = children.find((child) => child.nodeId !== citations[0]!.targetId)!;
  const prior = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, replaced.chunk)!;
  const saved = store.db
    .prepare(
      'SELECT payload_json FROM publication_intents WHERE operation_id = (SELECT operation_id FROM chunk_revisions WHERE chunk_id = ? AND revision_no = ?)',
    )
    .get(replaced.chunk, prior.revisionNo) as { payload_json: string };
  const payload = JSON.parse(saved.payload_json) as Record<string, JsonValue>;
  const allocation = allocateNarrativeRevision(
    store.db,
    CHUNK_REVISION_FAMILY,
    replaced.chunk,
    NOW,
  );
  const outcome = await publications.publish({
    kind: 'narrative_publish',
    operationId: 'same-evidence-new-child',
    payload: {
      ...payload,
      revisionNo: allocation.revisionNo,
      nodeId: allocation.nodeId,
      expectedHead: prior.revisionNo,
      narrative: 'a different wording from the same certified raw evidence',
    },
  });
  expect(outcome.status).toBe('acknowledged');
  const current = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, replaced.chunk)!;
  expect(current.nodeId).not.toBe(prior.nodeId);
  expect(current.evidenceRevisionJson).toBe(prior.evidenceRevisionJson);
  const rerun = await rollUpOverviews({ ...chunks, provider }, options);
  expect.soft(rerun.settled).toBe(0);
  expect(
    readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-04')?.revisionNo,
  ).toBeGreaterThan(initial.revisionNo);
});
