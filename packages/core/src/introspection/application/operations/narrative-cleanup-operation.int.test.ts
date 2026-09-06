import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { narrativeCleanupOperation } from './narrative-cleanup-operation.js';
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
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
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
    config: configWith(narrativeEdgeRepairBatch),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

describe('narrativeCleanupOperation against a live graph', () => {
  it('keeps the highest-coverage duplicate and supersedes the rest', async () => {
    await seedSession('dup-session');
    // A live episode, so this session is not *also* an orphan under the same run: the
    // duplicate and orphan repairs are independent pathologies and this test isolates one.
    await seedEpisode('dup-episode', 'dup-session');
    await seedNarrative('dup-narrative-v1', 'dup-session', 1, 2);
    await seedNarrative('dup-narrative-v2', 'dup-session', 2, 5);

    const outcome = await narrativeCleanupOperation().run(contextFor());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBeGreaterThanOrEqual(1);

    const v1Props = await nodeProperties(harness.driver, 'dup-narrative-v1');
    expect(v1Props[BITEMPORAL_PROPERTIES.validUntil]).toBeDefined();

    const v2Props = await nodeProperties(harness.driver, 'dup-narrative-v2');
    expect(v2Props[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  }, 120_000);

  it('forgets a narrative whose session holds no live episode', async () => {
    await seedSession('orphan-session');
    await seedNarrative('orphan-narrative', 'orphan-session', 1, 3);

    const outcome = await narrativeCleanupOperation().run(contextFor());

    expect(outcome.status).toBe('applied');
    const props = await nodeProperties(harness.driver, 'orphan-narrative');
    expect(props[BITEMPORAL_PROPERTIES.forgottenAt]).toBeDefined();
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
