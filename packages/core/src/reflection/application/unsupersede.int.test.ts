import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applySupersessionProposal, UNANIMOUS_APPLY_METHOD } from './proposals.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { BITEMPORAL_PROPERTIES, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../infrastructure/graph/cognitive-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { fetchNodeEdges, fetchNodeProvenance } from '../../infrastructure/graph/node-provenance.js';
import { knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds } from '../../infrastructure/graph/seed-queries.js';
import { findNodesWithoutCurrency } from '../../infrastructure/graph/supersession-queries.js';
import {
  nodeProperties,
  supersedingNodeIds,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { previewSupersession, unsupersedeNode } from '../../infrastructure/graph/unsupersede.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { recordSupersessionProposal } from '../../infrastructure/sqlite/supersession-proposals.js';

/**
 * Reopening a claim, over the closes that actually happen: the apply path a person drives and
 * the same path the two-pass judge drives on its own. Both write the same stamps, so the reopen
 * is mode-blind and this file proves it by closing each way and reopening the same way.
 */

const EMBED_DIMENSION = 8;
const FLOOR = DEFAULTS.reflection.supersedeFamilyRelatednessFloor;
const CLOSED_AT = new Date('2026-08-29T12:00:00.000Z');
const REOPENED_AT = new Date('2026-08-29T18:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string, text: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: CLOSED_AT,
    properties: { text, session_id: 'unsupersede-session' },
  });
}

async function seedClaim(episodeId: string, text: string): Promise<string> {
  const result = await writeCognitiveNode(harness.driver, {
    episodeId,
    label: 'Concept',
    text,
    now: CLOSED_AT,
  });
  return result.node.id;
}

async function isCurrent(id: string): Promise<boolean> {
  const properties = await nodeProperties(harness.driver, id);
  return properties[BITEMPORAL_PROPERTIES.validUntil] === undefined;
}

