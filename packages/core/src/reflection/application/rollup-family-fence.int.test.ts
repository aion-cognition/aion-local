import { expect, it } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { readFamilyFence } from './family-fence.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import { cutoverSessionFamily, ensureSessionFamily } from './narrative-family.js';
import { rollUpNarratives } from './narrative-rollup.js';
import { fenceRollupWindow } from './rollup-family-fence.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import { BITEMPORAL_PROPERTIES, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import {
  findWindowRollups,
  ROLLUP_WINDOW_PROPERTY,
} from '../../infrastructure/graph/narrative-rollup-queries.js';
import {
  edgeValidUntil,
  nodeProperties,
  supersedingNodeIds,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import { recordMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { rememberMigrationPolicy } from '../../infrastructure/sqlite/migration-partition.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';
import { coverageKey, NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * The calendar pass against sessions that have moved to chunks.
 *
 * The member read nominates a retired whole-session narrative exactly as it always did, because
 * a cutover moves no clock and closes no interval. What must not happen after it is a calendar
 * summary published over that narrative, or the narrative absorbed into one. A day summary
 * written before the cutover is the same question one scope up: the week above it reads that
 * summary, and what the summary rests on is retired.
 *
 * The cutover here is the real one, through the coordinator, with the census, the sealed
 * partition and the published chunk it requires.
 */

const drafts: string[] = [];

/** What the pass is holding a synthesis open for, which is how the race is staged. */
let suspended: (() => Promise<void>) | undefined;

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0])),
  generate: (request) => {
    const prompt = request.messages.map((message) => message.content).join('\n');
    if (prompt.includes('You review a draft memory')) {
      return Promise.resolve({
        unsupported: false,
        reason: 'every sentence stays inside its citations',
      });
    }
    drafts.push(prompt);
    const during = suspended;
    suspended = undefined;
    const handles = [...new Set(prompt.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
    const answer = {
      sentences: [{ text: 'The window carried its work forward.', source_ids: handles }],
    };
    return during === undefined ? Promise.resolve(answer) : during().then(() => answer);
  },
};

function deps() {
  return {
    driver,
    db: store.db,
    provider,
    logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
  };
}

/** The original graph-only whole-session representation, dated into the window under test. */
async function seedLegacy(input: {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly occurredAt: Date;
  readonly text: string;
}): Promise<void> {
  await writeStampedNode(driver, {
    label: 'Narrative',
    id: input.nodeId,
    now: input.occurredAt,
    occurredAt: input.occurredAt,
    properties: {
      session_id: input.sessionId,
      scope: 'session',
      version: 1,
      coverage_key: coverageKey([input.sourceId]),
      coverage_count: 1,
      coverage: 1,
      grounding: NARRATIVE_GROUNDING,
      text: input.text,
      summary: input.text,
      citations: [input.sourceId],
    },
  });
  for (const edge of [
    { type: DERIVES_FROM_TYPE, sourceId: input.nodeId, targetId: input.sessionId },
    { type: SUMMARIZED_BY_TYPE, sourceId: input.sourceId, targetId: input.nodeId },
  ]) {
    await upsertEdge(driver, {
      ...edge,
      strength: 1,
      confidence: 1,
      signals: [],
      provenance: [],
      count: 0,
      now: input.occurredAt,
    });
  }
}

/** Everything a session family needs before it may choose chunks, then the choice itself. */
async function cutOver(sessionId: string, sourceId: string, cohortId: string): Promise<void> {
  await freezeLegacyCohort(chunks, { cohortId, now: NOW });
  rememberMigrationPolicy(store.db, cohortId, {
    ...CHUNK_BOUNDARY_POLICY,
    partitionPolicyVersion: 1,
  });
  await runLegacyBackfillBatch(chunks, { cohortId, now: NOW });
  await sealLegacyCohortCensus(chunks, { cohortId });
  const sealed = sealChunk(store.db, { sessionId, sourceIds: [sourceId], sealedAt: NOW });
  recordMigrationProgress(store.db, {
    cohortId,
    sourceId,
    status: 'verified',
    partitionAssignment: sealed.chunkId,
  });
  expect((await publishChunkNarrative(chunks, sealed.chunkId, { now: NOW })).status).toBe(
    'published',
  );
  expect((await cutoverSessionFamily(chunks, { sessionId, cohortId })).status).toBe('acknowledged');
  expect(readFamilyFence(store.db, sessionId)?.selection.family).toBe('chunk');
}

const LIVE = { node: 'legacy-live-window', at: new Date('2026-09-02T06:00:00.000Z') };
const RACED = { node: 'legacy-raced-window', at: new Date('2026-09-04T06:00:00.000Z') };
const ROLLED = { node: 'legacy-rolled-window', at: new Date('2026-09-08T06:00:00.000Z') };

it('rolls a live legacy session up exactly as before its family was recorded', async () => {
  const sourceId = await acceptSource('fence-live', 'the live session');
  const sessionId = sessionOf(sourceId);
  await seedLegacy({
    nodeId: LIVE.node,
    sessionId,
    sourceId,
    occurredAt: LIVE.at,
    text: 'The live session kept the whole-session representation it was written with.',
  });
  expect((await ensureSessionFamily(chunks, sessionId)).status).toBe('ready');
  expect(readFamilyFence(store.db, sessionId)?.selection.family).toBe('legacy_session_overview');

  expect(
    await fenceRollupWindow(deps(), {
      scope: 'day',
      windowKey: '2026-09-02',
      memberIds: [LIVE.node],
      now: NOW,
    }),
  ).toBeUndefined();

  const report = await rollUpNarratives(deps(), {
    scope: 'day',
    now: new Date('2026-09-03T06:00:00.000Z'),
    windowLimit: 3,
    renderedInputAllowance: 32768,
  });

  expect(report.created).toBe(1);
  expect(report.fenced).toBe(0);
  const [rollup] = await findWindowRollups(driver, 'day', '2026-09-02');
  expect(rollup?.open).toBe(true);
  expect(await supersedingNodeIds(driver, LIVE.node)).toEqual([rollup?.id]);
});

it('publishes nothing over a session whose family moved while the synthesis was running', async () => {
  const sourceId = await acceptSource('fence-raced', 'the raced session');
  const sessionId = sessionOf(sourceId);
  await seedLegacy({
    nodeId: RACED.node,
    sessionId,
    sourceId,
    occurredAt: RACED.at,
    text: 'The raced session was still whole-session when the calendar pass read it.',
  });
  expect((await ensureSessionFamily(chunks, sessionId)).status).toBe('ready');
  const before = drafts.length;
  suspended = () => cutOver(sessionId, sourceId, 'fence-raced-cohort');

  const report = await rollUpNarratives(deps(), {
    scope: 'day',
    now: new Date('2026-09-05T06:00:00.000Z'),
    windowLimit: 3,
    renderedInputAllowance: 32768,
  });

  // The model WAS asked, so this is the race and not a window refused before it started.
  expect(drafts).toHaveLength(before + 1);
  expect(report.created).toBe(0);
  expect(report.fenced).toBe(1);
  expect(await findWindowRollups(driver, 'day', '2026-09-04')).toEqual([]);

  // Nothing published, nothing absorbed: the narrative stands where it stood and its source still
  // reaches it.
  const properties = await nodeProperties(driver, RACED.node);
  expect(properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  expect(await supersedingNodeIds(driver, RACED.node)).toEqual([]);
  expect(await edgeValidUntil(driver, SUMMARIZED_BY_TYPE, sourceId, RACED.node)).toBeUndefined();

  // Settled now, so the next pass refuses before the synthesis and spends no call at all.
  const again = await rollUpNarratives(deps(), {
    scope: 'day',
    now: new Date('2026-09-05T06:00:00.000Z'),
    windowLimit: 3,
    renderedInputAllowance: 32768,
  });
  expect(again.fenced).toBe(1);
  expect(drafts).toHaveLength(before + 1);
  expect(
    await fenceRollupWindow(deps(), {
      scope: 'day',
      windowKey: '2026-09-04',
      memberIds: [RACED.node],
      now: NOW,
    }),
  ).toBe('legacy_family_changed');
});

it('refuses the week over a day summary whose own ancestry was retired, and moves neither', async () => {
  const sourceId = await acceptSource('fence-rolled', 'the rolled session');
  const sessionId = sessionOf(sourceId);
  await seedLegacy({
    nodeId: ROLLED.node,
    sessionId,
    sourceId,
    occurredAt: ROLLED.at,
    text: 'The rolled session was compressed into its day before the family moved.',
  });
  expect((await ensureSessionFamily(chunks, sessionId)).status).toBe('ready');

  const day = await rollUpNarratives(deps(), {
    scope: 'day',
    now: NOW,
    windowLimit: 3,
    renderedInputAllowance: 32768,
  });
  expect(day.created).toBe(1);
  const [summary] = await findWindowRollups(driver, 'day', '2026-09-08');
  const summaryId = summary?.id ?? '';
  expect(summaryId).not.toBe('');

  // The day summary exists, and only now does its session choose the other representation.
  await cutOver(sessionId, sourceId, 'fence-rolled-cohort');
  expect(
    await fenceRollupWindow(deps(), {
      scope: 'week',
      windowKey: '2026-W37',
      memberIds: [summaryId],
      now: NOW,
    }),
  ).toBe('legacy_family_changed');

  const week = await rollUpNarratives(deps(), {
    scope: 'week',
    now: new Date('2026-09-14T06:00:00.000Z'),
    windowLimit: 3,
    renderedInputAllowance: 32768,
  });

  // The week holding the live day summary still publishes; the one above the retired ancestry
  // does not, and the summary it would have absorbed is untouched: no close, no supersession, no
  // new stamp of any kind.
  expect(week.created).toBe(1);
  expect(week.fenced).toBe(1);
  const published = await findWindowRollups(driver, 'week', '2026-W36');
  expect(published).toHaveLength(1);
  expect(await findWindowRollups(driver, 'week', '2026-W37')).toEqual([]);
  const properties = await nodeProperties(driver, summaryId);
  expect(properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  expect(properties[ROLLUP_WINDOW_PROPERTY]).toBe('2026-09-08');
  expect(await supersedingNodeIds(driver, summaryId)).toEqual([]);
  expect(await edgeValidUntil(driver, SUMMARIZED_BY_TYPE, ROLLED.node, summaryId)).toBeUndefined();
});

it('never carries a node of the signed overview family into a legacy week summary', async () => {
  // A day overview carries the day scope, so the legacy week pass nominates it exactly as it
  // nominates its own day summaries. Its family is what keeps it out of what that pass absorbs:
  // an overview closes its own prior head through the coordinator, never through a raw calendar
  // supersession taken over it from outside.
  const at = new Date('2026-09-16T06:00:00.000Z');
  await writeStampedNode(driver, {
    label: 'Narrative',
    id: 'signed-day-overview',
    now: at,
    occurredAt: at,
    properties: {
      text: 'What the published chunks of that day said.',
      summary: 'What the published chunks of that day said.',
      [NARRATIVE_PROPERTIES.scope]: 'day',
      [NARRATIVE_PROPERTIES.family]: 'overview',
      [NARRATIVE_PROPERTIES.revisionNo]: 1,
      [NARRATIVE_PROPERTIES.version]: 1,
      [NARRATIVE_PROPERTIES.coverageKey]: 'day:2026-09-16',
      [NARRATIVE_PROPERTIES.coverageCount]: 1,
      [NARRATIVE_PROPERTIES.coverage]: 1,
      [ROLLUP_WINDOW_PROPERTY]: '2026-09-16',
      [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    },
  });

  expect(
    await fenceRollupWindow(deps(), {
      scope: 'week',
      windowKey: '2026-W38',
      memberIds: ['signed-day-overview'],
      now: NOW,
    }),
  ).toBe('legacy_family_foreign');

  const week = await rollUpNarratives(deps(), {
    scope: 'week',
    now: new Date('2026-09-21T06:00:00.000Z'),
    windowLimit: 3,
    renderedInputAllowance: 32768,
  });

  expect(week.created).toBe(0);
  expect(await findWindowRollups(driver, 'week', '2026-W38')).toEqual([]);
  expect(await supersedingNodeIds(driver, 'signed-day-overview')).toEqual([]);
  expect(
    (await nodeProperties(driver, 'signed-day-overview'))[BITEMPORAL_PROPERTIES.validUntil],
  ).toBeUndefined();
});
