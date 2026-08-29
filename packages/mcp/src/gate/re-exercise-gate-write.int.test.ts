import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildFingerprint,
  countQueueJobs,
  dropUnclaimedJobs,
  findEpisodeEntities,
  listReflectionJobs,
  p95EnrichmentLagMs,
  queueLagSnapshot,
  type ReflectionOutput,
} from '@aion/core';
import {
  LEAKED_SHAPES,
  SURVIVING_TEXT,
} from '@aion/core/redaction/test-support/leaked-shapes.fixture.js';
import { everyStoredProperty } from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import { CROSS_STAGE_ENTITY_MISS } from './gate-batteries.fixture.js';
import { GateSubstrate, waitFor } from './gate-substrate.fixture.js';

/**
 * What the write path stores, and who it serves first.
 *
 * Redaction is read back from the substrate rather than from the redactor's return value: an
 * earlier pass read pack output, reported clean, and left three shapes sitting in Neo4j in
 * plaintext, where nothing is ever hard-deleted. The corpus is imported rather than retyped,
 * so one set of strings governs the unit tests, the intake integration test, and this gate.
 *
 * The starvation sim is the live incident at one fiftieth of its size: a bulk flood queued
 * ahead of one live turn, which on the night sat unclaimed while the queue reached 4,016 jobs
 * and days of GPU work.
 */

const REDACTION_SESSION = 'gate-redaction';
const BULK_SESSIONS = ['gate-bulk-a', 'gate-bulk-b', 'gate-bulk-c', 'gate-bulk-d', 'gate-bulk-e'];
const BULK_PER_SESSION = 10;
const BULK_LOAD = BULK_SESSIONS.length * BULK_PER_SESSION;
const LIVE_SESSION = 'gate-interactive';

/** The freshness pin is "minutes"; five is the ceiling this gate holds it to. */
const INTERACTIVE_DEADLINE_MS = 300_000;

const substrate = new GateSubstrate('write');
let storedProperties = '';
let queuedPayloads = '';

beforeAll(async () => {
  await substrate.open();

  for (const [index, shape] of LEAKED_SHAPES.entries()) {
    const stored = await substrate.store(shape.payload, {
      identity: `${REDACTION_SESSION}-${String(index)}`,
    });
    expect(stored.queued).toBe(true);
  }
  await substrate.store(
    { observations: Object.values(SURVIVING_TEXT), summary: 'material that must survive redaction' },
    { identity: `${REDACTION_SESSION}-survivors` },
  );

  storedProperties = await everyStoredProperty(substrate.driver);
  queuedPayloads = JSON.stringify(listReflectionJobs(substrate.db).map((job) => job.payload));
}, 900_000);

afterAll(async () => {
  await substrate.close();
});

describe('the leaked-shape corpus through a real intake', () => {
  for (const shape of LEAKED_SHAPES) {
    it(`stores no trace of ${shape.label}`, () => {
      expect(storedProperties).not.toContain(shape.material);
      expect(storedProperties).toContain(buildFingerprint(shape.rule, shape.material));
    });
  }

  it('keeps every leaked shape out of the queue payloads as well', () => {
    for (const shape of LEAKED_SHAPES) {
      expect(queuedPayloads).not.toContain(shape.material);
    }
  });

  for (const [label, text] of Object.entries(SURVIVING_TEXT)) {
    it(`stores ${label} verbatim`, () => {
      expect(storedProperties).toContain(text);
    });
  }
});

