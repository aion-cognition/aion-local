import { beforeEach, describe, expect, it } from 'vitest';

import { cleanupNarratives } from './narrative-cleanup.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
} from '../../infrastructure/graph/narrative-queries.js';
import { coerceGraphValue } from '../../infrastructure/graph/values.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  publishNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';
import {
  deps,
  OTHER_SESSION_ID as EMPTY_SESSION_ID,
  generate,
  graph,
  NOW,
  seedEpisode as seedNativeEpisode,
  SESSION_ID,
  store,
} from './test-support/legacy-regression.fixture.js';

const EPISODE_OCCURRED_AT = new Date('2026-04-02T10:00:00Z');
beforeEach(() => {
  generate.mockResolvedValue({
    sentences: [{ text: 'The orders table was left unsharded.', source_ids: ['S1'] }],
  });
});
async function seedEpisode(id: string, sessionId: string): Promise<void> {
  await seedNativeEpisode(id, EPISODE_OCCURRED_AT.toISOString(), sessionId);
}

/** A narrative as the free-prose writer left it: no citations, still standing. */
async function seedOldNarrative(
  id: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await graph.seedNode(id, ['Narrative', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.summary]: 'The session focused on a close-mode probe.',
    [MEMORY_PROPERTIES.text]: 'The probe was presumably gathering detailed data from a target.',
    [NARRATIVE_PROPERTIES.scope]: 'session',
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [NARRATIVE_PROPERTIES.version]: 1,
    [NARRATIVE_PROPERTIES.coverageKey]: 'stale-key',
    [NARRATIVE_PROPERTIES.coverageCount]: 1,
    ...extra,
  });
  await graph.seedEdge(DERIVES_FROM_TYPE, id, sessionId);
}

async function narrativesStanding(): Promise<
  { id: string; properties: Record<string, unknown> }[]
> {
  return (await graph.nodesWithLabel('Narrative')).filter(
    (node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined,
  );
}

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
    await seedEpisode('episode-1', SESSION_ID);
    await seedOldNarrative('old-narrative', SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report).toEqual({
      examined: 1,
      sessions: 1,
      regenerated: 1,
      held: 0,
      withheld: 0,
      failed: 0,
    });

    const standing = await narrativesStanding();
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
    await seedEpisode('episode-1', SESSION_ID);
    await seedOldNarrative('old-narrative', SESSION_ID);

    await cleanupNarratives(deps, { now: NOW });

    const old = await graph.node('old-narrative');
    // The old version stopped covering the session at the end of what the replacement
    // compresses; the substrate stopped holding it at the rewrite.
    expect(coerceGraphValue(old?.properties[BITEMPORAL_PROPERTIES.validUntil])).toEqual(
      EPISODE_OCCURRED_AT,
    );
    expect(coerceGraphValue(old?.properties[BITEMPORAL_PROPERTIES.txUntil])).toEqual(NOW);
    expect(old?.properties[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect((await graph.edgesOfType('SUPERSEDES')).map((edge) => edge.targetId)).toEqual([
      'old-narrative',
    ]);
  });

  /**
   * The branch that used to forget. A session with no Episode left says nothing about whether
   * the records still hold the narrative up, and this one they cannot speak for at all.
   */
  it('withholds a narrative nothing accounts for rather than forgetting it', async () => {
    await seedOldNarrative('orphan-narrative', EMPTY_SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.withheld).toBe(1);
    expect(report.held).toBe(0);
    expect(report.regenerated).toBe(0);
    expect(generate).not.toHaveBeenCalled();
    const orphan = await graph.node('orphan-narrative');
    expect(orphan?.properties[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect(orphan?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect((await narrativesStanding()).map((node) => node.id)).toEqual(['orphan-narrative']);
  });

  /**
   * The case the old branch destroyed: every raw container of the session is gone and the chunk
   * revision written from them is the only record of what they said. Its frozen membership is
   * what holds it up, and no Episode is required for that.
   */
  it('leaves a chunk revision standing when its session holds no episode at all', async () => {
    const nodeId = publishChunkRevisionFor(EMPTY_SESSION_ID);
    await seedOldNarrative(nodeId, EMPTY_SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.held).toBe(1);
    expect(report.withheld).toBe(0);
    expect(generate).not.toHaveBeenCalled();
    const chunk = await graph.node(nodeId);
    expect(chunk?.properties[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect((await narrativesStanding()).map((node) => node.id)).toEqual([nodeId]);
  });

  it('leaves a narrative already written under the current grounding revision alone', async () => {
    await seedEpisode('episode-1', SESSION_ID);
    await seedOldNarrative('grounded-narrative', SESSION_ID, {
      [NARRATIVE_PROPERTIES.citations]: ['episode-1'],
      [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    });

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.examined).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('converges: a second pass finds nothing left to repair', async () => {
    await seedEpisode('episode-1', SESSION_ID);
    await seedOldNarrative('old-narrative', SESSION_ID);
    await cleanupNarratives(deps, { now: NOW });

    const second = await cleanupNarratives(deps, { now: NOW });

    expect(second.examined).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('counts a failed regeneration and leaves the old narrative standing', async () => {
    await seedEpisode('episode-1', SESSION_ID);
    await seedOldNarrative('old-narrative', SESSION_ID);
    generate.mockRejectedValueOnce(new Error('ollama is down'));

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.failed).toBe(1);
    expect(report.regenerated).toBe(0);
    expect((await narrativesStanding()).map((node) => node.id)).toEqual(['old-narrative']);
  });
});
