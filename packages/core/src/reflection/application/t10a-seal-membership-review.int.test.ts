import { expect, it } from 'vitest';

import { sealSessionChunk } from './chunk-narrative.js';
import { acceptSource, chunks, NOW, sessionOf, store } from './test-support/t10a-review.fixture.js';
import { listChunkMembers } from '../../infrastructure/sqlite/chunk-manifest.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';

it('keeps an initially unverified member out of sealed membership', async () => {
  const source = await acceptSource('initial-pin', 'verified neighbour');
  const sessionId = sessionOf(source);
  recordSourceRecord(store.db, {
    sourceId: 'review-ordered-legacy-pin',
    sessionId,
    verificationStatus: 'pinned',
    verificationReason: 'archive_mapping_unverified',
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
    captureOrderValue: '00000000000000000000',
    captureOrderBasis: 'archive_acceptance',
    origin: 'legacy',
  });
  const result = await sealSessionChunk(chunks, sessionId, { now: NOW, sessionClosing: true });
  expect(result.status).toBe('sealed');
  if (result.status === 'sealed') {
    expect(listChunkMembers(store.db, result.chunkId)).toEqual([source]);
  }
});

it('does not let an unordered legacy pin stop a verified live remainder', async () => {
  const source = await acceptSource('unordered-pin', 'verified live source');
  const sessionId = sessionOf(source);
  recordSourceRecord(store.db, {
    sourceId: 'review-unordered-legacy-pin',
    sessionId,
    verificationStatus: 'pinned',
    verificationReason: 'capture_order_unknown',
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
    captureOrderBasis: 'pinned',
    origin: 'legacy',
  });
  const result = await sealSessionChunk(chunks, sessionId, { now: NOW, sessionClosing: true });
  expect(result.status).toBe('sealed');
  if (result.status === 'sealed') {
    expect(listChunkMembers(store.db, result.chunkId)).toEqual([source]);
  }
});

it('control: a verified ordered remainder seals once', async () => {
  const source = await acceptSource('ordered-control', 'verified source');
  const sessionId = sessionOf(source);
  const result = await sealSessionChunk(chunks, sessionId, { now: NOW, sessionClosing: true });
  expect(result.status).toBe('sealed');
  if (result.status === 'sealed') {
    expect(listChunkMembers(store.db, result.chunkId)).toEqual([source]);
  }
  expect(
    (await sealSessionChunk(chunks, sessionId, { now: NOW, sessionClosing: true })).status,
  ).toBe('waiting');
});
