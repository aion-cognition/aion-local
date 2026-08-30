import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  narrativeRegroundingOperation,
  narrativeRegroundingRelevance,
} from './narrative-regrounding.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  BITEMPORAL_PROPERTIES,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  findStaleNarratives,
} from '../../../infrastructure/graph/narrative-queries.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { narrativeGrounding } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { recordSupersessionProposal } from '../../../infrastructure/sqlite/supersession-proposals.js';
import { applySupersessionProposal } from '../../../reflection/application/proposals.js';
import { NARRATIVE_GROUNDING } from '../../../reflection/domain/narrative.js';
import { NEUTRAL_GRAPH_HEALTH } from '../../domain/health.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The gap between a correction and what recall answers. A narrative compresses a session's
 * claims into prose and carries no supersession lineage, so closing the claim underneath it
 * leaves the narrative standing as current, still stating the old value, next to the
 * replacement. Nothing noticed: the staleness scan selects on the grounding revision, and a
 * correction does not change one.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T12:00:00.000Z');
const SESSION_ID = 'regrounding-session';

const REWRITTEN = {
  sentences: [
    { text: 'Thistledown standardised on Larkspur as its checkpoint store.', source_ids: ['S1'] },
  ],
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = {
  ...DEFAULTS,
  models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
  maintenance: { ...DEFAULTS.maintenance, narrativeCleanupBatch: 50 },
};

const stubProvider: Provider = {
  embed: (texts: readonly string[]): Promise<Vector[]> =>
    Promise.resolve(texts.map(() => new Array<number>(EMBED_DIMENSION).fill(0.1))),
  generate: (): Promise<unknown> => Promise.resolve(REWRITTEN),
};

function context(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: stubProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function narrativeIsOpen(id: string): Promise<boolean> {
  const properties = await nodeProperties(harness.driver, id);
  return properties[BITEMPORAL_PROPERTIES.validUntil] === undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-narrative-regrounding-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: SESSION_ID,
    now: NOW,
    properties: {},
  });
  for (const id of ['regrounding-episode-1', 'regrounding-episode-2']) {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id,
      now: NOW,
      properties: { [MEMORY_PROPERTIES.text]: `body of ${id}`, session_id: SESSION_ID },
    });
    await upsertEdge(harness.driver, {
      type: CONTAINMENT_TYPE,
      sourceId: id,
      targetId: SESSION_ID,
      strength: 1,
      confidence: 1,
      signals: ['structural'],
      provenance: ['test'],
      count: 0,
      now: NOW,
    });
  }

  // A narrative written under the current revision: nothing about it is stale until the claim
  // it compresses is closed.
  await writeStampedNode(harness.driver, {
    label: 'Narrative',
    id: 'regrounding-narrative',
    now: NOW,
    properties: {
      [MEMORY_PROPERTIES.text]: 'Thistledown standardised on Quillfeather as its checkpoint store.',
      [MEMORY_PROPERTIES.summary]: 'The session settled the checkpoint store.',
      [NARRATIVE_PROPERTIES.version]: 1,
      [NARRATIVE_PROPERTIES.coverageKey]: 'regrounding-key',
      [NARRATIVE_PROPERTIES.coverageCount]: 2,
      [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    },
  });
  await upsertEdge(harness.driver, {
    type: DERIVES_FROM_TYPE,
    sourceId: 'regrounding-narrative',
    targetId: SESSION_ID,
    strength: 1,
    confidence: 1,
    signals: ['compression'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('narrative regrounding', () => {
  it('scores on the stale count and stays quiet when the graph collector fell back', () => {
    expect(narrativeRegroundingRelevance(healthFixture())).toBe(0);

    const stale = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, staleNarratives: 5 },
    });
    expect(narrativeRegroundingRelevance(stale)).toBeCloseTo(0.5, 6);

    const degraded = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, staleNarratives: 5 },
      degraded: ['graph'],
    });
    expect(narrativeRegroundingRelevance(degraded)).toBe(0);
  });

  it('marks the session narrative when a correction closes a claim it compressed', async () => {
    const stale = await writeCognitiveNode(harness.driver, {
      episodeId: 'regrounding-episode-1',
      label: 'Decision',
      text: 'Thistledown will use Quillfeather as its checkpoint store',
      now: NOW,
    });
    const corrected = await writeCognitiveNode(harness.driver, {
      episodeId: 'regrounding-episode-2',
      label: 'Decision',
      text: 'Thistledown will use Larkspur as its checkpoint store',
      now: NOW,
    });
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale.node.id,
      newId: corrected.node.id,
      confidence: 1,
      episodeId: 'regrounding-episode-2',
    });

    // Before the apply the narrative reads as current, which is exactly the problem.
    expect(await narrativeGrounding(harness.driver, 'regrounding-narrative')).toBe(
      NARRATIVE_GROUNDING,
    );
    expect(await findStaleNarratives(harness.driver, NARRATIVE_GROUNDING, 50)).toEqual([]);

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      scope: 'claim',
      relatednessFloor: DEFAULTS.reflection.supersedeFamilyRelatednessFloor,
      now: NOW,
    });

    expect(applied.regroundedNarratives).toEqual(['regrounding-narrative']);
    expect(await narrativeGrounding(harness.driver, 'regrounding-narrative')).not.toBe(
      NARRATIVE_GROUNDING,
    );
    const found = await findStaleNarratives(harness.driver, NARRATIVE_GROUNDING, 50);
    expect(found.map((narrative) => narrative.id)).toEqual(['regrounding-narrative']);
  }, 120_000);

  it('rewrites the marked narrative from the claims that are open now', async () => {
    const outcome = await narrativeRegroundingOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBeGreaterThanOrEqual(1);
    // Superseded rather than edited in place: the old sentence stays readable under `as_of`.
    expect(await narrativeIsOpen('regrounding-narrative')).toBe(false);
    expect(await findStaleNarratives(harness.driver, NARRATIVE_GROUNDING, 50)).toEqual([]);
  }, 120_000);

  it('converges: a second pass finds nothing left to reground', async () => {
    const outcome = await narrativeRegroundingOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
  }, 120_000);
});
