import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { communityRefreshOperation } from './community-refresh.js';
import { symbiosisBridgeOperation } from './symbiosis-bridge.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { forgetNode, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { findClosestCrossCommunityPair } from '../../../infrastructure/graph/bridge-queries.js';
import { COMMUNITY_PROPERTY } from '../../../infrastructure/graph/community-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
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
import { AnthropicHaikuClient } from '../../../infrastructure/providers/test-support/anthropic-client.js';
import type {
  Provider,
  StructuredRequest,
  Vector,
} from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The bridge against the model that actually proposes it.
 *
 * The claim under test is the one a fake provider cannot make: given two community profiles and
 * no instruction about which members to use, the model finds the relation that matters and it is
 * not the one a cosine rule would have picked. The fixture is built so those two answers differ.
 *
 * Cluster A is an infrastructure incident. Cluster B is customer-facing fallout plus a pair of
 * generic release notes. The vectors are hand-built: the two release-note members are the
 * closest cross-community pair by content vector, and they say nothing. The relation worth
 * storing is the pool exhaustion and the checkout outage, whose vectors are orthogonal.
 *
 * Embeddings are a deterministic stand-in rather than the local model. The vector space is not
 * what this file measures, and hand-built vectors are what make the cosine answer a fixed number
 * to compare the model's choice against.
 */

const KEY = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
const ABSENT = KEY === '';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-13T14:00:00.000Z');

/** Axis 0 is the incident cluster, axis 1 the fallout cluster, axis 2 the shared release-note axis. */
const INCIDENT = [
  { id: 'inc-pool', text: 'The connection pool ran out of handles at 09:40 on the 14th.' },
  { id: 'inc-config', text: 'Someone lowered the pool ceiling from 200 to 20 in the config.' },
  { id: 'inc-restart', text: 'Restarting the API nodes cleared the exhausted pool at 10:55.' },
  { id: 'inc-notes', text: 'Release notes for 4.2.0: dependency bumps and a changelog tidy.' },
];

const FALLOUT = [
  { id: 'out-checkout', text: 'Checkout timed out for about an hour on the morning of the 14th.' },
  { id: 'out-tickets', text: 'Support took 38 tickets about a spinning checkout button.' },
  {
    id: 'out-refunds',
    text: 'We refunded 12 abandoned orders from that window as a goodwill step.',
  },
  { id: 'out-notes', text: 'Release notes for 4.2.1: dependency bumps and a changelog tidy.' },
];

/** The pair a cosine rule picks: two near-identical sentences that carry no relation. */
const COSINE_LEFT = 'inc-notes';
const COSINE_RIGHT = 'out-notes';

/** Two clusters with nothing between them, for the refusal case. */
const GARDEN = [
  { id: 'gdn-beds', text: 'I rebuilt the raised beds along the south fence out of cedar.' },
  { id: 'gdn-soil', text: 'The soil test came back low on nitrogen so I turned in compost.' },
  { id: 'gdn-tomato', text: 'The tomatoes went in the second week of May this year.' },
  { id: 'gdn-water', text: 'The drip line runs twenty minutes at dawn on odd days.' },
];

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = {
  ...DEFAULTS,
  models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
  maintenance: { ...DEFAULTS.maintenance, communityMinNodes: 4, bridgeMinCommunitySize: 3 },
};

function axisVector(axis: number, tilt: number, other: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[axis] = Math.sqrt(1 - tilt * tilt);
  vector[other] = tilt;
  return vector;
}

/** Generation goes to Haiku; embedding is a fixed vector, since the space is not under test. */
function liveProvider(): Provider {
  const client = new AnthropicHaikuClient({ apiKey: KEY });
  const model = process.env.AION_ANTHROPIC_MODEL ?? DEFAULTS.anthropic.model;
  return {
    embed: (texts: readonly string[]): Promise<Vector[]> =>
      Promise.resolve(texts.map(() => axisVector(3, 0, 4))),
    generate: (req: StructuredRequest): Promise<unknown> => client.generate({ ...req, model }),
  };
}

