import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { narrativeCleanupOperation } from './narrative-cleanup-operation.js';
import type { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  BITEMPORAL_PROPERTIES,
  supersede,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  findDuplicateChunkFamilies,
  findOrphanedNarratives,
} from '../../../infrastructure/graph/narrative-cleanup-queries.js';
import { countNarrativeEdges } from '../../../infrastructure/graph/narrative-edge-queries.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../../infrastructure/graph/narrative-queries.js';
import {
  countNodesWithId,
  edgeValidUntil,
  nodeProperties,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../../infrastructure/publication/types.js';
import { sealChunk } from '../../../infrastructure/sqlite/chunk-manifest.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  publishNarrativeRevision,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import { recordSourceRecord } from '../../../infrastructure/sqlite/source-identity.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../../../reflection/application/installed-publications.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Seeds nodes directly at the graph level rather than through the full session/reflection
 * pipeline: the operation under test reads narrative and session structure only, and the
 * pathologies it repairs (a crash-orphaned duplicate, a session with nothing left to ground
 * it) are states the ordinary write path does not produce on its own.
 */

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let coordinator: PublicationCoordinator;
/** The boundary this run interrupts once, for the crash-recovery case. */
let failAt: PublicationBoundary | undefined;

const NOW = new Date('2026-08-29T12:00:00.000Z');

function configWith(narrativeEdgeRepairBatch: number): Config {
  return {
    ...DEFAULTS,
    maintenance: {
      ...DEFAULTS.maintenance,
      narrativeCleanupBatch: 50,
      narrativeEdgeRepairBatch,
    },
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-narrative-cleanup-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  // The real coordinator, over the whole installed set: the repair is a semantic write and the
  // guard is what serializes it against the publication path it repairs after.
  coordinator = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error(`interrupted at ${boundary}`);
      }
    },
  });
  await coordinator.initialize();
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function seedSession(id: string): Promise<void> {
  await writeStampedNode(harness.driver, { label: 'Session', id, now: NOW, properties: {} });
}

async function seedEpisode(id: string, sessionId: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { [MEMORY_PROPERTIES.text]: 'an episode' },
  });
  await upsertEdge(harness.driver, {
    type: CONTAINMENT_TYPE,
    sourceId: id,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['structural'],
    provenance: ['test-seed'],
    count: 0,
    now: NOW,
  });
}

/**
 * A chunk revision as the publication writes it: the family key and the revision number the
 * manifest allocated, on an open node derived from its session.
 */
async function seedChunkRevisionNode(
  id: string,
  sessionId: string,
  chunkId: string,
  revisionNo: number,
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Narrative',
    id,
    now: NOW,
    properties: {
      [MEMORY_PROPERTIES.text]: `chunk revision ${String(revisionNo)}`,
      [NARRATIVE_PROPERTIES.family]: 'chunk',
      [NARRATIVE_PROPERTIES.chunkId]: chunkId,
      [NARRATIVE_PROPERTIES.revisionNo]: revisionNo,
      [NARRATIVE_PROPERTIES.version]: revisionNo,
      [NARRATIVE_PROPERTIES.coverageKey]: chunkId,
      [NARRATIVE_PROPERTIES.coverageCount]: 1,
    },
  });
  await upsertEdge(harness.driver, {
    type: DERIVES_FROM_TYPE,
    sourceId: id,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['compression'],
    provenance: ['test-seed'],
    count: 0,
    now: NOW,
  });
}

/** One sealed chunk over one source, in the manifest, with no revision published yet. */
function sealOneSourceChunk(sessionId: string, sourceId: string): string {
  recordSourceRecord(db, {
    sourceId,
    sessionId,
    verificationStatus: 'verified',
    archive: {
      canonicalArchiveId: `archive-${sourceId}`,
      archiveSchemaVersion: 1,
      identityHash: `identity-${sourceId}`,
      verifiedContentDigest: `digest-${sourceId}`,
      verificationPolicyVersion: 1,
      archivedAt: NOW.toISOString(),
    },
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
  });
  return sealChunk(db, { sessionId, sourceIds: [sourceId], sealedAt: NOW }).chunkId;
}

