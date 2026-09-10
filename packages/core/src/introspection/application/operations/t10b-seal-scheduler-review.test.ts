import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { narrativeSealOperation } from './narrative-seal.js';
import type { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import {
  listChunkMembers,
  readRemainderMembers,
  sealChunk,
} from '../../../infrastructure/sqlite/chunk-manifest.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { recordSourceRecord } from '../../../infrastructure/sqlite/source-identity.js';
import {
  captureOrderValue,
  touchSessionRemainder,
} from '../../../infrastructure/sqlite/source-lifecycle.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

const seam = vi.hoisted(() => ({
  seal: vi.fn(),
  publish: vi.fn(),
  recover: vi.fn(),
  pending: false,
}));
vi.mock('../../../reflection/application/chunk-narrative.js', () => ({
  sealSessionChunk: seam.seal,
  publishChunkNarrative: seam.publish,
}));

const NOW = new Date('2026-09-10T00:00:00Z');
const OLD = new Date(NOW.getTime() - 2 * 86400000);
const SCALES = { batch: 1, maxSpanMs: 86400000, renderedInputAllowance: 16384 };
let store: SqliteStore;
let position = 0;

function source(sessionId: string): string {
  position += 1;
  const sourceId = `source-${String(position)}`;
  recordSourceRecord(store.db, {
    sourceId,
    sessionId,
    verificationStatus: 'verified',
    occurredAt: OLD.toISOString(),
    createdAt: OLD,
    archive: {
      canonicalArchiveId: `archive-${sourceId}`,
      archiveSchemaVersion: 1,
      identityHash: sourceId,
      verifiedContentDigest: sourceId,
      verificationPolicyVersion: 1,
      archivedAt: OLD.toISOString(),
    },
    captureOrderValue: captureOrderValue(position),
    captureOrderBasis: 'archive_acceptance',
  });
  touchSessionRemainder(store.db, sessionId, captureOrderValue(position), OLD);
  return sourceId;
}

function chunk(sessionId: string): string {
  return sealChunk(store.db, { sessionId, sourceIds: [source(sessionId)], sealedAt: OLD }).chunkId;
}

function context(): OperationContext {
  return {
    db: store.db,
    driver: {} as Driver,
    config: DEFAULTS,
    provider: refusingProvider,
    logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
    health: healthFixture(),
    narratives: {
      resolver: {} as EvidenceResolver,
      publications: {
        recover: seam.recover,
        hasPending: () => seam.pending,
      } as unknown as PublicationCoordinator,
    },
    now: NOW,
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  position = 0;
  vi.resetAllMocks();
  seam.pending = false;
  seam.recover.mockResolvedValue(undefined);
  seam.seal.mockImplementation((_deps: unknown, sessionId: string) => {
    const sourceIds = readRemainderMembers(store.db, sessionId, 24).map((row) => row.sourceId);
    const sealed = sealChunk(store.db, { sessionId, sourceIds, sealedAt: NOW });
    return {
      status: 'sealed',
      chunkId: sealed.chunkId,
      members: listChunkMembers(store.db, sealed.chunkId),
    };
  });
  seam.publish.mockImplementation((_deps: unknown, chunkId: string) => ({
    status: 'published',
    chunkId,
    revisionNo: 1,
    nodeId: `narrative-${chunkId}`,
    gaps: 0,
  }));
});

afterEach(() => {
  store.close();
});

it('does not spend every publication slot on newly sealed tails ahead of older due chunks', async () => {
  const old = chunk('older');
  source('new-tail');
  await narrativeSealOperation(SCALES).run(context());
  expect(seam.publish).toHaveBeenCalledTimes(1);
  expect(seam.publish.mock.calls[0]?.[1]).toBe(old);
});

it('does not begin fresh synthesis while prior publication recovery remains unavailable', async () => {
  chunk('owed');
  seam.pending = true;
  seam.recover.mockRejectedValue(new Error('pending publication cannot be read'));
  await narrativeSealOperation(SCALES).run(context());
  expect(seam.seal).not.toHaveBeenCalled();
  expect(seam.publish).not.toHaveBeenCalled();
});

it('reports an unverifiable head as held work rather than a standing complete head', async () => {
  chunk('unverifiable');
  seam.publish.mockResolvedValue({
    status: 'skipped',
    chunkId: 'unverifiable',
    reason: 'head_unverifiable',
  });
  const outcome = await narrativeSealOperation(SCALES).run(context());
  expect(outcome.detail).not.toContain('1 standing head(s)');
});

it('does not count a pre-synthesis coverage refusal as a provider call', async () => {
  chunk('coverage-refusal');
  seam.publish.mockResolvedValue({
    status: 'failed',
    chunkId: 'coverage-refusal',
    revisionNo: 0,
    reason: 'coverage coverage_registry_unreadable',
  });
  const outcome = await narrativeSealOperation(SCALES).run(context());
  expect(outcome.detail).toContain('0 reached synthesis');
});

it('control: without a fresh tail the oldest due chunk is selected', async () => {
  const old = chunk('old-control');
  chunk('new-control');
  await narrativeSealOperation(SCALES).run(context());
  expect(seam.publish.mock.calls[0]?.[1]).toBe(old);
});

it('control: prior recovery completes before a publication starts', async () => {
  chunk('recovered-control');
  const order: string[] = [];
  seam.recover.mockImplementation(async () => {
    order.push('recover');
  });
  seam.publish.mockImplementation(async () => {
    order.push('publish');
    return {
      status: 'published',
      chunkId: 'recovered-control',
      revisionNo: 1,
      nodeId: 'n',
      gaps: 0,
    };
  });
  await narrativeSealOperation(SCALES).run(context());
  expect(order).toEqual(['recover', 'publish']);
});
