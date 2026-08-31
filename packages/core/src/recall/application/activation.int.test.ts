import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { fetchAdjacency } from '../../infrastructure/graph/adjacency.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { ensureGraphSession } from '../../infrastructure/graph/sessions.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  spreadActivation,
  SUPERSEDED_ACTIVATION_WEIGHT,
  type ActivationBudget,
  type AdjacencyFetch,
} from '../domain/activation.js';

const EMBED_DIMENSION = 8;
const SEEDED_AT = new Date('2026-06-01T00:00:00.000Z');

/**
 * `config.activation` defaults, with `maxHops` pinned per case rather than taken from the
 * shipped default. The fixture is built so the distance matters: the prior session is exactly
 * two hops from the seed and the episode inside it is three, which is the shape that separates
 * "the bound held it back" from "the graph could not reach it".
 */
const BUDGET: ActivationBudget = {
  maxIterations: 100,
  decayFactor: 0.7,
  minActivation: 0.1,
  maxNodesVisited: 500,
  hubThreshold: 10,
  maxHops: 2,
  associationStrength: DEFAULTS.recall.associationStrength,
  maxActivated: DEFAULTS.contextResonance.activationLimit,
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let episodeBeta: string;
let episodeAlpha: string;
let episodeStale: string;
let episodeFresh: string;
let memberId: string;

const SESSION_ALPHA = 'activation-session-alpha';
const SESSION_BETA = 'activation-session-beta';

async function seedEpisode(sessionId: string, summary: string): Promise<string> {
  const node = await writeStampedNode(harness.driver, {
    label: 'Episode',
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      [MEMORY_PROPERTIES.summary]: summary,
      [MEMORY_PROPERTIES.text]: summary,
      [MEMORY_PROPERTIES.sessionId]: sessionId,
    },
  });

  await upsertEdge(harness.driver, {
    type: CONTAINMENT_TYPE,
    sourceId: node.id,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['structural'],
    provenance: ['activation_int_test'],
    count: 0,
    now: SEEDED_AT,
  });

  return node.id;
}

/**
 * The production wiring: the driver and the bitemporal read mode are bound here, and the
 * algorithm sees one call that answers for a whole frontier.
 */