/** Allocates and publishes the next revision of a chunk, answering the node id it minted. */
function publishRevision(chunkId: string): string {
  const allocation = allocateNarrativeRevision(db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  publishNarrativeRevision(db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: allocation.revisionNo,
    operationId: `op-${chunkId}-${String(allocation.revisionNo)}`,
    evidenceRevisionJson: '{"dependencies":[]}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  return allocation.nodeId;
}

async function seedNarrative(
  id: string,
  sessionId: string,
  version: number,
  coverageCount: number,
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Narrative',
    id,
    now: NOW,
    properties: {
      [MEMORY_PROPERTIES.text]: `narrative v${String(version)}`,
      [NARRATIVE_PROPERTIES.version]: version,
      [NARRATIVE_PROPERTIES.coverageCount]: coverageCount,
      [NARRATIVE_PROPERTIES.coverageKey]: `key-${String(version)}`,
    },
  });
  await upsertEdge(harness.driver, {
    type: DERIVES_FROM_TYPE,
    sourceId: id,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['compression'],
    provenance: ['test-seed'],
    count: 0,
    now: NOW,
  });
}

/** One `(episode)-[:SUMMARIZED_BY]->(narrative)` edge, the shape a session close writes. */
async function summarize(episodeId: string, narrativeId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: SUMMARIZED_BY_TYPE,
    sourceId: episodeId,
    targetId: narrativeId,
    strength: 1,
    confidence: 1,
    signals: ['compression'],
    provenance: ['test-seed'],
    count: 0,
    now: NOW,
  });
}

/** Closes the node alone, which is the state every supersession before this repair left. */
async function closeNarrative(id: string): Promise<void> {
  await supersede(harness.driver, { oldId: id, newId: 'edge-narrative-standing', now: NOW });
}

