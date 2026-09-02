import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dayNarrativeRollupOperation, weekNarrativeRollupOperation } from './narrative-rollup.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  BITEMPORAL_PROPERTIES,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../../infrastructure/graph/narrative-queries.js';
import { ROLLUP_WINDOW_PROPERTY } from '../../../infrastructure/graph/narrative-rollup-queries.js';
import { asOf, withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { fulltextSeeds } from '../../../infrastructure/graph/seed-queries.js';
import {
  countEdges,
  nodeLabels,
  nodeProperties,
  supersedingNodeIds,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Two days of session narratives, and the scopes above them. What only a real server proves
 * here is the Cypher: which narratives a window is made of, what supersession does to their
 * standing in a default read, and that `as_of` still reaches them afterwards.
 *
 * The model is deterministic on purpose. Whether prose reads well is a quality measurement the
 * grounding battery owns; what this file asserts is the compression, the lineage, and the veto.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-04-06T09:00:00.000Z');

const REVIEW_MARKER = 'You review a draft memory';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const SESSIONS = [
  {
    id: 'narrative-session-morning',
    occurredAt: '2026-04-02T09:30:00.000Z',
    text:
      'The morning session staged the Ariadne rollout behind a flag and defaulted it off. ' +
      'The flag name was settled as AION_ARIADNE and written into the staging configuration.',
  },
  {
    id: 'narrative-session-evening',
    occurredAt: '2026-04-02T18:30:00.000Z',
    text:
      'The evening session ran the Ariadne migration and held the launch for the backfill. ' +
      'Every constraint came back green and the backfill had about a day of work left on it.',
  },
  {
    id: 'narrative-session-friday',
    occurredAt: '2026-04-03T11:00:00.000Z',
    text:
      'Friday finished the Ariadne backfill and flipped the flag on for the first cohort. ' +
      'The cohort was capped at five percent of traffic and watched for an hour afterwards.',
  },
  // A third closed day, one past the two-window budget a tick spends. It is what makes the
  // backlog visible: a run that spends the budget on settled days never reaches this one.
  {
    id: 'narrative-session-saturday',
    occurredAt: '2026-04-04T10:00:00.000Z',
    text:
      'Saturday widened the Ariadne cohort to a quarter of traffic and left it there. ' +
      'The error budget held flat for the whole window and nobody paged.',
  },
];

/**
 * Answers the synthesis pass by citing every tag the prompt offered, and the review pass by the
 * verdict the test asked for. Nothing here reads the draft: the point is which path the
 * operation takes on each verdict, not whether a model can spot an invention.
 */
function stubProvider(verdict: 'unanimous' | 'vetoed'): Provider {
  return {
    embed: (texts) =>
      Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIMENSION }, () => 0.5))),
    generate: (request) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      if (prompt.includes(REVIEW_MARKER)) {
        return Promise.resolve(
          verdict === 'vetoed'
            ? { unsupported: true, reason: 'sentence 1 states an outcome the members do not' }
            : { unsupported: false, reason: 'every sentence stays inside its citations' },
        );
      }
      const handles = [...new Set(prompt.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
      return Promise.resolve({
        sentences: [
          { text: 'The window carried the Ariadne rollout forward.', source_ids: handles },
        ],
      });
    },
  };
}

const armed: Config = {
  ...DEFAULTS,
  maintenance: { ...DEFAULTS.maintenance, narrativeRollup: true },
};

const disarmed: Config = {
  ...DEFAULTS,
  maintenance: { ...DEFAULTS.maintenance, narrativeRollup: false },
};

function context(
  config: Config = armed,
  verdict: 'unanimous' | 'vetoed' = 'unanimous',
): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: stubProvider(verdict),
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function seedSessionNarrative(seed: (typeof SESSIONS)[number]): Promise<void> {
  const occurredAt = new Date(seed.occurredAt);
  await writeStampedNode(harness.driver, {
    label: 'Narrative',
    id: seed.id,
    now: occurredAt,
    occurredAt,
    properties: {
      [MEMORY_PROPERTIES.summary]: seed.text.split('.')[0] ?? seed.text,
      [MEMORY_PROPERTIES.text]: seed.text,
      [NARRATIVE_PROPERTIES.scope]: 'session',
      [NARRATIVE_PROPERTIES.version]: 1,
      [NARRATIVE_PROPERTIES.coverageKey]: `key-${seed.id}`,
      [NARRATIVE_PROPERTIES.coverageCount]: 2,
      [NARRATIVE_PROPERTIES.grounding]: 'grounded-1',
    },
  });
}

