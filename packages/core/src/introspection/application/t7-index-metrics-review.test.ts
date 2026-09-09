import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { recallProbeOperation } from './operations/recall-probe.js';
import { runSourceIndexJob } from './source-index.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { idAddress } from '../../evidence/domain/address.js';
import { evidenceResult } from '../../evidence/domain/result.js';
import {
  seedSource,
  commitIncidence,
  commitSourceState,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  allocateNarrativeRevision,
  publishNarrativeRevision,
  OVERVIEW_REVISION_FAMILY,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import {
  relatedIncidenceNodes,
  servedReferenceOutcome,
} from '../../infrastructure/sqlite/probe-incidence.js';
import {
  activateProcessingGeneration,
  listOutstandingWork,
  completeSourceWork,
} from '../../infrastructure/sqlite/processing-generations.js';
import { recallProbeReadingV2 } from '../../infrastructure/sqlite/recall-probe-counters.js';
import {
  listEvidenceAcknowledgments,
  SOURCE_INDEX_EFFECT,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { enqueueSourceWork } from '../../reflection/application/intake-queue.js';
import type { OperationContext } from '../domain/operation.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

const START = new Date('2026-09-01T10:00:00.000Z');
const SERVED = new Date('2026-09-04T10:00:00.000Z');
const NOW = new Date('2026-09-08T10:00:00.000Z');
let dir: string;
let store: SqliteStore;
const logger = { warn: () => undefined, debug: () => undefined };
const driver = { executeQuery: async () => ({ records: [] }) } as unknown as Driver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-index-metric-review-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: START, fieldPolicyVersion: 1 });
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    now: START,
    content: {
      turns: [
        { role: 'user', text: 'needle one' },
        { role: 'assistant', text: 'needle two' },
      ],
    },
    turnIds: ['a', 'b'],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('does not score chunk membership as source-related retrieval', () => {
  commitIncidence(store.db, {
    sourceId: 'source',
    nodeId: 'narrative',
    role: 'source_coverage',
    operationId: 'membership',
    at: START,
  });
  expect(relatedIncidenceNodes(store.db, 'source', ['narrative'])).toEqual([]);
});

it('credits a published actual citation independently of coverage membership', () => {
  const revision = allocateNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, 'family', START);
  store.db
    .transaction(() => {
      commitSourceState(store.db, {
        sourceId: 'source',
        stateKind: 'unforgotten',
        operationId: 'publish',
        at: START,
      });
      publishNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, {
        familyKey: 'family',
        revisionNo: revision.revisionNo,
        operationId: 'publish',
        evidenceRevisionJson: '{}',
        knownFrom: START.toISOString(),
        observedAckAt: START.toISOString(),
        publishedAt: START,
      });
      store.db
        .prepare(
          'INSERT INTO revision_citations(narrative_node_id,target_id,target_kind) VALUES (?,?,?)',
        )
        .run(revision.nodeId, 'source', 'source');
    })
    .immediate();
  establishScope(store.db, revision.nodeId, 'sqlite.revision_citations', START);
  expect(relatedIncidenceNodes(store.db, 'source', [revision.nodeId])).toEqual([revision.nodeId]);
});

it('does not credit closing an old reference as a new reference after serve', () => {
  commitIncidence(store.db, {
    sourceId: 'source',
    nodeId: 'item',
    role: 'mention',
    operationId: 'mention',
    at: START,
  });
  expect(servedReferenceOutcome(store.db, 'item', SERVED.toISOString())).toBe('none');
  store.db
    .transaction(() => {
      commitSourceState(store.db, {
        sourceId: 'source',
        stateKind: 'unforgotten',
        operationId: 'close',
        at: NOW,
      });
      store.db
        .prepare(
          "INSERT INTO evidence_link_versions(link_id,version,prev_version,state,recorded_values_json,temporal_proof_json,observed_at,operation_key,operation_id,known_from,observed_ack_at) VALUES (?,2,1,'closed',?,'{}',?,'close','close',?,?)",
        )
        .run(
          'source:item:mention',
          JSON.stringify({
            currency: 'closed',
            valid_until: NOW.toISOString(),
            tx_until: NOW.toISOString(),
          }),
          NOW.toISOString(),
          NOW.toISOString(),
          NOW.toISOString(),
        );
      store.db
        .prepare(
          "UPDATE source_incidence SET currency='closed',link_version=2 WHERE node_id='item'",
        )
        .run();
    })
    .immediate();
  expect(servedReferenceOutcome(store.db, 'item', SERVED.toISOString())).toBe('none');
});

