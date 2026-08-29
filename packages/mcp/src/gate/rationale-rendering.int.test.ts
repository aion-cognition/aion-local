import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countQueueJobs } from '@aion/core';
import { GateSubstrate, waitFor } from './gate-substrate.fixture.js';
import { heldOutCase } from './held-out-recall.fixture.js';

/**
 * The refund-locking case end to end: a Decision node whose rationale the shipped pipeline
 * actually extracts, recalled by a question that asks for the reason rather than the choice
 * itself. The check is the rendered `why:` line, since a pack that carries the decision but
 * drops its own stated reason reads exactly like one that never selected the property at all.
 *
 * Forced onto the local model rather than the default routing: the Anthropic route's
 * system-prompt schema delivery returns a `type` value cognitive extraction's schema rejects
 * for this exact episode, every time, at temperature zero, so the default route never produces
 * a Decision node here at all. That is a defect in extraction, not in the selection and
 * rendering this probe checks, so it stays out of the assertion by picking the route that
 * extracts cleanly.
 */

const WRITE_SESSION = 'gate-rationale-write';
const READ_SESSION = 'gate-rationale-read';

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-01T10:05:00.000Z');

const ENRICH_DEADLINE_MS = 300_000;

const substrate = new GateSubstrate('rationale-rendering');
let episodeId = '';
let previousGenerationRoute: string | undefined;

beforeAll(async () => {
  previousGenerationRoute = process.env.TEST_AION_GENERATION;
  process.env.TEST_AION_GENERATION = 'local';
  await substrate.open();

  const held = heldOutCase('refund-locking');
  const stored = await substrate.store(
    { observations: [...held.observations] },
    { identity: WRITE_SESSION, now: STORED_AT },
  );
  episodeId = stored.episode_id;

  const worker = substrate.worker();
  await worker.start();
  await waitFor('the refund-locking episode to enrich', ENRICH_DEADLINE_MS, () => {
    if (substrate.enriched(episodeId)) {
      return Promise.resolve(true);
    }
    const queue = countQueueJobs(substrate.db, {}, substrate.config.operational.workerMaxAttempts);
    return Promise.resolve(queue.pending === 0 && queue.claimed === 0);
  });
  await worker.stop();
}, 600_000);

afterAll(async () => {
  await substrate.close();
  if (previousGenerationRoute === undefined) {
    delete process.env.TEST_AION_GENERATION;
  } else {
    process.env.TEST_AION_GENERATION = previousGenerationRoute;
  }
});

describe('a decision node renders the reason behind it', () => {
  it('answers why postgres beat redis with the why line present in rendered_text', async () => {
    const result = await substrate.recall(
      'why did we go with postgres instead of redis for refund locking',
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    const decision = result.items.find((item) => item.content.toLowerCase().includes('row-level'));
    expect(decision).toBeDefined();
    expect(decision?.why).toBeTruthy();
    expect(result.pack.rendered_text).toContain(`why: ${decision?.why ?? ''}`);
  }, 180_000);
});