async function rollupIdFor(windowKey: string): Promise<string> {
  const ids = await supersedingNodeIds(harness.driver, SESSIONS[0]!.id);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const properties = await nodeProperties(harness.driver, id);
    if (properties[ROLLUP_WINDOW_PROPERTY] === windowKey) {
      return id;
    }
  }
  throw new Error(`no rollup found for window ${windowKey}`);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-narrative-rollup-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (const seed of SESSIONS) {
    await seedSessionNarrative(seed);
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('narrative rollups against a live substrate', () => {
  it('examines no window while the kill switch is off', async () => {
    const outcome = await dayNarrativeRollupOperation().run(context(disarmed));

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsProcessed).toBe(0);
    expect(outcome.detail).toContain('AION_MAINTENANCE_NARRATIVE_ROLLUP');
  });

  it('writes nothing when the review vetoes the draft', async () => {
    const outcome = await dayNarrativeRollupOperation().run(context(armed, 'vetoed'));

    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain('2 vetoed by review');
    const member = await nodeProperties(harness.driver, SESSIONS[0]!.id);
    expect(member[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  });

  it('compresses each closed day into one narrative citing its sessions', async () => {
    const outcome = await dayNarrativeRollupOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(2);
    expect(outcome.itemsAffected).toBe(2);

    const rollupId = await rollupIdFor('2026-04-02');
    expect(await nodeLabels(harness.driver, rollupId)).toEqual(['AionNode', 'Memory', 'Narrative']);

    const properties = await nodeProperties(harness.driver, rollupId);
    expect(properties[NARRATIVE_PROPERTIES.scope]).toBe('day');
    expect(properties[NARRATIVE_PROPERTIES.version]).toBe(1);
    expect(properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(2);
    expect(properties[MEMORY_PROPERTIES.extractionMethod]).toBe('narrative_rollup');
    expect(properties[NARRATIVE_PROPERTIES.citations]).toEqual([SESSIONS[0]!.id, SESSIONS[1]!.id]);
    expect(Number(properties[NARRATIVE_PROPERTIES.sentenceCount])).toBeGreaterThan(0);
    expect(properties[MEMORY_PROPERTIES.contentVector]).toHaveLength(EMBED_DIMENSION);

    for (const seed of [SESSIONS[0]!, SESSIONS[1]!]) {
      expect(await countEdges(harness.driver, SUMMARIZED_BY_TYPE, seed.id, rollupId)).toBe(1);
    }
  });

  it('marks the rolled-up sessions superseded in a default read and current under as_of', async () => {
    const rollupId = await rollupIdFor('2026-04-02');
    const current = await fulltextSeeds(harness.driver, {
      query: 'Ariadne',
      limit: 20,
      mode: withCurrency(NOW),
    });
    const member = current.find((seed) => seed.id === SESSIONS[0]!.id);

    // Down-ranked rather than hidden, which is what fusion reads the annotation for: the
    // rollup that replaced it is named on the row.
    expect(member?.currency).toBe('superseded');
    expect(member?.supersededBy?.id).toBe(rollupId);
    expect(current.find((seed) => seed.id === rollupId)?.currency).toBe('current');

    const historic = await fulltextSeeds(harness.driver, {
      query: 'Ariadne',
      limit: 20,
      mode: asOf(new Date('2026-04-02T12:00:00.000Z')),
    });
    const before = historic.find((seed) => seed.id === SESSIONS[0]!.id);
    expect(before?.currency).toBe('current');
  });

  it('leaves the member reachable through its lineage and reopens it on unsupersede', async () => {
    const rollupId = await rollupIdFor('2026-04-02');
    expect(await supersedingNodeIds(harness.driver, SESSIONS[1]!.id)).toContain(rollupId);

    const reopened = await unsupersedeNode(harness.driver, { id: SESSIONS[1]!.id, now: NOW });
    expect(reopened.justReopened).toBe(true);
    expect(
      (await nodeProperties(harness.driver, SESSIONS[1]!.id))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
  });

  it('rolls the days up into the week they belong to', async () => {
    const outcome = await weekNarrativeRollupOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(1);

    const dayRollupId = await rollupIdFor('2026-04-02');
    const weekIds = await supersedingNodeIds(harness.driver, dayRollupId);
    expect(weekIds).toHaveLength(1);

    const properties = await nodeProperties(harness.driver, weekIds[0]!);
    expect(properties[NARRATIVE_PROPERTIES.scope]).toBe('week');
    expect(properties[ROLLUP_WINDOW_PROPERTY]).toBe('2026-W14');
    expect(properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(2);
    expect(properties[NARRATIVE_PROPERTIES.citations]).toContain(dayRollupId);
  });

  it('writes no second rollup over a window that has not changed', async () => {
    const outcome = await weekNarrativeRollupOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain('1 already covered');
  });

  /**
   * The backlog has to drain. A settled day answers `skip` and writes nothing, so a later tick
   * has to walk past it to the day nothing has rolled up yet rather than spending its window
   * budget on the same oldest days every run.
   */
  it('reaches a day past the window budget on a later tick', async () => {
    const outcome = await dayNarrativeRollupOperation().run(context());

    expect(outcome.status).toBe('applied');
    const rolled = await supersedingNodeIds(harness.driver, 'narrative-session-saturday');
    expect(rolled).toHaveLength(1);
    const properties = await nodeProperties(harness.driver, rolled[0]!);
    expect(properties[ROLLUP_WINDOW_PROPERTY]).toBe('2026-04-04');
  });
});