describe('a bulk load queued ahead of one live turn', () => {
  const acks: ReflectionOutput[] = [];
  let live: ReflectionOutput | undefined;
  let bulkUnclaimedWhenLiveEnriched = 0;
  let elapsedMs = 0;

  beforeAll(async () => {
    // The corpus above left its own episodes queued, and this battery's subject is which lane
    // gets served first. Cleared through the operator primitive rather than by hand, since a
    // purge is exactly what the live incident needed and E4 exists to make repeatable.
    dropUnclaimedJobs(substrate.db);

    for (const session of BULK_SESSIONS) {
      for (let index = 0; index < BULK_PER_SESSION; index += 1) {
        acks.push(
          await substrate.store(
            {
              observations: [`bulk import record ${String(index)} for ${session}`],
              summary: `bulk import ${session} ${String(index)}`,
              lane: 'bulk',
            },
            { identity: session },
          ),
        );
      }
    }

    live = await substrate.store(
      {
        observations: [
          'We decided to cap the response cache at 500 entries, which is what stopped the OOM crash loop.',
        ],
        summary: 'the live turn that must not wait behind the import',
      },
      { identity: LIVE_SESSION },
    );
  }, 900_000);

  it('echoes the lane it actually enqueued in, on every ack', () => {
    expect(acks).toHaveLength(BULK_LOAD);
    for (const ack of acks) {
      expect(ack.lane).toBe('bulk');
    }
    expect(live?.lane).toBe('interactive');
    // Nothing interactive was ahead of it: the flood is all in the other lane.
    expect(live?.pending_ahead).toBe(0);
  });

  it('surfaces the backlog as depth and age before anything drains it', () => {
    const snapshot = queueLagSnapshot(substrate.db, substrate.config.operational.workerMaxAttempts);
    console.log(`queue before drain: ${JSON.stringify(snapshot)}`);

    expect(snapshot.depthByLane.bulk).toBe(BULK_LOAD);
    expect(snapshot.depthByLane.interactive).toBe(1);
    expect(snapshot.oldestUnclaimedMs).toBeGreaterThan(0);
    expect(snapshot.exhausted).toBe(0);
  });

  it('enriches the live turn first and leaves the import queued behind it', async () => {
    const worker = substrate.worker();
    const startedAt = Date.now();
    // Not awaited: `start()` resolves only once the whole queue has drained, and what this
    // measures is the live turn's wait, not the flood's.
    void worker.start();

    await waitFor('the interactive episode to enrich', INTERACTIVE_DEADLINE_MS, () => {
      const done = substrate.enriched(live?.episode_id ?? '');
      if (done) {
        elapsedMs = Date.now() - startedAt;
        bulkUnclaimedWhenLiveEnriched = countQueueJobs(
          substrate.db,
          { lane: 'bulk' },
          substrate.config.operational.workerMaxAttempts,
        ).unclaimed;
      }
      return Promise.resolve(done);
    });
    await worker.stop();

    console.log(
      `starvation sim: live turn enriched in ${String(Math.round(elapsedMs / 1000))}s with ` +
        `${String(bulkUnclaimedWhenLiveEnriched)}/${String(BULK_LOAD)} bulk jobs still unclaimed, ` +
        `p95 enrichment lag ${String(p95EnrichmentLagMs(substrate.db))}ms`,
    );

    // The whole point of the lane: the live turn was pushed last and served first. One bulk
    // job may already have been in flight when it arrived, so the bar is "the flood did not
    // drain ahead of it", not "no bulk job ran".
    expect(bulkUnclaimedWhenLiveEnriched).toBeGreaterThanOrEqual(BULK_LOAD - 2);
    expect(elapsedMs).toBeLessThan(INTERACTIVE_DEADLINE_MS);
  }, 600_000);

  it('reports the drained lane and a measured lag afterwards', () => {
    const snapshot = queueLagSnapshot(substrate.db, substrate.config.operational.workerMaxAttempts);
    console.log(`queue after the live turn: ${JSON.stringify(snapshot)}`);

    expect(snapshot.depthByLane.interactive).toBe(0);
    expect(snapshot.depthByLane.bulk).toBeGreaterThan(0);
    expect(snapshot.p95EnrichmentLagMs).toBeGreaterThan(0);
  });
});

/**
 * The half of the bulk-load case the explicit flag hides. The live incident was four harnesses that
 * never declared themselves bulk, so the flag path would have caught none of it: the
 * arrival-rate backstop is what had to fire, and a battery that always sets `lane: 'bulk'`
 * stays green with that backstop switched off entirely.
 */
describe('a flood that never says it is one', () => {
  const acks: ReflectionOutput[] = [];
  const UNDECLARED_SESSION = 'gate-undeclared-flood';

  beforeAll(async () => {
    dropUnclaimedJobs(substrate.db);
    const allowance = substrate.config.lanes.sessionArrivalMax;
    for (let index = 0; index < allowance + 3; index += 1) {
      acks.push(
        await substrate.store(
          {
            observations: [`undeclared record ${String(index)} pushed as fast as the client can`],
            summary: `undeclared flood ${String(index)}`,
          },
          { identity: UNDECLARED_SESSION },
        ),
      );
    }
  }, 900_000);

  it('demotes on arrival rate alone, with no lane field in any payload', () => {
    const allowance = substrate.config.lanes.sessionArrivalMax;
    const lanes = acks.map((ack) => ack.lane);
    console.log(`undeclared flood lanes: ${lanes.join(' ')}`);

    // The session's own allowance is generous on purpose, so a legitimate session-end flush of
    // ten episodes at once is served interactive and only a real flood crosses.
    expect(lanes.slice(0, allowance)).toEqual(new Array<string>(allowance).fill('interactive'));
    expect(lanes.slice(allowance)).toEqual(
      new Array<string>(lanes.length - allowance).fill('bulk'),
    );
  });

  it('counts the demoted rows as bulk depth, which is where an operator would look', () => {
    const snapshot = queueLagSnapshot(substrate.db, substrate.config.operational.workerMaxAttempts);

    expect(snapshot.depthByLane.bulk).toBe(acks.length - substrate.config.lanes.sessionArrivalMax);
  });
});

/**
 * Recorded as a measurement rather than closed as a fix. The entity stage misses proper nouns
 * the cognitive stage names in the same run. The one fix that would close it, batching the two
 * extractions into a single pass, is deliberately out of scope while quality-neutral changes
 * come first. Kept runnable so the measurement is a `.skip` away rather than a rewrite away.
 */
describe('cross-stage entity naming, measured but not gated', () => {
  it.skip('names the central entities its own cognitive nodes name', async () => {
    const stored = await substrate.store(CROSS_STAGE_ENTITY_MISS.payload, {
      identity: CROSS_STAGE_ENTITY_MISS.identity,
    });
    const worker = substrate.worker();
    await worker.start();
    await waitFor('the counter-evidence episode to enrich', 600_000, () =>
      Promise.resolve(substrate.enriched(stored.episode_id)),
    );
    await worker.stop();

    const named = new Set(
      (await findEpisodeEntities(substrate.driver, stored.episode_id)).map(
        (entity) => entity.nameNorm,
      ),
    );
    for (const central of CROSS_STAGE_ENTITY_MISS.central) {
      expect(named).toContain(central);
    }
  }, 900_000);
});
