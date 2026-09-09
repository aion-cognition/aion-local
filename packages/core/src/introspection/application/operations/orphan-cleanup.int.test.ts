import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orphanCleanupOperation, orphanCleanupRelevance } from './orphan-cleanup.js';
import { orphanRelinkOperationId, orphanSuppressionOperationId } from './orphan-suppression.js';
import { durableRoleScope } from '../../../evidence/domain/scopes.js';
import {
  commitIncidence,
  establishNodeState,
  establishNodeSupportScopes,
  establishScope,
} from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  BITEMPORAL_PROPERTIES,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { countOrphanNodes } from '../../../infrastructure/graph/introspection-health.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { relationshipTypesBetween } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import {
  findOrphanNodes,
  forgetOrphanNode,
} from '../../../infrastructure/graph/topology-queries.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../../../reflection/application/installed-publications.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { certifiedRelinkTarget, readOrphanCensus } from '../orphan-census.js';

/**
 * Four orphans, one per case the operation distinguishes:
 *
 * - a decision extracted from an episode that mentions an entity, so it has an entity to reach
 * - the insight that marks an episode enriched, which reaches nothing
 * - an insight with no edges at all whose support census has been established
 * - an insight with no edges whose support nobody has counted
 *
 * The episodes beside them are raw containers and are out of the population entirely: an episode
 * is what a source IS rather than an interpretation drawn from one, it hangs off the backbone by
 * construction, and the archive and the durable records are what account for it.
 *
 * The mentioned entity is not an orphan either. A mention is an association, and a node that
 * carries one is already attached to the layer activation traverses.
 *
 * The clock the forget measures is the qualification's, not the node's age: what the operation
 * suppresses is a node the records have certified unsupported CONTINUOUSLY, so the run that
 * first certifies one forgets nothing and a later run over an unchanged reading does.
 */

const EMBED_DIMENSION = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
/** A month past the first certification, which is what the qualification window measures. */
const MATURE = new Date('2026-10-05T14:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;
let coordinator: PublicationCoordinator;

const config: Config = DEFAULTS;

function context(now: Date = NOW): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    // A suppression is decided and written under one guard. Without it the operation declines,
    // which is a case of its own below.
    topology: coordinator,
    now,
    signal: new AbortController().signal,
  };
}

/**
 * The logical evidence a repair reads: one source standing behind both ends of the pair.
 *
 * The two-hop graph rules find a candidate; the records are what certify one. Seeding the edge
 * alone would prove the rule against the reading it is supposed to replace.
 */
function commitSharedSource(sourceId: string, nodeIds: readonly string[], at: Date): void {
  for (const nodeId of nodeIds) {
    commitIncidence(db, {
      sourceId,
      nodeId,
      role: 'mention',
      operationId: `incidence:${sourceId}:${nodeId}`,
      at,
    });
  }
}

/** A node the records have counted and nothing stands behind, with its graph state mirrored. */
function certifyEmpty(nodeId: string, at: Date): void {
  establishNodeSupportScopes(db, nodeId, at);
  establishNodeState(db, nodeId, { revision: 1, at });
}

async function seedSession(id: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Session',
    id,
    now,
    properties: { started_at: now.toISOString() },
  });
}

async function seedEpisode(id: string, sessionId: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now,
    properties: { text: `body of ${id}` },
  });
  await upsertEdge(harness.driver, {
    type: 'PARTICIPATES_IN',
    sourceId: id,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['structural'],
    provenance: ['test'],
    count: 0,
    now,
  });
}

/**
 * What makes an episode enriched as far as the graph is concerned: one node extracted from it.
 * The marker carries no other edge, so it neither hands the episode a relink candidate nor
 * hides one.
 */
async function markEnriched(episodeId: string, markerId: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id: markerId,
    now,
    properties: { text: `something learned from ${episodeId}` },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: markerId,
    targetId: episodeId,
    strength: 1,
    confidence: 1,
    signals: ['provenance'],
    provenance: ['test'],
    count: 0,
    now,
  });
}

async function seedLooseInsight(id: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id,
    now,
    properties: { text: `a thought with nothing attached to it: ${id}` },
  });
}

async function orphanIds(): Promise<string[]> {
  return (await findOrphanNodes(harness.driver, 100)).map((orphan) => orphan.id);
}

