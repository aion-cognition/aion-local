import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countQueueJobs, findEpisodeCognitiveNodes } from '@aion/core';
import { nodeProperties } from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import { GateSubstrate, waitFor } from './gate-substrate.fixture.js';
import { heldOutCase } from './held-out-recall.fixture.js';

/**
 * The refund-locking case end to end: a Decision node whose rationale the shipped pipeline
 * actually extracts, recalled by a question that asks for the reason rather than the choice
 * itself. The check is the rendered `why:` line, since a pack that carries the decision but
 * drops its own stated reason reads exactly like one that never selected the property at all.
 *
 * The decision is found by its node id rather than by its words. Half the substrate this
 * episode produces mentions the row-level lock, only the Decision carries a reason for it,
 * and which of them a pack ranks first moves from run to run: matching on the text passes or
 * fails on the ranking rather than on the property under test.
 */

const WRITE_SESSION = 'gate-rationale-write';
const READ_SESSION = 'gate-rationale-read';

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-01T10:05:00.000Z');

const ENRICH_DEADLINE_MS = 300_000;

const substrate = new GateSubstrate('rationale-rendering');
let episodeId = '';
let decisionId = '';
/**
 * The reason as the graph holds it. This one sits under the pack's character cap, so the
 * rendered line carries the same string the property does.
 */
let storedReason = '';

beforeAll(async () => {
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

  const cognitive = await findEpisodeCognitiveNodes(substrate.driver, episodeId);
  const decision = cognitive.find((node) => node.label === 'Decision');
  decisionId = decision?.id ?? '';
  if (decisionId !== '') {
    const properties = await nodeProperties(substrate.driver, decisionId);
    storedReason = String(properties.rationale ?? '');
  }
}, 600_000);

afterAll(async () => {
  await substrate.close();
});

describe('a decision node renders the reason behind it', () => {
  it('answers why postgres beat redis with the why line present in rendered_text', async () => {
    const result = await substrate.recall(
      'why did we go with postgres instead of redis for refund locking',
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    console.log(
      `decision ${decisionId.slice(0, 8)} stored reason: ${storedReason}\n` +
        result.items
          .map(
            (item) =>
              `    rank ${String(item.rank)} why=${String(item.why)} ${item.content.slice(0, 60)}`,
          )
          .join('\n'),
    );

    // Extraction wrote a reason for the choice, so the pack has to carry that node and the
    // reason with it. An empty stored reason means this run's extraction produced no decision
    // to render, which is a different failure and says so here rather than passing quietly.
    expect(storedReason).not.toBe('');
    const decision = result.items.find((item) => item.id === decisionId);
    expect(decision).toBeDefined();
    expect(decision?.why).toBe(storedReason);
    expect(result.pack.rendered_text).toContain(`why: ${storedReason}`);
  }, 180_000);
});
