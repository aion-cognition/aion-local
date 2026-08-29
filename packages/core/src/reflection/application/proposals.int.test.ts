import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BITEMPORAL_PROPERTIES, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../infrastructure/graph/cognitive-queries.js';
import { findSourceEpisodeId } from '../../infrastructure/graph/episode-supersession.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  nodeProperties,
  relationshipsByProvenance,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getSupersessionProposal,
  recordSupersessionProposal,
} from '../../infrastructure/sqlite/supersession-proposals.js';
import {
  applySupersessionProposal,
  dismissSupersessionProposal,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  PROPOSAL_APPLY_METHOD,
} from './proposals.js';

/**
 * The path a correction takes once a person agrees with the judge. Propose mode closes
 * nothing on its own, which is the point, so this is the only path that can make a stored
 * correction change what recall answers. Before it existed the proposal table was write-only
 * and the correction battery could only be passed by a test calling the graph primitive
 * directly.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string, text: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text, session_id: 'proposal-session' },
  });
}

async function seedClaim(episodeId: string, text: string): Promise<string> {
  const result = await writeCognitiveNode(harness.driver, {
    episodeId,
    label: 'Concept',
    text,
    now: NOW,
  });
  return result.node.id;
}

async function isClosed(id: string): Promise<boolean> {
  const properties = await nodeProperties(harness.driver, id);
  return properties[BITEMPORAL_PROPERTIES.validUntil] !== undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-proposal-apply-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('applying a supersession proposal', () => {
  it('closes the judged claim, records the review as its own provenance, and resolves the row', async () => {
    await seedEpisode('ep-poll-1', 'The Zephyr ingest worker polls every 45 seconds.');
    await seedEpisode('ep-poll-2', 'We changed the Zephyr ingest worker poll interval to 5 seconds.');
    const stale = await seedClaim('ep-poll-1', 'Zephyr ingest polls every 45 seconds');
    const corrected = await seedClaim('ep-poll-2', 'Zephyr ingest polls every 5 seconds');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      rationale: 'poll interval',
      episodeId: 'ep-poll-2',
    });

    expect(await isClosed(stale)).toBe(false);

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      now: NOW,
    });

    expect(applied.closedIds).toEqual([stale]);
    expect(applied.supersededBy).toBe(corrected);
    expect(await isClosed(stale)).toBe(true);
    expect(await isClosed(corrected)).toBe(false);
    // A human review is its own provenance: lineage has to distinguish what a person applied
    // from what the judge would have applied on its own, or the posture change is unreadable.
    const reviewed = await relationshipsByProvenance(harness.driver, PROPOSAL_APPLY_METHOD);
    expect(reviewed).toContainEqual(expect.objectContaining({ sourceId: corrected, targetId: stale }));
    expect(getSupersessionProposal(db, proposalId)?.resolvedAt).toEqual(expect.any(String));
  }, 120_000);

  /**
   * The wider blade. A claim's siblings were extracted from the same observation, so closing
   * the claim alone leaves them answering as current, which is the compounding half of "a
   * correction does not change what recall answers".
   */
  it('closes the source episode and its derived family under --episode', async () => {
    await seedEpisode('ep-region-1', 'The billing service deploys to AWS us-east-1.');
    await seedEpisode('ep-region-2', 'The billing service has been deployed to Fly.io.');
    const stale = await seedClaim('ep-region-1', 'billing deploys to AWS us-east-1');
    const sibling = await seedClaim('ep-region-1', 'us-east-1 is the billing region');
    const corrected = await seedClaim('ep-region-2', 'billing deploys to Fly.io');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-region-2',
    });

    expect(await findSourceEpisodeId(harness.driver, stale)).toBe('ep-region-1');

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      episode: true,
      now: NOW,
    });

    expect(applied.closedIds).toContain('ep-region-1');
    expect(applied.closedIds).toContain(stale);
    expect(applied.closedIds).toContain(sibling);
    expect(await isClosed(sibling)).toBe(true);
    expect(await isClosed(corrected)).toBe(false);
  }, 120_000);

  it('refuses an unknown id and a proposal someone already decided, rather than writing twice', async () => {
    await seedEpisode('ep-once-1', 'first');
    await seedEpisode('ep-once-2', 'second');
    const stale = await seedClaim('ep-once-1', 'the first claim');
    const corrected = await seedClaim('ep-once-2', 'the second claim');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-once-2',
    });
    dismissSupersessionProposal(db, proposalId, NOW);

    await expect(
      applySupersessionProposal(harness.driver, db, { id: proposalId, now: NOW }),
    ).rejects.toBeInstanceOf(ProposalAlreadyResolvedError);
    await expect(
      applySupersessionProposal(harness.driver, db, { id: 'no-such-proposal', now: NOW }),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
    // Dismissed means the claim stands: nothing was closed on the way to refusing.
    expect(await isClosed(stale)).toBe(false);
  }, 120_000);
});