it('does not settle indexing from a resolver result that lacks required proof', async () => {
  enqueueSourceWork(
    store.db,
    {
      sourceId: 'source',
      sessionId: 'session',
      lane: null,
      indexPolicy: 'index:1',
      acceptedAt: START.toISOString(),
    },
    'enqueue',
  );
  const resolver = new EvidenceResolver({ db: store.db, driver, logger });
  const real = resolver.resolveSources.bind(resolver);
  vi.spyOn(resolver, 'resolveSources').mockImplementation(async (...args) => {
    const batch = await real(...args);
    const issue = {
      address: idAddress('source'),
      field: 'source_content' as const,
      reason: 'unresolved_mapping' as const,
      required: true,
    };
    return {
      ...batch,
      issues: [...batch.issues, issue],
      results: new Map(
        [...batch.results].map(([key, result]) => [
          key,
          evidenceResult({
            address: result.address,
            residency: result.residency,
            issues: [issue],
            ...(result.value === undefined ? {} : { value: result.value }),
          }),
        ]),
      ),
    };
  });
  const outcome = await runSourceIndexJob(
    { db: store.db, resolver, now: () => NOW, logger },
    { sourceId: 'source' },
  );
  expect.soft(outcome.status === 'indexed' && outcome.complete).toBe(false);
  const acknowledgments = listEvidenceAcknowledgments(store.db, 'source').filter(
    (row) => row.effectKind === SOURCE_INDEX_EFFECT,
  );
  expect(acknowledgments.map((row) => row.state)).toEqual(['owed']);
});

it('counts an archive-read failure as unavailable rather than a source with no words', async () => {
  activateProcessingGeneration(store.db, 'source', 1);
  for (const work of listOutstandingWork(store.db, NOW, 100)) {
    completeSourceWork(
      store.db,
      work.workId,
      { outcome: 'complete', reason: 'fixture readiness' },
      NOW,
    );
  }
  const recallProbe = vi.fn(async () => {
    throw new Error('an unavailable source cannot be queried');
  });
  const context: OperationContext = {
    driver,
    db: store.db,
    logger: pino({ enabled: false }),
    provider: { embed: async () => [], generate: async () => ({}) },
    config: {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, recallProbe: true, recallProbeSample: 1 },
    },
    now: NOW,
    signal: new AbortController().signal,
    health: healthFixture(),
    recallProbe,
  };
  store.db.exec('ALTER TABLE experience_archive RENAME TO experience_archive_review');
  try {
    await recallProbeOperation().run(context);
    const counters = recallProbeReadingV2(store.db);
    expect.soft(counters.unavailable).toBe(1);
    expect.soft(counters.ineligible).toBe(0);
    expect(recallProbe).not.toHaveBeenCalled();
  } finally {
    store.db.exec('ALTER TABLE experience_archive_review RENAME TO experience_archive');
  }
});

it('keeps each source resume position when another source finishes between its batches', async () => {
  seedSource(store.db, {
    sourceId: 'large',
    sessionId: 'session',
    identity: 'review',
    now: START,
    content: {
      turns: Array.from({ length: 101 }, (_, n) => ({
        role: 'user' as const,
        text: `word ${String(n)}`,
      })),
    },
    turnIds: Array.from({ length: 101 }, (_, n) => `large-${String(n)}`),
  });
  const resolver = new EvidenceResolver({ db: store.db, driver, logger });
  const deps = { db: store.db, resolver, now: () => NOW, logger };
  const first = await runSourceIndexJob(deps, { sourceId: 'large' });
  expect(first).toMatchObject({ status: 'indexed', documents: 100, complete: false });
  await runSourceIndexJob(deps, { sourceId: 'source' });
  const resumed = await runSourceIndexJob(deps, { sourceId: 'large' });
  expect(resumed).toMatchObject({ status: 'indexed', documents: 1, complete: true });
});