const fetch: AdjacencyFetch = (request) =>
  fetchAdjacency(harness.driver, {
    ...request,
    mode: withCurrency(),
    minStrength: DEFAULTS.recall.associationStrength,
    topK: DEFAULTS.recall.adjacencyTopK,
  });

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-activation-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Activation Test' });
  memberId = backbone.member.id;

  // The FOLLOWS chain session capture writes: alpha first, so beta follows it.
  for (const sessionId of [SESSION_ALPHA, SESSION_BETA]) {
    await ensureGraphSession(harness.driver, {
      sessionId,
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
      now: SEEDED_AT,
    });
  }

  episodeAlpha = await seedEpisode(SESSION_ALPHA, 'the earlier conversation');
  episodeBeta = await seedEpisode(SESSION_BETA, 'the current conversation');
  episodeStale = await seedEpisode(SESSION_BETA, 'the fact that was replaced');
  episodeFresh = await seedEpisode(SESSION_BETA, 'the fact that replaced it');
  await supersede(harness.driver, {
    oldId: episodeStale,
    newId: episodeFresh,
    now: SEEDED_AT,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('spreading activation over a live graph', () => {
  it('reaches the prior session, which only FOLLOWS traversal connects to the seed', async () => {
    const counted = vi.fn<AdjacencyFetch>(fetch);
    const run = await spreadActivation(counted, {
      seeds: [{ nodeId: episodeBeta }],
      budget: BUDGET,
    });

    const priorSession = run.activated.find((node) => node.nodeId === SESSION_ALPHA);
    expect(priorSession).toBeDefined();
    expect(priorSession?.hops).toBe(2);
    expect(priorSession?.pathSummary).toBe(
      `${episodeBeta} -[${CONTAINMENT_TYPE}]-> ${SESSION_BETA} -[FOLLOWS]-> ${SESSION_ALPHA}`,
    );
    // Containment out of the seed, then the session chain, both undamped at this degree.
    expect(priorSession?.score).toBeCloseTo(0.9 * 0.7 * 0.8 * 0.7, 10);
    expect(priorSession?.currency).toEqual({ currency: 'current' });

    // Three hops out, so a bound of two holds it back: reachability here is real, not a
    // side effect of a small graph where everything reaches everything.
    expect(run.activated.map((node) => node.nodeId)).not.toContain(episodeAlpha);

    // One round-trip per frontier ring, not one per node.
    expect(counted).toHaveBeenCalledTimes(run.iterations);
    expect(run.iterations).toBe(2);
  });

  it('reaches the prior session’s episode at the shipped hop bound', async () => {
    const run = await spreadActivation(fetch, {
      seeds: [{ nodeId: episodeBeta }],
      budget: { ...BUDGET, maxHops: DEFAULTS.recall.maxHops },
    });

    const priorEpisode = run.activated.find((node) => node.nodeId === episodeAlpha);
    expect(priorEpisode).toBeDefined();
    expect(priorEpisode?.hops).toBe(3);
    expect(priorEpisode?.pathSummary).toContain('-[FOLLOWS]->');
  });

  it('carries the backbone into the activated set', async () => {
    const run = await spreadActivation(fetch, {
      seeds: [{ nodeId: episodeBeta }],
      budget: BUDGET,
    });

    const member = run.activated.find((node) => node.nodeId === memberId);
    expect(member?.hops).toBe(2);
    expect(member?.pathSummary).toContain('-[INITIATED_BY]->');
  });

  it('surfaces a superseded node down-ranked and marked with its lineage', async () => {
    const run = await spreadActivation(fetch, {
      seeds: [{ nodeId: SESSION_BETA }],
      budget: { ...BUDGET, maxHops: 1 },
    });

    const stale = run.activated.find((node) => node.nodeId === episodeStale);
    const fresh = run.activated.find((node) => node.nodeId === episodeFresh);

    expect(stale?.currency.currency).toBe('superseded');
    expect(stale?.currency.supersededBy?.id).toBe(episodeFresh);
    expect(fresh?.currency).toEqual({ currency: 'current' });
    expect(stale?.score).toBeCloseTo((fresh?.score ?? 0) * SUPERSEDED_ACTIVATION_WEIGHT, 10);
  });

  /**
   * The cutoff moved into the adjacency read's own `WHERE` clause; this pins that the spread's
   * result is the same either side of that move. `propagate`'s own floor in `activation.ts`
   * would produce the identical split on an unfiltered fetch, which is what keeps this a
   * measure of the whole pipeline's behaviour rather than of one layer alone.
   */
  it('reaches a neighbour above the association-strength cutoff and not one below it', async () => {
    const anchor = await seedEpisode(SESSION_BETA, 'the cutoff test anchor');
    const above = await seedEpisode(SESSION_BETA, 'the neighbour above the cutoff');
    const below = await seedEpisode(SESSION_BETA, 'the neighbour below the cutoff');
    const floor = DEFAULTS.recall.associationStrength;

    await upsertEdge(harness.driver, {
      type: 'RELATED_TO',
      sourceId: anchor,
      targetId: above,
      strength: floor + 0.2,
      confidence: 1,
      signals: ['test'],
      provenance: ['activation_int_test'],
      count: 0,
      now: SEEDED_AT,
    });
    await upsertEdge(harness.driver, {
      type: 'RELATED_TO',
      sourceId: anchor,
      targetId: below,
      strength: floor - 0.05,
      confidence: 1,
      signals: ['test'],
      provenance: ['activation_int_test'],
      count: 0,
      now: SEEDED_AT,
    });

    const run = await spreadActivation(fetch, {
      seeds: [{ nodeId: anchor }],
      budget: { ...BUDGET, maxHops: 1 },
    });

    const activated = run.activated.map((node) => node.nodeId);
    expect(activated).toContain(above);
    expect(activated).not.toContain(below);
  });

  /**
   * A live hub's degree grows without bound; this is what keeps its cost bounded instead. The
   * read still finds every neighbour a small `topK` excludes, so nothing about reachability
   * changes, only how much of a hub's own edge list one frontier ring pays to fetch and score.
   */
  it('caps a hub to its strongest K edges rather than returning every incident one', async () => {
    // Written directly rather than through `seedEpisode`, which also writes a CONTAINMENT
    // edge to the session: this hub's only edges are the ones the test asserts on below.
    const hubNode = await writeStampedNode(harness.driver, {
      label: 'Episode',
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: {
        [MEMORY_PROPERTIES.summary]: 'a hub with more edges than the cap',
        [MEMORY_PROPERTIES.text]: 'a hub with more edges than the cap',
        [MEMORY_PROPERTIES.sessionId]: SESSION_BETA,
      },
    });
    const hub = hubNode.id;
    const neighbours = await Promise.all(
      [0.9, 0.8, 0.7, 0.6, 0.5].map((strength, index) =>
        seedEpisode(SESSION_BETA, `hub neighbour ${String(index)}`).then(async (id) => {
          await upsertEdge(harness.driver, {
            type: 'RELATED_TO',
            sourceId: hub,
            targetId: id,
            strength,
            confidence: 1,
            signals: ['test'],
            provenance: ['activation_int_test'],
            count: 0,
            now: SEEDED_AT,
          });
          return { id, strength };
        }),
      ),
    );

    const capped = await fetchAdjacency(harness.driver, {
      frontier: [hub],
      visited: [],
      mode: withCurrency(),
      minStrength: 0,
      topK: 3,
    });

    const strongest = neighbours
      .slice()
      .sort((left, right) => right.strength - left.strength)
      .slice(0, 3)
      .map((neighbour) => neighbour.id);
    expect(capped.map((neighbour) => neighbour.nodeId).sort()).toEqual(strongest.sort());
  });
});
