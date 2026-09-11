import { afterEach, expect, it, vi } from 'vitest';

import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import * as compression from './narrative-compress.js';
import { runNarrativeMigrationBatch } from './narrative-migration.js';
import { closeSessionNarrative } from './narratives.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import { readNarrativeRepresentations } from '../../evidence/application/narrative-representation.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { evidenceRequestKey, idAddress } from '../../evidence/domain/address.js';
import { RequestBudget } from '../../evidence/domain/budget.js';
import { checkedContext } from '../../evidence/test-support/evidence.fixture.js';
import {
  seedLegacyFamilyVersion,
  legacyFamilySnapshot,
} from '../../infrastructure/graph/test-support/family-cutover.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readLegacyNarrative } from '../../infrastructure/sqlite/legacy-narratives.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });

afterEach(() => {
  vi.restoreAllMocks();
});

it('publishes legacy growth with durable coverage and canonical knowledge visibility', async () => {
  const first = await acceptSource('legacy-publish', 'first captured source', false);
  const sessionId = sessionOf(first);
  const oldId = 'legacy-before-growth';
  await seedLegacyFamilyVersion(driver, { nodeId: oldId, sessionId, sources: [first], now: NOW });
  const second = await acceptSource('legacy-publish', 'second captured source', false);
  vi.spyOn(compression, 'compress').mockImplementation(async (_deps, _settings, episodes) => ({
    output: {
      summary: 'Both captures were considered.',
      narrative: 'Both captures were considered.',
      citations: episodes.map((row) => row.id),
      kept: 1,
      dropped: 0,
    },
    source: { text: '', items: [], renderedCount: episodes.length, coverage: 1, sentenceBudget: 1 },
  }));
  let clock = new Date(NOW.getTime() + 1000);
  const publications = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => clock,
    boundary: ({ boundary, operationId }) => {
      if (boundary === 'before_ack' && operationId.startsWith('legacy-narrative:')) {
        clock = new Date(NOW.getTime() + 5000);
      }
    },
  });
  await publications.initialize();
  const result = await closeSessionNarrative({ ...chunks, logger, publications }, sessionId, {
    now: NOW,
  });
  expect(result.status).toBe('created');
  expect(result.narrativeId).toBeDefined();
  const nodeId = result.narrativeId!;
  expect(readLegacyNarrative(store.db, nodeId)?.publication?.knownFrom).toBe(clock.toISOString());
  const rows = store.db
    .prepare(
      `SELECT source_id, currency FROM source_incidence WHERE node_id = ? AND role = 'source_coverage' ORDER BY source_id`,
    )
    .all(nodeId);
  expect(rows).toEqual(
    [first, second].sort().map((source_id) => ({ source_id, currency: 'open' })),
  );
  expect(
    store.db
      .prepare(
        "SELECT currency FROM source_incidence WHERE source_id = ? AND node_id = ? AND role = 'source_coverage'",
      )
      .get(first, oldId),
  ).toEqual({ currency: 'closed' });
  expect(publications.hasPending()).toBe(false);
  const resolver = new EvidenceResolver({ driver, db: store.db, publications, logger });
  const view = await resolver.resolveMetadata(
    [nodeId],
    checkedContext({ now: clock, mode: { knownAt: new Date(NOW.getTime() + 3000) } }),
    { maxRoots: 16 },
  );
  expect(view.results.get(evidenceRequestKey(idAddress(nodeId)))?.value).toBeUndefined();
  expect(view.issues.some((issue) => issue.reason === 'not_found')).toBe(true);
});

