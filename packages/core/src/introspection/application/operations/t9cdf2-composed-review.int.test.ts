import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { claimDedupOperation } from './claim-dedup.js';
import { CoveredJudgmentEvidence } from '../../../evidence/application/covered-judgment.js';
import type { MergePublisher } from '../../../evidence/application/merge-recovery.js';
import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import {
  commitIncidence,
  establishNodeState,
  establishScope,
  seedSource,
} from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { claimMergePublication } from '../../../reflection/application/merge-publication.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

const NOW = new Date('2026-01-02T12:00:00.000Z');
let sub: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let evidence: CoveredJudgmentEvidence;
let logger: Logger;
let dir: string;
let claims: string[];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-composed-judgment-'));
  sub = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: sub.sqlitePath });
  await runGraphMigrations(sub.harness.driver, store.db, { embedDimension: 3 });
  logger = openLogger({ filePath: join(dir, 'test.log'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: sub.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, claimMergePublication],
  });
  await coordinator.initialize();
  claims = [];
  for (const [i, text] of [
    'we use Postgres for the ledger',
    'the ledger runs on Postgres',
  ].entries()) {
    const sourceId = `source-${String(i)}`;
    seedSource(store.db, {
      sourceId,
      sessionId: 'session',
      identity: 'review',
      content: { observations: [text] },
      now: NOW,
    });
    establishScope(store.db, sourceId, 'source.state', NOW);
    establishScope(store.db, sourceId, 'sqlite:mention:out', NOW);
    await writeStampedNode(sub.harness.driver, {
      label: 'Episode',
      id: sourceId,
      now: NOW,
      properties: { text },
    });
    const claim = await writeCognitiveNode(sub.harness.driver, {
      episodeId: sourceId,
      label: 'Concept',
      text,
      contentVector: i === 0 ? [1, 0, 0] : [0.99, 0.02, 0],
      occurredAt: new Date(NOW.getTime() - 60000 * (2 - i)),
      now: NOW,
    });
    const { id } = claim.node;
    claims.push(id);
    commitIncidence(store.db, {
      sourceId,
      nodeId: id,
      role: 'extraction',
      operationId: `extract-${String(i)}`,
      at: NOW,
    });
    establishScope(store.db, id, 'sqlite:extraction:out', NOW);
    establishScope(store.db, id, 'sqlite:stated_correction:in', NOW);
    establishNodeState(store.db, id, { revision: 1, at: NOW });
  }
  evidence = new CoveredJudgmentEvidence({
    db: store.db,
    resolver: new EvidenceResolver({
      driver: sub.harness.driver,
      db: store.db,
      logger,
      publications: coordinator,
    }),
    now: () => NOW,
  });
}, 120000);
afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(sub);
  rmSync(dir, { recursive: true, force: true });
});
it('judges and publishes a merge through the composed resolver and real stores', async () => {
  const assembled = await evidence.assemble({
    route: 'claim_dedup',
    reservedUnits: 0,
    use: 'claim_judgment',
    sides: [
      { nodeId: claims[0]!, statement: 'we use Postgres for the ledger' },
      { nodeId: claims[1]!, statement: 'the ledger runs on Postgres' },
    ],
  });
  expect(assembled.status, JSON.stringify(assembled)).toBe('assembled');
  let generated = 0;
  const provider = {
    embed: () => Promise.reject(new Error('no embedding service in this fixture')),
    generate: () => {
      generated += 1;
      return Promise.resolve(
        generated === 1
          ? { same: true, rationale: 'same proposition' }
          : { either_adds_information: false, reason: 'same scope' },
      );
    },
  };
  const result = await claimDedupOperation().run({
    driver: sub.harness.driver,
    db: store.db,
    logger,
    provider,
    config: DEFAULTS,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    publications: coordinator,
    evidence,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied', itemsAffected: 1 });
  expect(generated).toBe(2);
  expect((await nodeProperties(sub.harness.driver, claims[1]!)).valid_until).toBeDefined();
});

it('does not publish a judgment after its checked coverage epoch changes', async () => {
  const extra: string[] = [];
  for (const [i, text] of [
    'we use Kafka for the event log',
    'the event log runs on Kafka',
  ].entries()) {
    const sourceId = `epoch-source-${String(i)}`;
    seedSource(store.db, {
      sourceId,
      sessionId: 'epoch-session',
      identity: 'review',
      content: { observations: [text] },
      now: NOW,
    });
    establishScope(store.db, sourceId, 'source.state', NOW);
    establishScope(store.db, sourceId, 'sqlite:mention:out', NOW);
    await writeStampedNode(sub.harness.driver, {
      label: 'Episode',
      id: sourceId,
      now: NOW,
      properties: { text },
    });
    const claim = await writeCognitiveNode(sub.harness.driver, {
      episodeId: sourceId,
      label: 'Concept',
      text,
      contentVector: i === 0 ? [0, 1, 0] : [0, 0.99, 0.02],
      occurredAt: new Date(NOW.getTime() - 60000 * (2 - i)),
      now: NOW,
    });
    extra.push(claim.node.id);
    commitIncidence(store.db, {
      sourceId,
      nodeId: claim.node.id,
      role: 'extraction',
      operationId: `epoch-extract-${String(i)}`,
      at: NOW,
    });
    establishScope(store.db, claim.node.id, 'sqlite:extraction:out', NOW);
    establishScope(store.db, claim.node.id, 'sqlite:stated_correction:in', NOW);
    establishNodeState(store.db, claim.node.id, { revision: 1, at: NOW });
  }
  const before = readCurrentCoverageContract(store.db)!;
  store.db.prepare('UPDATE publication_control SET activation_capability_revision=1').run();
  let generated = 0;
  const provider = {
    embed: () => Promise.reject(new Error('no embedding')),
    generate: async () => {
      generated += 1;
      if (generated === 1) {
        const activation = await coordinator.publish({
          kind: 'coverage_activation',
          operationId: 'activate-during-judgment',
          payload: { expectedEpoch: before.epoch, capabilityRevision: 1, fieldPolicyVersion: 1 },
        });
        expect(activation.status).toBe('acknowledged');
      }
      return generated === 1
        ? { same: true, rationale: 'same proposition' }
        : { either_adds_information: false, reason: 'same scope' };
    },
  };
  const result = await claimDedupOperation().run({
    driver: sub.harness.driver,
    db: store.db,
    logger,
    provider,
    config: DEFAULTS,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    publications: coordinator,
    evidence,
  });
  expect(readCurrentCoverageContract(store.db)?.epoch).not.toBe(before.epoch);
  expect(result.itemsAffected, JSON.stringify(result)).toBe(0);
  expect((await nodeProperties(sub.harness.driver, extra[1]!)).valid_until).toBeUndefined();
});

it('does not replace the checked epoch with the epoch read during publication prepare', async () => {
  const pair: string[] = [];
  for (const [i, text] of [
    'Redis caches the session tokens',
    'session tokens are cached in Redis',
  ].entries()) {
    const sourceId = `publication-epoch-source-${String(i)}`;
    seedSource(store.db, {
      sourceId,
      sessionId: 'publication-session',
      identity: 'review',
      content: { observations: [text] },
      now: NOW,
    });
    establishScope(store.db, sourceId, 'source.state', NOW);
    establishScope(store.db, sourceId, 'sqlite:mention:out', NOW);
    await writeStampedNode(sub.harness.driver, {
      label: 'Episode',
      id: sourceId,
      now: NOW,
      properties: { text },
    });
    const claim = await writeCognitiveNode(sub.harness.driver, {
      episodeId: sourceId,
      label: 'Concept',
      text,
      contentVector: i === 0 ? [0, 0, 1] : [0.02, 0, 0.99],
      occurredAt: new Date(NOW.getTime() - 60000 * (2 - i)),
      now: NOW,
    });
    pair.push(claim.node.id);
    commitIncidence(store.db, {
      sourceId,
      nodeId: claim.node.id,
      role: 'extraction',
      operationId: `publication-extract-${String(i)}`,
      at: NOW,
    });
    establishScope(store.db, claim.node.id, 'sqlite:extraction:out', NOW);
    establishScope(store.db, claim.node.id, 'sqlite:stated_correction:in', NOW);
    establishNodeState(store.db, claim.node.id, { revision: 1, at: NOW });
  }
  const { epoch } = readCurrentCoverageContract(store.db)!;
  let activated = false;
  const publisher: MergePublisher = {
    hasPending: () => coordinator.hasPending(),
    recover: () => coordinator.recover(),
    outcomeOf: (id) => coordinator.outcomeOf(id),
    publish: async (request) => {
      const outcome = await coordinator.publish({
        kind: 'coverage_activation',
        operationId: 'activate-before-merge-prepare',
        payload: { expectedEpoch: epoch, capabilityRevision: 1, fieldPolicyVersion: 1 },
      });
      expect(outcome.status).toBe('acknowledged');
      activated = true;
      return coordinator.publish(request);
    },
  };
  let generated = 0;
  const provider = {
    embed: () => Promise.reject(new Error('no embedding')),
    generate: async () => {
      generated += 1;
      return generated === 1
        ? { same: true, rationale: 'same proposition' }
        : { either_adds_information: false, reason: 'same scope' };
    },
  };
  const result = await claimDedupOperation().run({
    driver: sub.harness.driver,
    db: store.db,
    logger,
    provider,
    config: DEFAULTS,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    publications: publisher,
    evidence,
  });
  expect(activated).toBe(true);
  expect(result.itemsAffected, JSON.stringify(result)).toBe(0);
  expect((await nodeProperties(sub.harness.driver, pair[1]!)).valid_until).toBeUndefined();
});