/** Closes `stale` in favour of `corrected` through the path the CLI and the stage share. */
async function closeThroughApply(
  stale: string,
  corrected: string,
  episodeId: string,
  attribution?: { provenance: readonly string[]; signals: readonly string[] },
): Promise<void> {
  const proposalId = recordSupersessionProposal(db, {
    oldId: stale,
    newId: corrected,
    confidence: 1,
    episodeId,
  });
  await applySupersessionProposal(harness.driver, db, {
    id: proposalId,
    scope: 'claim',
    relatednessFloor: FLOOR,
    now: CLOSED_AT,
    ...(attribution === undefined ? {} : { attribution }),
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-unsupersede-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reopening a superseded claim', () => {
  it('restores currency and keeps the lineage, stamped with when it stopped holding', async () => {
    await seedEpisode('ep-reopen-1', 'The Zephyr worker polls every 45 seconds.');
    await seedEpisode('ep-reopen-2', 'The Zephyr worker polls every 5 seconds now.');
    const stale = await seedClaim('ep-reopen-1', 'Zephyr polls every 45 seconds');
    const corrected = await seedClaim('ep-reopen-2', 'Zephyr polls every 5 seconds');
    await closeThroughApply(stale, corrected, 'ep-reopen-2');
    expect(await isCurrent(stale)).toBe(false);

    const preview = await previewSupersession(harness.driver, stale);
    expect(preview?.closed).toBe(true);
    expect(preview?.lineage.map((entry) => entry.supersededBy)).toEqual([corrected]);

    const result = await unsupersedeNode(harness.driver, { id: stale, now: REOPENED_AT });

    expect(result.justReopened).toBe(true);
    expect(result.reopenedFrom.map((entry) => entry.supersededBy)).toEqual([corrected]);
    expect(await isCurrent(stale)).toBe(true);
    // The edge is kept and stamped, never removed: the substrate still knows what it believed.
    expect(await supersedingNodeIds(harness.driver, stale)).toEqual([corrected]);
    const properties = await nodeProperties(harness.driver, stale);
    expect(properties[BITEMPORAL_PROPERTIES.txUntil] ?? undefined).toBeUndefined();
    // The replacement is untouched: reopening the old claim is not a claim about the new one.
    expect(await isCurrent(corrected)).toBe(true);
  }, 120_000);

  it('reads back as current with no live superseder, and as superseded before the reopen', async () => {
    await seedEpisode('ep-why-1', 'Bramble session state is in Redis.');
    await seedEpisode('ep-why-2', 'Bramble session state moved to signed cookies.');
    const stale = await seedClaim('ep-why-1', 'Bramble session state is in Redis');
    const corrected = await seedClaim('ep-why-2', 'Bramble session state is in signed cookies');
    await closeThroughApply(stale, corrected, 'ep-why-2');

    const before = await fetchNodeProvenance(harness.driver, stale);
    expect(before?.currency).toBe('superseded');
    expect(before?.supersededBy?.id).toBe(corrected);

    await unsupersedeNode(harness.driver, { id: stale, now: REOPENED_AT });

    const after = await fetchNodeProvenance(harness.driver, stale);
    expect(after?.currency).toBe('current');
    // Current and superseded at once would be the substrate contradicting itself, so the
    // default read drops a lineage edge the reopen closed.
    expect(after?.supersededBy).toBeUndefined();

    // Both directions of the honest answer: a knowledge-time read pinned between the close and
    // the reopen still reports the supersession the substrate held at that moment.
    const midway = new Date('2026-08-29T15:00:00.000Z');
    const during = await fetchNodeProvenance(harness.driver, stale, knewAt(midway));
    expect(during?.supersededBy?.id).toBe(corrected);

    // What `aion why` renders the reopen from: the edge is still there, and says when it
    // stopped holding.
    const edges = await fetchNodeEdges(harness.driver, stale);
    const lineage = edges.filter((edge) => edge.type === 'SUPERSEDES');
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.reopenedAt).toEqual(REOPENED_AT);
  }, 120_000);

  /** The close the two-pass judge makes carries its own provenance and reopens the same way. */
  it('reopens an autonomous close as readily as a reviewed one', async () => {
    await seedEpisode('ep-auto-1', 'Hollis hands over weekly.');
    await seedEpisode('ep-auto-2', 'Hollis hands over fortnightly now.');
    const stale = await seedClaim('ep-auto-1', 'the Hollis rotation hands over weekly');
    const corrected = await seedClaim('ep-auto-2', 'the Hollis rotation hands over fortnightly');
    await closeThroughApply(stale, corrected, 'ep-auto-2', {
      provenance: [UNANIMOUS_APPLY_METHOD],
      signals: ['two_pass_judge'],
    });

    const preview = await previewSupersession(harness.driver, stale);
    expect(preview?.lineage[0]?.provenance).toEqual([UNANIMOUS_APPLY_METHOD]);

    const result = await unsupersedeNode(harness.driver, { id: stale, now: REOPENED_AT });

    expect(result.justReopened).toBe(true);
    expect(await isCurrent(stale)).toBe(true);
  }, 120_000);

  /**
   * The user-visible half. Recall is currency-aware rather than currency-filtered, so a closed
   * claim still comes back and comes back marked; what a reopen changes is the mark and the
   * pointer, which is what decides how a pack presents it.
   */
  it('serves the reopened claim as current through the seed layer again', async () => {
    await seedEpisode('ep-recall-1', 'The Thornbury rebuild takes six hours.');
    await seedEpisode('ep-recall-2', 'The Thornbury rebuild takes forty minutes.');
    const stale = await seedClaim('ep-recall-1', 'the Thornbury rebuild takes six hours');
    const corrected = await seedClaim('ep-recall-2', 'the Thornbury rebuild takes forty minutes');
    await closeThroughApply(stale, corrected, 'ep-recall-2');

    const beforeReopen = await fulltextSeeds(harness.driver, {
      query: 'Thornbury',
      limit: 10,
      mode: withCurrency(),
    });
    const closedSeed = beforeReopen.find((seed) => seed.id === stale);
    expect(closedSeed?.currency).toBe('superseded');
    expect(closedSeed?.supersededBy?.id).toBe(corrected);

    await unsupersedeNode(harness.driver, { id: stale, now: REOPENED_AT });

    const afterReopen = await fulltextSeeds(harness.driver, {
      query: 'Thornbury',
      limit: 10,
      mode: withCurrency(),
    });
    const reopenedSeed = afterReopen.find((seed) => seed.id === stale);
    expect(reopenedSeed?.currency).toBe('current');
    expect(reopenedSeed?.supersededBy).toBeUndefined();
  }, 120_000);

  /**
   * The currency check the judgment path reads just before it writes, which is what tells a
   * real closure from one whose target was already gone. A reopen has to restore exactly the
   * property that check asks about, or a reopened claim stays invisible to the next judgment.
   */
  it('puts the claim back inside the currency check the write path runs', async () => {
    await seedEpisode('ep-currency-1', 'Corvid alerting is owned by the platform team.');
    await seedEpisode('ep-currency-2', 'Corvid alerting moved to the payments team.');
    const stale = await seedClaim('ep-currency-1', 'Corvid alerting is owned by platform');
    const corrected = await seedClaim('ep-currency-2', 'Corvid alerting is owned by payments');
    await closeThroughApply(stale, corrected, 'ep-currency-2');

    expect(await findNodesWithoutCurrency(harness.driver, [stale, corrected])).toEqual([stale]);

    await unsupersedeNode(harness.driver, { id: stale, now: REOPENED_AT });

    expect(await findNodesWithoutCurrency(harness.driver, [stale, corrected])).toEqual([]);
    // An id the graph never held reads as gone too, which is what keeps a judgment against a
    // vanished node out of the closure count.
    expect(await findNodesWithoutCurrency(harness.driver, ['no-such-node'])).toEqual([
      'no-such-node',
    ]);
  }, 120_000);

  it('is a no-op on a claim nothing closed, and on a second call', async () => {
    await seedEpisode('ep-open-1', 'nothing was ever corrected here');
    const open = await seedClaim('ep-open-1', 'a claim nobody argued with');

    const first = await unsupersedeNode(harness.driver, { id: open, now: REOPENED_AT });
    expect(first.justReopened).toBe(false);
    expect(first.reopenedFrom).toEqual([]);

    await seedEpisode('ep-twice-1', 'first');
    await seedEpisode('ep-twice-2', 'second');
    const stale = await seedClaim('ep-twice-1', 'the first claim');
    const corrected = await seedClaim('ep-twice-2', 'the second claim');
    await closeThroughApply(stale, corrected, 'ep-twice-2');
    await unsupersedeNode(harness.driver, { id: stale, now: REOPENED_AT });

    const later = new Date('2026-08-30T09:00:00.000Z');
    const repeat = await unsupersedeNode(harness.driver, { id: stale, now: later });

    expect(repeat.justReopened).toBe(false);
    expect(repeat.reopenedFrom).toEqual([]);
    // The first reopen's stamp stands, the same discipline the close itself follows.
    const edges = await fetchNodeEdges(harness.driver, stale);
    expect(edges.find((edge) => edge.type === 'SUPERSEDES')?.reopenedAt).toEqual(REOPENED_AT);
  }, 120_000);

  it('answers nothing for an id the graph does not know', async () => {
    expect(await previewSupersession(harness.driver, 'no-such-node')).toBeUndefined();
    await expect(unsupersedeNode(harness.driver, { id: 'no-such-node' })).rejects.toThrow();
  }, 120_000);
});