it('rejects a delayed legacy synthesis after cutover and dispatches the current family', async () => {
  const sourceId = await acceptSource(
    'legacy-delayed',
    'the source under the delayed model',
    false,
  );
  const sessionId = sessionOf(sourceId);
  const oldId = 'legacy-delayed-overview';
  await seedLegacyFamilyVersion(driver, {
    nodeId: oldId,
    sessionId,
    sources: [sourceId],
    now: NOW,
  });
  let announce!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(compression, 'compress').mockImplementation(async (_deps, _settings, episodes) => {
    expect(store.db.inTransaction).toBe(false);
    announce();
    await held;
    return {
      output: {
        summary: 'This stale output must not publish.',
        narrative: 'This stale output must not publish.',
        citations: episodes.map((row) => row.id),
        kept: 1,
        dropped: 0,
      },
      source: {
        text: '',
        items: [],
        renderedCount: episodes.length,
        coverage: 1,
        sentenceBudget: 1,
      },
    };
  });
  const delayed = closeSessionNarrative({ ...chunks, logger }, sessionId, {
    now: NOW,
    regenerate: true,
  });
  await entered;
  try {
    const options = {
      cohortId: 'legacy-delayed-migration',
      now: NOW,
      steps: 128,
      betweenStepsMs: 60_000,
      policy: { ...CHUNK_BOUNDARY_POLICY, partitionPolicyVersion: 1 },
    };
    let migration = await runNarrativeMigrationBatch(chunks, options);
    for (let run = 0; run < 10 && !migration.complete; run += 1) {
      migration = await runNarrativeMigrationBatch(chunks, options);
    }
    expect(migration.complete, JSON.stringify(migration)).toBe(true);
  } finally {
    resume();
  }
  expect((await delayed).status).toBe('skipped');
  const old = await legacyFamilySnapshot(driver, oldId);
  expect((old.properties as Record<string, unknown>).text).toBe(
    'The original whole-session narrative.',
  );
  expect(old.supersession_edges).toBe(0);
  expect(chunks.publications.hasPending()).toBe(false);
});

it('withholds a newly graph-committed legacy publication until its canonical birth is acknowledged', async () => {
  const sourceId = await acceptSource(
    'legacy-birth-gap',
    'an original source for the birth gap',
    false,
  );
  const sessionId = sessionOf(sourceId);
  await seedLegacyFamilyVersion(driver, {
    nodeId: 'legacy-birth-predecessor',
    sessionId,
    sources: [sourceId],
    now: NOW,
  });
  vi.spyOn(compression, 'compress').mockImplementation(async (_deps, _settings, episodes) => ({
    output: {
      summary: 'A new version.',
      narrative: 'A new version.',
      citations: episodes.map((row) => row.id),
      kept: 1,
      dropped: 0,
    },
    source: { text: '', items: [], renderedCount: episodes.length, coverage: 1, sentenceBudget: 1 },
  }));
  let interruptedOperation: string | undefined;
  const publications = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => NOW,
    boundary: ({ boundary, operationId }) => {
      if (boundary === 'before_ack' && operationId.startsWith('legacy-narrative:')) {
        interruptedOperation = operationId;
        throw new Error('stop before canonical birth');
      }
    },
  });
  await publications.initialize();
  await expect(
    closeSessionNarrative({ ...chunks, logger, publications }, sessionId, {
      now: NOW,
      regenerate: true,
    }),
  ).rejects.toThrow();
  const prepared = store.db
    .prepare('SELECT payload_json FROM publication_intents WHERE operation_id = ?')
    .get(interruptedOperation) as { payload_json: string };
  const { nodeId } = JSON.parse(prepared.payload_json) as { nodeId: string };
  expect(readLegacyNarrative(store.db, nodeId)?.publication).toBeUndefined();
  const reading = await readNarrativeRepresentations(
    { driver, db: store.db },
    [nodeId],
    checkedContext({ now: NOW }),
    new RequestBudget(),
  );
  expect(reading.values.get(nodeId)).toMatchObject({
    selection: 'selected',
    publication: 'unknown',
  });
  expect(reading.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'narrative_revision',
        reason: 'unverified_scope',
        required: true,
      }),
    ]),
  );
  const recovery = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => NOW,
  });
  await recovery.initialize();
  expect((await recovery.recover())?.status).toBe('acknowledged');
  const after = await readNarrativeRepresentations(
    { driver, db: store.db },
    [nodeId],
    checkedContext({ now: NOW }),
    new RequestBudget(),
  );
  expect(after.values.get(nodeId)).toMatchObject({
    selection: 'selected',
    publication: 'established',
  });
});