function contextFor(narrativeEdgeRepairBatch = 50): OperationContext {
  return {
    driver: harness.driver,
    db,
    // The repair is a semantic write, so the sweep publishes it: what it is handed is the same
    // coordinator every other writer on this substrate reaches.
    narratives: { publications: coordinator, resolver: {} as EvidenceResolver },
    config: configWith(narrativeEdgeRepairBatch),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

describe('narrativeCleanupOperation against a live graph', () => {
  /**
   * A session carrying two standing narratives the manifest binds no head for is a repair
   * obligation, not an arithmetic problem. The rule is explicit that a winner is not picked by
   * coverage count, prose or graph timestamp, so the run reports the pair and closes neither.
   */
  it('reports an unbound session duplicate and closes neither version', async () => {
    await seedSession('dup-session');
    // A live episode, so this session is not *also* nominated as an orphan under the same run.
    await seedEpisode('dup-episode', 'dup-session');
    await seedNarrative('dup-narrative-v1', 'dup-session', 1, 2);
    await seedNarrative('dup-narrative-v2', 'dup-session', 2, 5);

    const outcome = await narrativeCleanupOperation().run(contextFor());

    expect(outcome.detail).toContain('1 unbound session(s) reported');
    for (const id of ['dup-narrative-v1', 'dup-narrative-v2']) {
      const props = await nodeProperties(harness.driver, id);
      expect(props[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
      expect(props[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    }
  }, 120_000);

  /**
   * The forget this operation used to perform. A session with no live Episode says nothing about
   * whether the records still hold the narrative up, and for a narrative the manifest never bound
   * they cannot speak at all, so the run withholds and says so.
   */
  it('withholds a narrative whose session holds no live episode rather than forgetting it', async () => {
    await seedSession('orphan-session');
    await seedNarrative('orphan-narrative', 'orphan-session', 1, 3);

    const outcome = await narrativeCleanupOperation().run(contextFor());

    expect(outcome.detail).toContain('withheld for want of proof');
    const props = await nodeProperties(harness.driver, 'orphan-narrative');
    expect(props[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect(props[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  }, 120_000);

  /**
   * The case the structural check destroyed: a session whose every raw container is gone, and
   * the chunk revision written from them standing as the only record of what they said. Its
   * frozen membership is what holds it up, and repeated runs must not wear it down.
   */
  it('preserves distinct chunk revisions over a session with no live episode, run after run', async () => {
    await seedSession('evicted-session');
    const first = sealOneSourceChunk('evicted-session', 'evicted-s1');
    const second = sealOneSourceChunk('evicted-session', 'evicted-s2');
    const firstNode = publishRevision(first);
    const secondNode = publishRevision(second);
    await seedChunkRevisionNode(firstNode, 'evicted-session', first, 1);
    await seedChunkRevisionNode(secondNode, 'evicted-session', second, 1);

    for (let run = 0; run < 3; run += 1) {
      await narrativeCleanupOperation().run(contextFor());
    }

    for (const id of [firstNode, secondNode]) {
      const props = await nodeProperties(harness.driver, id);
      expect(props[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
      expect(props[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    }
  }, 120_000);

  /**
   * The crash this repair exists for: a publication acknowledged the next revision and the graph
   * close of the head it replaced never landed. The keeper is read from the manifest under the
   * write, an attempt still in flight is left for its own receipt, and a different chunk of the
   * same session is not a candidate at all.
   */
  it('closes an extra revision onto the acknowledged head and leaves an attempt in flight alone', async () => {
    await seedSession('family-session');
    const family = sealOneSourceChunk('family-session', 'family-s1');
    const other = sealOneSourceChunk('family-session', 'family-s2');
    const revision1 = publishRevision(family);
    const revision2 = publishRevision(family);
    const inFlight = allocateNarrativeRevision(db, CHUNK_REVISION_FAMILY, family, NOW);
    const otherNode = publishRevision(other);

    await seedChunkRevisionNode(revision1, 'family-session', family, 1);
    await seedChunkRevisionNode(revision2, 'family-session', family, 2);
    await seedChunkRevisionNode(inFlight.nodeId, 'family-session', family, inFlight.revisionNo);
    await seedChunkRevisionNode(otherNode, 'family-session', other, 1);

    const outcome = await narrativeCleanupOperation().run(contextFor());

    expect(outcome.detail).toContain('1 extra revision(s) superseded onto the acknowledged head');
    // The superseded revision, closed against the head the records name.
    expect(
      (await nodeProperties(harness.driver, revision1))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeDefined();
    // The acknowledged head, and the attempt whose receipt has not settled, both standing.
    for (const id of [revision2, inFlight.nodeId, otherNode]) {
      const props = await nodeProperties(harness.driver, id);
      expect(props[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    }
  }, 120_000);

  it('leaves a session with one narrative and a live episode alone', async () => {
    await seedSession('healthy-session');
    await seedEpisode('healthy-episode', 'healthy-session');
    await seedNarrative('healthy-narrative', 'healthy-session', 1, 1);

    await narrativeCleanupOperation().run(contextFor());

    const props = await nodeProperties(harness.driver, 'healthy-narrative');
    expect(props[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(props[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
  }, 120_000);
});

/**
 * The residue of every close that ran before the write path started closing these edges with
 * the narrative, plus the rollup's own absorbs, which take a member narrative without touching
 * the episode edges into it. Seeded as the state those closes leave: a closed narrative with
 * open summarization edges still pointing at it.
 */
describe('the summarization-edge backlog', () => {
  const EPISODES = ['edge-e1', 'edge-e2', 'edge-e3'];

  beforeAll(async () => {
    await seedSession('edge-session');
    for (const id of EPISODES) {
      await seedEpisode(id, 'edge-session');
    }
    await seedNarrative('edge-narrative-closed', 'edge-session', 1, 3);
    await seedNarrative('edge-narrative-standing', 'edge-session', 2, 3);
    for (const id of EPISODES) {
      await summarize(id, 'edge-narrative-closed');
      await summarize(id, 'edge-narrative-standing');
    }
    await closeNarrative('edge-narrative-closed');
  }, 120_000);

  it('closes only what one batch allows', async () => {
    const outcome = await narrativeCleanupOperation().run(contextFor(2));

    expect(outcome.status).toBe('applied');
    expect(outcome.detail).toContain('2 stale summarization edge(s)');

    const closed = await Promise.all(
      EPISODES.map(async (id) =>
        edgeValidUntil(harness.driver, SUMMARIZED_BY_TYPE, id, 'edge-narrative-closed'),
      ),
    );
    expect(closed.filter((at) => at !== undefined)).toHaveLength(2);
  }, 120_000);

  it('finishes the backlog on the next run and then finds nothing left', async () => {
    await narrativeCleanupOperation().run(contextFor());

    for (const id of EPISODES) {
      expect(
        await edgeValidUntil(harness.driver, SUMMARIZED_BY_TYPE, id, 'edge-narrative-closed'),
      ).toBeInstanceOf(Date);
      // The standing version keeps every edge the traversal actually needs.
      expect(
        await edgeValidUntil(harness.driver, SUMMARIZED_BY_TYPE, id, 'edge-narrative-standing'),
      ).toBeUndefined();
    }

    const again = await narrativeCleanupOperation().run(contextFor());
    expect(again.detail).toContain('0 stale summarization edge(s)');
  }, 120_000);

  it('leaves the closed narrative and its provenance in place', async () => {
    await narrativeCleanupOperation().run(contextFor());

    expect(await countNodesWithId(harness.driver, 'Narrative', 'edge-narrative-closed')).toBe(1);
    expect(
      await edgeValidUntil(
        harness.driver,
        DERIVES_FROM_TYPE,
        'edge-narrative-closed',
        'edge-session',
      ),
    ).toBeUndefined();
  }, 120_000);
});

/**
 * Debt A7. What a bounded pass reports is what the pass actually read.
 *
 * The stale-edge term used to be the whole backlog, so a run that closed its batch of a large
 * residue reported the residue as examined and its own effect as a rounding error. The backlog
 * is still reported, as the gauge it is, beside the population one run reached.
 */
describe('what a bounded run says it examined', () => {
  const A7_EPISODES = ['a7-e1', 'a7-e2', 'a7-e3', 'a7-e4'];

  beforeAll(async () => {
    await seedSession('a7-session');
    for (const id of A7_EPISODES) {
      await seedEpisode(id, 'a7-session');
    }
    await seedNarrative('a7-narrative-standing', 'a7-session', 2, 4);
    await seedNarrative('a7-narrative-closed', 'a7-session', 1, 4);
    for (const id of A7_EPISODES) {
      await summarize(id, 'a7-narrative-closed');
    }
    await supersede(harness.driver, {
      oldId: 'a7-narrative-closed',
      newId: 'a7-narrative-standing',
      now: NOW,
    });
  }, 120_000);

  it('counts the bounded scan rather than the backlog behind it', async () => {
    const families = await findDuplicateChunkFamilies(harness.driver, {
      limit: 50,
      versionLimit: 50,
    });
    const revisions = families.reduce((total, family) => total + family.versions.length, 0);
    const nominated = await findOrphanedNarratives(harness.driver, 50);
    const before = await countNarrativeEdges(harness.driver);
    expect(before.stale).toBeGreaterThanOrEqual(4);

    const outcome = await narrativeCleanupOperation().run(contextFor(2));

    // The two independent edge classes agree with the closure receipts: exactly the batch moved
    // from stale, and the active fan-out the traversal pays for did not.
    const after = await countNarrativeEdges(harness.driver);
    expect(before.stale - after.stale).toBe(2);
    expect(after.active).toBe(before.active);

    // The edge term is the batch this run reached, not the residue behind it. Read as the
    // remainder of the total once the two populations that were counted before the run are
    // taken out, so no other repair's arithmetic can stand in for the claim.
    const edgeTerm = outcome.itemsProcessed - revisions - nominated.length;
    expect(edgeTerm).toBe(2);
    expect(edgeTerm).toBeLessThan(before.stale);
    expect(outcome.detail).toContain('2 stale edge(s)');
    expect(outcome.detail).toContain(`backlog ${String(before.stale)} stale`);
  }, 120_000);
});

/**
 * The two endpoints of every close are checked against the manifest, and the repair is settled by
 * a receipt like any other publication.
 */
describe('the boundary the repair is published under', () => {
  it('leaves a node carrying this family key that the records bind elsewhere', async () => {
    await seedSession('impostor-session');
    const family = sealOneSourceChunk('impostor-session', 'impostor-s1');
    const stranger = sealOneSourceChunk('impostor-session', 'impostor-s2');
    const head = publishRevision(family);
    const strangerNode = publishRevision(stranger);
    await seedChunkRevisionNode(head, 'impostor-session', family, 1);
    // The graph says this node belongs to the family; the manifest says it is another chunk's
    // acknowledged revision, and the manifest is what owns the question.
    await seedChunkRevisionNode(strangerNode, 'impostor-session', family, 2);

    await narrativeCleanupOperation().run(contextFor());

    expect(
      (await nodeProperties(harness.driver, strangerNode))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
    expect(
      (await nodeProperties(harness.driver, head))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
  });

  it('finishes a repair interrupted before its acknowledgment, exactly once', async () => {
    await seedSession('interrupted-repair-session');
    const family = sealOneSourceChunk('interrupted-repair-session', 'interrupted-s1');
    const first = publishRevision(family);
    const second = publishRevision(family);
    await seedChunkRevisionNode(first, 'interrupted-repair-session', family, 1);
    await seedChunkRevisionNode(second, 'interrupted-repair-session', family, 2);

    failAt = 'before_ack';
    // The sweep does not fail the tick over one family it could not settle: the family stays as
    // it was and the run reports it, which is what leaves the pending operation to be recovered.
    await narrativeCleanupOperation().run(contextFor());
    expect(coordinator.hasPending()).toBe(true);

    const recovered = await coordinator.recover();
    expect(recovered?.status).toBe('acknowledged');
    expect(coordinator.hasPending()).toBe(false);
    expect(
      (await nodeProperties(harness.driver, first))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeDefined();
    // The head it was closed against is untouched, and a second recovery adds nothing.
    expect(
      (await nodeProperties(harness.driver, second))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
    expect(await coordinator.recover()).toBeUndefined();
  });
});
