import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { forgetNode, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { fetchAdjacency } from '../../../infrastructure/graph/adjacency.js';
import { COMMUNITY_PROPERTY } from '../../../infrastructure/graph/community-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  bridgeEndpoints,
  standingBridges,
} from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  spreadActivation,
  type ActivationBudget,
  type AdjacencyFetch,
} from '../../../recall/domain/activation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { communityRefreshOperation } from './community-refresh.js';
import type { ProviderFactory } from './routed-generation.js';
import { symbiosisBridgeOperation } from './symbiosis-bridge.js';

/**
 * Two knowledge islands: five concepts each, densely joined inside and joined to nothing
 * outside. That is the shape the design describes, and it is what label propagation has to
 * find before a bridge can be built between the two halves.
 *
 * Vectors are hand-built rather than embedded. One node on each side is aimed at the other
 * side, so which cross pair is closest is a fixed number rather than a model's opinion, and
 * the pair the operation picks is checked against it.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');

const LEFT_IDS = ['left-1', 'left-2', 'left-3', 'left-4', 'left-5'];
const RIGHT_IDS = ['right-1', 'right-2', 'right-3', 'right-4', 'right-5'];

/** The pair the vectors make closest: everything else across the divide is orthogonal. */
const NEAREST_LEFT = 'left-5';
const NEAREST_RIGHT = 'right-5';