async function forgottenAt(id: string): Promise<Date | undefined> {
  const value = (await nodeProperties(harness.driver, id))[BITEMPORAL_PROPERTIES.forgottenAt];
  return value instanceof Date ? value : undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-orphan-cleanup-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedSession('shared-session', NOW);
  await seedEpisode('episode-with-sibling', 'shared-session', NOW);
  await seedEpisode('episode-sibling', 'shared-session', NOW);
  await markEnriched('episode-sibling', 'insight-from-sibling', NOW);

  // The entity route: an episode that mentions an entity, and a decision extracted from that
  // same episode. The decision itself has only its provenance edge, so it is an orphan whose
  // container can hand it an association.
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: 'entity-postgres',
    now: NOW,
    properties: { name: 'Postgres', name_norm: 'postgres', type: 'tool' },
  });
  await upsertEdge(harness.driver, {
    type: 'MENTIONS',
    sourceId: 'episode-with-sibling',
    targetId: 'entity-postgres',
    strength: 0.8,
    confidence: 0.8,
    signals: ['extraction'],
    provenance: ['test'],
    count: 3,
    now: NOW,
  });
  await writeStampedNode(harness.driver, {
    label: 'Decision',
    id: 'decision-orphan',
    now: NOW,
    properties: { text: 'we picked Postgres' },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: 'decision-orphan',
    targetId: 'episode-with-sibling',
    strength: 1,
    confidence: 1,
    signals: ['provenance'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });

  await seedLooseInsight('insight-ancient-alone', LONG_AGO);
  await seedLooseInsight('insight-recent-alone', NOW);
  await seedLooseInsight('insight-race', LONG_AGO);

  // Stored months ago and never enriched. Nothing was extracted from it, so it has only its
  // session link, and it belongs to the enrichment backlog rather than to this sweep.
  await seedSession('lonely-old-session', LONG_AGO);
  await seedEpisode('episode-unenriched-alone', 'lonely-old-session', LONG_AGO);

  coordinator = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
  });
  await coordinator.initialize();
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('orphan cleanup', () => {
  it('scores on demand a run could act on rather than on the share of the graph', () => {
    // A fragmented substrate with nothing actionable is worth no run at all: the share moves
    // with the shape of the graph and says nothing about whether there is work.
    const fragmented = healthFixture({
      graph: { ...healthFixture().graph, nodes: 100, orphanShare: 0.4, orphanActionable: 0 },
    });
    expect(orphanCleanupRelevance(fragmented)).toBe(0);

    const owed = healthFixture({
      graph: {
        ...healthFixture().graph,
        nodes: 100,
        orphanShare: 0.05,
        orphanActionable: 2,
        orphanCleanupBatch: 5,
      },
    });
    expect(orphanCleanupRelevance(owed)).toBeCloseTo(0.4);
  });

  it('leaves a raw container out of the count and out of the sweep', async () => {
    const before = await countOrphanNodes(harness.driver);
    expect(before.orphans).toBe(5);
    const ids = await orphanIds();
    expect(ids).not.toContain('episode-unenriched-alone');
    expect(ids).not.toContain('episode-with-sibling');
  });

  it('holds every node while nothing has counted the scopes its support would be in', async () => {
    const outcome = await orphanCleanupOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
    expect(await forgottenAt('insight-ancient-alone')).toBeUndefined();
  });

  it('relinks what it can reach and forgets only what has been certified all along', async () => {
    // Two of the five have their support counted. The others stay unknown, and unknown support
    // authorizes nothing: not a forget, and not a guessed edge either.
    certifyEmpty('insight-ancient-alone', NOW);
    establishNodeState(db, 'decision-orphan', { revision: 1, at: NOW });
    // The relink's own proof: a source the records say stands behind both ends of the pair. The
    // two-hop walk found the candidate; this is what certifies it.
    commitSharedSource('prov-source', ['decision-orphan', 'entity-postgres'], NOW);

    // The first run certifies and starts the window. Nothing is mature yet, so the only thing
    // it can act on is the relink.
    const first = await orphanCleanupOperation().run(context());
    expect(first.status).toBe('applied');
    expect(
      await relationshipTypesBetween(harness.driver, 'decision-orphan', 'entity-postgres'),
    ).toContain('RELATED_TO');
    expect(await forgottenAt('insight-ancient-alone')).toBeUndefined();

    // A month later the same reading still holds, which is what the window measures.
    const outcome = await orphanCleanupOperation().run(context(MATURE));

    expect(outcome.status).toBe('applied');
    expect(await forgottenAt('insight-ancient-alone')).toBeInstanceOf(Date);
    // Uncounted support, so the run leaves it exactly where it is however old it gets.
    expect(await forgottenAt('insight-recent-alone')).toBeUndefined();
    expect(await forgottenAt('episode-unenriched-alone')).toBeUndefined();
  });

  it('refuses a repair edge whose shared source closed after the census certified it', async () => {
    await seedLooseInsight('insight-relink-race', LONG_AGO);
    await seedLooseInsight('entity-relink-race', LONG_AGO);
    certifyEmpty('insight-relink-race', NOW);
    commitSharedSource('relink-race-source', ['insight-relink-race', 'entity-relink-race'], NOW);
    // The pair certifies here, which is what the census would nominate on.
    expect(
      certifiedRelinkTarget(db, 'insight-relink-race', {
        orphanId: 'insight-relink-race',
        targetId: 'entity-relink-race',
        kind: 'same_container',
      }),
    ).toBeDefined();
    // Then the source ends its incidence, which is what the guard is between.
    db.prepare("UPDATE source_incidence SET currency='closed' WHERE source_id=?").run(
      'relink-race-source',
    );

    const outcome = await coordinator.publish({
      kind: 'topology_update',
      operationId: orphanRelinkOperationId('insight-relink-race', 'entity-relink-race', MATURE),
      payload: {
        mode: 'relink',
        orphanId: 'insight-relink-race',
        targetId: 'entity-relink-race',
        relinkKind: 'same_container',
      },
    });

    expect(outcome).toMatchObject({ status: 'deferred', reason: 'relink_proof_moved' });
    expect(
      await relationshipTypesBetween(harness.driver, 'insight-relink-race', 'entity-relink-race'),
    ).not.toContain('RELATED_TO');
  });

  it('refuses a suppression whose evidence moved after the qualification was taken', async () => {
    certifyEmpty('insight-race', NOW);
    // The census qualifies it against what the records said then.
    await readOrphanCensus(
      { driver: harness.driver, db },
      {
        limit: 50,
        now: NOW,
        forgetAfterDays: config.maintenance.orphanForgetAfterDays,
        policyRevision: 0,
      },
    );
    // Then one of the scopes it rested on moves, which is exactly the window the guard fences:
    // rechecking a graph disconnection predicate would not see this at all.
    establishScope(db, 'insight-race', durableRoleScope('mention', 'in'), MATURE);

    const outcome = await coordinator.publish({
      kind: 'topology_update',
      operationId: orphanSuppressionOperationId('insight-race', MATURE),
      payload: {
        nodeId: 'insight-race',
        policyRevision: 0,
        forgetBefore: new Date(MATURE.getTime() - DAY_MS).toISOString(),
      },
    });

    expect(outcome).toMatchObject({ status: 'deferred', reason: 'evidence_moved' });
    expect(await forgottenAt('insight-race')).toBeUndefined();
  });

  it('does not forget a node that stopped being an orphan since the scan read it', async () => {
    // The write re-derives the orphan test, so an association landing between the scan and the
    // forget saves the node. Nothing reopens a forget, so the decision has to be made at the
    // write and not at the read.
    await seedLooseInsight('insight-ancient-rescued', LONG_AGO);
    expect(await orphanIds()).toContain('insight-ancient-rescued');

    await upsertEdge(harness.driver, {
      type: 'RELATED_TO',
      sourceId: 'insight-ancient-rescued',
      targetId: 'entity-postgres',
      strength: 0.5,
      confidence: 0.5,
      signals: ['episodic'],
      provenance: ['test'],
      count: 1,
      now: NOW,
    });
    const rescued = await forgetOrphanNode(harness.driver, {
      id: 'insight-ancient-rescued',
      forgetBefore: NOW,
      now: NOW,
    });

    expect(rescued).toBe(false);
    expect(await forgottenAt('insight-ancient-rescued')).toBeUndefined();
  });

  it('finds nothing left to repair on a later run over the same substrate', async () => {
    const outcome = await orphanCleanupOperation().run(context(MATURE));

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
  });

  it('declines a mature candidate outright when no guard is composed to publish under', async () => {
    await seedLooseInsight('insight-unguarded', LONG_AGO);
    certifyEmpty('insight-unguarded', NOW);
    // The window starts here, so by MATURE the only thing between this node and a stamp is the
    // guard. A control that qualified its candidate on the same pass it ran would prove nothing:
    // a node whose window has not matured is held for a reason that has nothing to do with the
    // publisher.
    await readOrphanCensus(
      { driver: harness.driver, db },
      {
        limit: 50,
        now: NOW,
        forgetAfterDays: config.maintenance.orphanForgetAfterDays,
        policyRevision: 0,
      },
    );
    const mature = await readOrphanCensus(
      { driver: harness.driver, db },
      {
        limit: 50,
        now: MATURE,
        forgetAfterDays: config.maintenance.orphanForgetAfterDays,
        policyRevision: 0,
      },
    );
    expect(
      mature.entries.find((entry) => entry.nodeId === 'insight-unguarded')?.decision.action,
    ).toBe('forget');

    const unguarded: OperationContext = { ...context(MATURE), topology: undefined };
    const outcome = await orphanCleanupOperation().run(unguarded);

    expect(outcome.itemsAffected).toBe(0);
    expect(await forgottenAt('insight-unguarded')).toBeUndefined();
  });
});
