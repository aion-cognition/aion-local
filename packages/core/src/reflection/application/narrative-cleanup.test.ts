import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupNarratives, type NarrativeCleanupDeps } from './narrative-cleanup.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
} from '../../infrastructure/graph/narrative-queries.js';
import { coerceGraphValue } from '../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  publishNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';
import { NarrativeFakeGraph } from '../test-support/narrative-graph.fixture.js';

const SESSION_ID = 'session-with-episodes';
const EMPTY_SESSION_ID = 'session-without-episodes';
const NOW = new Date('2026-04-02T12:00:00Z');
const EPISODE_OCCURRED_AT = new Date('2026-04-02T10:00:00Z');

const OUTPUT = {
  sentences: [{ text: 'The orders table was left unsharded.', source_ids: ['S1'] }],
};

let graph: NarrativeFakeGraph;
let dataDir: string;
let logger: Logger;
let generate: ReturnType<typeof vi.fn>;
let store: SqliteStore;
let deps: NarrativeCleanupDeps;

function fakeVectors(texts: readonly string[]): Vector[] {
  return texts.map(() => [1, 0, 0, 0]);
}

function seedEpisode(id: string, sessionId: string): void {
  graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: `body of ${id}`,
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [BITEMPORAL_PROPERTIES.occurredAt]: EPISODE_OCCURRED_AT,
    [BITEMPORAL_PROPERTIES.txFrom]: EPISODE_OCCURRED_AT,
  });
  graph.seedEdge(CONTAINMENT_TYPE, id, sessionId);
}

/** A narrative as the free-prose writer left it: no citations, still standing. */
function seedOldNarrative(
  id: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): void {
  graph.seedNode(id, ['Narrative', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.summary]: 'The session focused on a close-mode probe.',
    [MEMORY_PROPERTIES.text]: 'The probe was presumably gathering detailed data from a target.',
    [NARRATIVE_PROPERTIES.version]: 1,
    [NARRATIVE_PROPERTIES.coverageKey]: 'stale-key',
    [NARRATIVE_PROPERTIES.coverageCount]: 1,
    ...extra,
  });
  graph.seedEdge(DERIVES_FROM_TYPE, id, sessionId);
}

function narrativesStanding(): { id: string; properties: Record<string, unknown> }[] {
  return graph
    .nodesWithLabel('Narrative')
    .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined);
}

beforeEach(() => {
  graph = new NarrativeFakeGraph();
  graph.seedNode(SESSION_ID, ['Session', 'AionNode']);
  graph.seedNode(EMPTY_SESSION_ID, ['Session', 'AionNode']);

  dataDir = mkdtempSync(join(tmpdir(), 'aion-narrative-cleanup-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  generate = vi.fn(() => Promise.resolve(OUTPUT));
  store = new SqliteStore({ filePath: ':memory:' });
  deps = {
    driver: graph.driver,
    db: store.db,
    provider: {
      embed: vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts))),
      generate,
    } as unknown as Provider,
    logger,
  };
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A published chunk revision over one frozen member, and the graph node it wrote. The manifest
 * is what holds this narrative up; the session it derives from holds no Episode at all, which is
 * the state an evicted session is in.
 */
function publishChunkRevisionFor(sessionId: string): string {
  recordSourceRecord(store.db, {
    sourceId: 'chunk-source',
    sessionId,
    verificationStatus: 'verified',
    archive: {
      canonicalArchiveId: 'archive-chunk-source',
      archiveSchemaVersion: 1,
      identityHash: 'identity-chunk-source',
      verifiedContentDigest: 'digest-chunk-source',
      verificationPolicyVersion: 1,
      archivedAt: NOW.toISOString(),
    },
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
  });
  const { chunkId } = sealChunk(store.db, {
    sessionId,
    sourceIds: ['chunk-source'],
    sealedAt: NOW,
  });
  const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: allocation.revisionNo,
    operationId: 'op-chunk-1',
    evidenceRevisionJson: '{"dependencies":[]}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  return allocation.nodeId;
}

describe('narrative cleanup', () => {
  it('regenerates the narrative of a session that still holds episodes', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report).toEqual({
      examined: 1,
      sessions: 1,
      regenerated: 1,
      held: 0,
      withheld: 0,
      failed: 0,
    });

    const standing = narrativesStanding();
    expect(standing).toHaveLength(1);
    expect(standing[0]?.id).not.toBe('old-narrative');
    expect(standing[0]?.properties[MEMORY_PROPERTIES.text]).toBe(
      'The orders table was left unsharded.',
    );
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.citations]).toEqual(['episode-1']);
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.grounding]).toBe(NARRATIVE_GROUNDING);
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.version]).toBe(2);
  });

  it('supersedes the old narrative rather than deleting it, on both timelines apart', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);

    await cleanupNarratives(deps, { now: NOW });

    const old = graph.nodes.get('old-narrative');
    // The old version stopped covering the session at the end of what the replacement
    // compresses; the substrate stopped holding it at the rewrite.
    expect(coerceGraphValue(old?.properties[BITEMPORAL_PROPERTIES.validUntil])).toEqual(
      EPISODE_OCCURRED_AT,
    );
    expect(coerceGraphValue(old?.properties[BITEMPORAL_PROPERTIES.txUntil])).toEqual(NOW);
    expect(old?.properties[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect(graph.edgesOfType('SUPERSEDES').map((edge) => edge.targetId)).toEqual(['old-narrative']);
  });

  /**
   * The branch that used to forget. A session with no Episode left says nothing about whether
   * the records still hold the narrative up, and this one they cannot speak for at all.
   */
  it('withholds a narrative nothing accounts for rather than forgetting it', async () => {
    seedOldNarrative('orphan-narrative', EMPTY_SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.withheld).toBe(1);
    expect(report.held).toBe(0);
    expect(report.regenerated).toBe(0);
    expect(generate).not.toHaveBeenCalled();
    const orphan = graph.nodes.get('orphan-narrative');
    expect(orphan?.properties[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect(orphan?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(narrativesStanding().map((node) => node.id)).toEqual(['orphan-narrative']);
  });

  /**
   * The case the old branch destroyed: every raw container of the session is gone and the chunk
   * revision written from them is the only record of what they said. Its frozen membership is
   * what holds it up, and no Episode is required for that.
   */
  it('leaves a chunk revision standing when its session holds no episode at all', async () => {
    const nodeId = publishChunkRevisionFor(EMPTY_SESSION_ID);
    seedOldNarrative(nodeId, EMPTY_SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.held).toBe(1);
    expect(report.withheld).toBe(0);
    expect(generate).not.toHaveBeenCalled();
    const chunk = graph.nodes.get(nodeId);
    expect(chunk?.properties[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect(narrativesStanding().map((node) => node.id)).toEqual([nodeId]);
  });

  it('leaves a narrative already written under the current grounding revision alone', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('grounded-narrative', SESSION_ID, {
      [NARRATIVE_PROPERTIES.citations]: ['episode-1'],
      [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    });

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.examined).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('converges: a second pass finds nothing left to repair', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);
    await cleanupNarratives(deps, { now: NOW });

    const second = await cleanupNarratives(deps, { now: NOW });

    expect(second.examined).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('counts a failed regeneration and leaves the old narrative standing', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);
    generate.mockRejectedValueOnce(new Error('ollama is down'));

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.failed).toBe(1);
    expect(report.regenerated).toBe(0);
    expect(narrativesStanding().map((node) => node.id)).toEqual(['old-narrative']);
  });
});
