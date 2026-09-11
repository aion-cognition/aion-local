import { afterEach, expect, it, vi } from 'vitest';

import { cutOver, deps, seedLegacy } from './c3ru-astra.fixture.js';
import { ensureSessionFamily } from './narrative-family.js';
import { rollUpNarratives } from './narrative-rollup.js';
import { bindRollupCoverage, proveRollupFamily } from './rollup-family-fence.js';
import * as publishing from './rollup-publish.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { findWindowRollups } from '../../infrastructure/graph/narrative-rollup-queries.js';
import {
  nodeProperties,
  supersedingNodeIds,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { rollupNodeId } from '../domain/consolidation.js';
import { coverageKey } from '../domain/narrative.js';

/** The binding the pass takes before its member read, which a direct proof call has to supply. */
function binding() {
  const held = bindRollupCoverage(store.db, NOW);
  if (held === undefined) {
    throw new Error('the fixture substrate has no readable coverage contract');
  }
  return held;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('refuses a cutover that completes after the last family reading and before publication', async () => {
  const sourceId = await acceptSource('last-fence', 'last family reading');
  const sessionId = sessionOf(sourceId);
  const id = 'last-fence-member';
  await seedLegacy({
    nodeId: id,
    sessionId,
    sourceId,
    occurredAt: new Date('2026-09-04T06:00:00Z'),
    text: 'This legacy session has a newer representation.',
  });
  expect((await ensureSessionFamily(chunks, sessionId)).status).toBe('ready');
  // The equivalent final boundary after the conversion: the pass has proved the family, spent its
  // model call, and is handing the window to the coordinator. The cutover commits in that gap.
  const original = publishing.publishCalendarRollup;
  let attempts = 0;
  vi.spyOn(publishing, 'publishCalendarRollup').mockImplementation(async (...args) => {
    if (args[1].closes.includes(id) || args[1].memberIds.includes(id)) {
      attempts += 1;
      expect(args[1].proof.ownedIds).toContain(id);
      await cutOver(sessionId, sourceId, 'last-fence-cohort');
    }
    return original(...args);
  });
  await rollUpNarratives(deps(), {
    scope: 'day',
    now: new Date('2026-09-05T06:00:00Z'),
    windowLimit: 3,
    renderedInputAllowance: 32768,
  });
  expect(attempts).toBe(1);
  expect.soft(await findWindowRollups(driver, 'day', '2026-09-04')).toEqual([]);
  expect.soft(await supersedingNodeIds(driver, id)).toEqual([]);
  expect.soft((await nodeProperties(driver, id)).valid_until).toBeUndefined();
});

it('refuses an unreadable family registry instead of treating a cutover source as uninitialized', async () => {
  store.db.exec('ALTER TABLE family_selection_log RENAME TO review_held_family_selection');
  try {
    expect(
      (
        await proveRollupFamily(deps(), {
          scope: 'day',
          windowKey: '2026-09-04',
          memberIds: ['last-fence-member'],
          headIds: [],
          coverage: binding(),
          now: NOW,
        })
      ).status,
    ).toBe('refused');
  } finally {
    store.db.exec('ALTER TABLE review_held_family_selection RENAME TO family_selection_log');
  }
});

it.each(['create', 'repair'] as const)(
  'never closes a foreign existing head through the %s branch',
  async (mode) => {
    const day = mode === 'create' ? '2026-10-01' : '2026-10-02';
    const ids: string[] = [];
    for (const ordinal of [1, 2]) {
      const id = `closure-${mode}-${String(ordinal)}`;
      const sourceId = await acceptSource(`session-${id}`, id);
      const sessionId = sessionOf(sourceId);
      await seedLegacy({
        nodeId: id,
        sessionId,
        sourceId,
        occurredAt: new Date(`${day}T06:00:00Z`),
        text: 'The legacy session still selects its own family.',
      });
      expect((await ensureSessionFamily(chunks, sessionId)).status).toBe('ready');
      ids.push(id);
    }
    const key = coverageKey(ids);
    const foreignId = `foreign-head-${mode}`;
    const at = new Date(`${day}T06:00:00Z`);
    await writeStampedNode(driver, {
      label: 'Narrative',
      id: foreignId,
      now: at,
      occurredAt: at,
      properties: {
        scope: 'day',
        narrative_family: 'overview',
        version: 1,
        coverage_count: 1,
        coverage_key: 'different-members',
        window_key: day,
        text: 'A manifest-owned overview.',
        summary: 'A manifest-owned overview.',
      },
    });
    if (mode === 'repair') {
      await writeStampedNode(driver, {
        label: 'Narrative',
        id: rollupNodeId('day', day, key),
        now: at,
        occurredAt: at,
        properties: {
          scope: 'day',
          version: 2,
          coverage_count: ids.length,
          coverage_key: key,
          window_key: day,
          text: 'An already-written legacy calendar.',
          summary: 'An already-written legacy calendar.',
        },
      });
    }
    await rollUpNarratives(deps(), {
      scope: 'day',
      now: new Date('2026-10-04T00:00:00Z'),
      windowLimit: 5,
      renderedInputAllowance: 32768,
    });
    expect.soft(await supersedingNodeIds(driver, foreignId)).toEqual([]);
    expect.soft((await nodeProperties(driver, foreignId)).valid_until).toBeUndefined();
  },
);