function context(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: liveProvider(),
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function seedCluster(
  members: readonly { id: string; text: string }[],
  axis: number,
  sharedWith: readonly string[],
): Promise<void> {
  for (const member of members) {
    // The release-note member of each cluster leans hard onto the shared axis, which is what
    // makes that pair the closest across the divide and every other pair orthogonal.
    const tilt = sharedWith.includes(member.id) ? 0.97 : 0;
    await writeStampedNode(harness.driver, {
      label: 'Concept',
      id: member.id,
      now: NOW,
      properties: {
        text: member.text,
        summary: member.text,
        content_vec: axisVector(axis, tilt, 2),
      },
    });
  }
  for (const source of members) {
    for (const target of members) {
      if (source.id >= target.id) {
        continue;
      }
      await upsertEdge(harness.driver, {
        type: 'RELATED_TO',
        sourceId: source.id,
        targetId: target.id,
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

async function forgetAll(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await forgetNode(harness.driver, { id, now: NOW });
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-symbiosis-live-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedCluster(INCIDENT, 0, [COSINE_LEFT]);
  await seedCluster(FALLOUT, 1, [COSINE_RIGHT]);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(ABSENT)('the symbiosis bridge on the model that proposes it', () => {
  it('confirms the cosine rule would have anchored on the two empty release notes', async () => {
    await communityRefreshOperation().run(context());

    const left = await communityOf(INCIDENT[0]?.id ?? '');
    const right = await communityOf(FALLOUT[0]?.id ?? '');
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left).not.toBe(right);

    const closest = await findClosestCrossCommunityPair(harness.driver, {
      left: left ?? 0,
      right: right ?? 0,
      candidateLimit: 25,
      dimension: EMBED_DIMENSION,
    });
    expect([closest?.leftId, closest?.rightId].sort()).toEqual([COSINE_LEFT, COSINE_RIGHT].sort());
  }, 180_000);

  /**
   * The acceptance case. The model is shown both profiles and nothing else, and the relation it
   * writes runs between two members the cosine rule would never have reached for.
   */
  it('anchors the bridge on the relation rather than on the nearest vectors', async () => {
    const outcome = await symbiosisBridgeOperation().run(context());

    console.log(`symbiosis live outcome: ${outcome.status} - ${String(outcome.detail)}`);
    expect(outcome.status).toBe('applied');

    const endpoints = (await bridgeEndpoints(harness.driver)).map((endpoint) => endpoint.id).sort();
    const [bridge] = await standingBridges(harness.driver);
    console.log(
      `  endpoints ${endpoints.join(' + ')}, compatibility ${String(bridge?.compatibility)}`,
    );
    console.log(`  summary: ${String(bridge?.text)}`);
    console.log(`  roles: ${String(bridge?.sourceRole)} / ${String(bridge?.targetRole)}`);

    // The whole claim: the pair the cosine rule would have picked is not the pair that was used.
    expect(endpoints).not.toEqual([COSINE_LEFT, COSINE_RIGHT].sort());
    expect(bridge?.author).toBe('model');
    expect(bridge?.inferred).toBe(true);
    expect((bridge?.text ?? '').length).toBeGreaterThan(0);
    expect(bridge?.premises.length ?? 0).toBeGreaterThan(0);
  }, 180_000);

  /** The refusal case: two clusters with nothing between them write nothing at all. */
  it('writes nothing between two communities that have nothing to do with each other', async () => {
    const before = (await standingBridges(harness.driver)).length;
    // Take the fallout cluster out of scope and put an unrelated one in its place, so the only
    // pair left to consider is the incident against a garden.
    await forgetAll(FALLOUT.map((member) => member.id));
    await seedCluster(GARDEN, 5, []);
    await communityRefreshOperation().run(context());

    const outcome = await symbiosisBridgeOperation().run(context());

    console.log(`symbiosis live refusal: ${outcome.status} - ${String(outcome.detail)}`);
    expect(outcome.status).toBe('noop');
    expect(await standingBridges(harness.driver)).toHaveLength(before);
  }, 180_000);
});
