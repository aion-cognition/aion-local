import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchAdjacency } from '../graph/adjacency.js';
import { bootstrapBackbone } from '../graph/backbone.js';
import { supersede, writeStampedNode } from '../graph/bitemporal.js';
import { upsertEdge } from '../graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../graph/episodes.js';
import { runGraphMigrations } from '../graph/migrations.js';
import { withCurrency } from '../graph/read-modes.js';
import { ensureGraphSession } from '../graph/sessions.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import {
  spreadActivation,
  SUPERSEDED_ACTIVATION_WEIGHT,
  type ActivationBudget,
  type AdjacencyFetch,
} from './activation.js';

const EMBED_DIMENSION = 8;
const SEEDED_AT = new Date('2026-06-01T00:00:00.000Z');

/**
 * `config.activation` defaults with `config.recall.maxHops`, which is what makes the
 * assertion below meaningful: the prior session is exactly two hops out, and the episode
 * inside it is three, so a node that only traversal can reach is separated from one that
 * traversal cannot reach at all.
 */
const BUDGET: ActivationBudget = {
  maxIterations: 100,
  decayFactor: 0.7,
  minActivation: 0.1,
  maxNodesVisited: 500,
  hubThreshold: 10,
  maxHops: 2,
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
  fetchAdjacency(harness.driver, { ...request, mode: withCurrency() });

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-activation-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Activation Test' });
  memberId = backbone.member.id;

  // The FOLLOWS chain P1 writes: alpha first, so beta follows it.
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

    // Three hops out, so the hop bound holds it back: reachability here is real, not a
    // side effect of a small graph where everything reaches everything.
    expect(run.activated.map((node) => node.nodeId)).not.toContain(episodeAlpha);

    // One round-trip per frontier ring, not one per node.
    expect(counted).toHaveBeenCalledTimes(run.iterations);
    expect(run.iterations).toBe(2);
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
});