/** Two hops is enough to cross one bridge and no more, which is the whole assertion. */
const BUDGET: ActivationBudget = {
  maxIterations: 100,
  decayFactor: 0.7,
  minActivation: 0.001,
  maxNodesVisited: 500,
  hubThreshold: 20,
  maxHops: 2,
  associationStrength: DEFAULTS.recall.associationStrength,
  maxActivated: DEFAULTS.contextResonance.activationLimit,
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

/**
 * The floor is lowered because a ten-node substrate is deliberately small: the shipped default
 * refuses to describe a graph this size, and the point here is the algorithm, not the floor.
 * The dimension follows the hand-built vectors, since the pair search only considers members
 * whose stored vector is the width the configured model produces.
 */
const config: Config = {
  ...DEFAULTS,
  models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
  maintenance: { ...DEFAULTS.maintenance, communityMinNodes: 4 },
};

/** A deterministic stand-in for the local embedder: the bridge's own vector is not the subject. */
const embed = async (texts: readonly string[]): Promise<Vector[]> =>
  texts.map(() => unitVector(2));

const PROPOSED_SUMMARY = 'Both clusters describe the same ingest path, one side batching it.';
const PROPOSED_RATIONALE = 'The two memories name the same pipeline from either end.';

/** A model that answers, so the run takes the proposal path the design puts first. */
const answeringProvider: ProviderFactory = () => ({
  embed,
  generate: async (): Promise<unknown> =>
    Promise.resolve({
      summary: PROPOSED_SUMMARY,
      rationale: PROPOSED_RATIONALE,
      compatibility: 0.72,
    }),
});

/** A model that is not there, which is the case the deterministic sentence exists for. */
const failingProvider: ProviderFactory = () => ({
  embed,
  generate: (): Promise<unknown> => Promise.reject(new Error('ollama unreachable')),
});

function unitVector(index: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/** Mostly on its own axis, tilted toward the other side's axis by `tilt`. */
function tiltedVector(axis: number, other: number, tilt: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[axis] = Math.sqrt(1 - tilt * tilt);
  vector[other] = tilt;
  return vector;
}

function context(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

const adjacency: AdjacencyFetch = async (request) =>
  fetchAdjacency(harness.driver, { ...request, mode: withCurrency() });

async function seedCluster(ids: readonly string[], axis: number, other: number): Promise<void> {
  for (const [index, id] of ids.entries()) {
    // The last member of each cluster leans toward the other cluster's axis, which is what
    // makes one cross pair the closest rather than every pair equally distant.
    const tilt = index === ids.length - 1 ? 0.44 : 0;
    await writeStampedNode(harness.driver, {
      label: 'Concept',
      id,
      now: NOW,
      properties: {
        text: `body of ${id}`,
        summary: `summary of ${id}`,
        content_vec: tiltedVector(axis, other, tilt),
      },
    });
  }
  for (const source of ids) {
    for (const target of ids) {
      if (source >= target) {
        continue;
      }
      await upsertEdge(harness.driver, {
        type: 'RELATED_TO',
        sourceId: source,
        targetId: target,
        strength: 0.9,
        confidence: 0.9,
        signals: ['test'],
        provenance: ['test'],
        count: 1,
        now: NOW,
      });
    }
  }
}

async function communityOf(id: string): Promise<number | undefined> {
  const value = (await nodeProperties(harness.driver, id))[COMMUNITY_PROPERTY];
  return typeof value === 'number' ? value : undefined;
}

async function bridgeIds(): Promise<string[]> {
  return (await standingBridges(harness.driver)).map((bridge) => bridge.id);
}

async function bridgeSummary(): Promise<string | undefined> {
  return (await standingBridges(harness.driver))[0]?.text;
}

/**
 * Fixture surgery, so the last case starts from an unbridged pair rather than a second
 * harness. Forgotten rather than deleted: `countBridgesBetween` reads current bridges only,
 * which is the same mechanism the rest of the substrate uses to take something out of scope.
 */
async function forgetBridges(): Promise<void> {
  for (const id of await bridgeIds()) {
    await forgetNode(harness.driver, { id, now: NOW });
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-community-bridge-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedCluster(LEFT_IDS, 0, 1);
  await seedCluster(RIGHT_IDS, 1, 0);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('community refresh and the symbiosis bridge', () => {
  it('has no bridge to cross before either operation runs', async () => {
    const run = await spreadActivation(adjacency, {
      seeds: [{ nodeId: NEAREST_LEFT }],
      budget: BUDGET,
    });

    const reached = new Set(run.activated.map((node) => node.nodeId));
    expect(reached.has(NEAREST_LEFT)).toBe(true);
    expect(RIGHT_IDS.some((id) => reached.has(id))).toBe(false);
  });

  it('will not bridge before the communities have been derived', async () => {
    const outcome = await symbiosisBridgeOperation({
      embed,
      buildProvider: answeringProvider,
    }).run(context());

    expect(outcome.status).toBe('noop');
    expect(await bridgeIds()).toEqual([]);
  });

  it('finds the two clusters and stamps each node with its community', async () => {
    const outcome = await communityRefreshOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(LEFT_IDS.length + RIGHT_IDS.length);
    expect(outcome.itemsAffected).toBe(LEFT_IDS.length + RIGHT_IDS.length);

    const left = await Promise.all(LEFT_IDS.map(communityOf));
    const right = await Promise.all(RIGHT_IDS.map(communityOf));
    expect(new Set(left).size).toBe(1);
    expect(new Set(right).size).toBe(1);
    expect(left[0]).not.toBe(right[0]);
  });

  it('bridges the closest cross-community pair and writes the sentence the model proposed', async () => {
    const outcome = await symbiosisBridgeOperation({
      embed,
      buildProvider: answeringProvider,
    }).run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(1);
    expect(outcome.detail).toContain('model-proposed');

    const bridges = await bridgeIds();
    expect(bridges).toHaveLength(1);
    expect(await bridgeSummary()).toBe(PROPOSED_SUMMARY);

    const endpoints = await bridgeEndpoints(harness.driver);
    expect(endpoints.map((endpoint) => endpoint.id).sort()).toEqual(
      [NEAREST_LEFT, NEAREST_RIGHT].sort(),
    );
    for (const endpoint of endpoints) {
      expect(endpoint.provenance).toContain('introspection');
      expect(endpoint.rationale).toBe(PROPOSED_RATIONALE);
    }
  });

  it('carries activation across the bridge into the other community', async () => {
    const run = await spreadActivation(adjacency, {
      seeds: [{ nodeId: NEAREST_LEFT }],
      budget: BUDGET,
    });

    const arrival = run.activated.find((node) => node.nodeId === NEAREST_RIGHT);
    expect(arrival).toBeDefined();
    expect(arrival?.hops).toBe(2);
  });

  it('writes no second bridge between a pair it has already joined', async () => {
    const outcome = await symbiosisBridgeOperation({
      embed,
      buildProvider: answeringProvider,
    }).run(context());

    expect(outcome.status).toBe('noop');
    expect(await bridgeIds()).toHaveLength(1);
  });

  /**
   * The floor under the design, not the design. A bridge is an enhancement, so a model that is
   * down costs the sentence and not the run, and what lands says what it is: a pair chosen by
   * the graph's own shape and anchored by the vectors, described in the terms both are stated
   * in.
   */
  it('writes a deterministic bridge when the model is unavailable', async () => {
    await forgetBridges();

    const outcome = await symbiosisBridgeOperation({
      embed,
      buildProvider: failingProvider,
    }).run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.detail).toContain('deterministic');
    expect(await bridgeSummary()).toContain('Bridge between two memory clusters');

    const endpoints = await bridgeEndpoints(harness.driver);
    expect(endpoints.map((endpoint) => endpoint.id).sort()).toEqual(
      [NEAREST_LEFT, NEAREST_RIGHT].sort(),
    );
    for (const endpoint of endpoints) {
      expect(endpoint.rationale).toContain('closest pair by content vector');
      // The pair score is in the rationale, so why these two clusters is re-derivable later.
      expect(endpoint.rationale).toContain('coherence');
    }
  });
});
