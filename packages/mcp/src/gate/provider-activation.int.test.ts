import { isLedgerApplied, PIPELINE_VERSION, type ReflectionWorker } from '@aion/core';
import { PROVIDER_KEY_ENV_VARS } from '@aion/core/infrastructure/providers/routing.js';
import { GENERATION_PROVIDERS } from '@aion/core/infrastructure/providers/types.js';
import { getLedgerEntry } from '@aion/core/infrastructure/sqlite/ops-ledger.js';
import { deadLetterOperation } from '@aion/core/introspection/application/operations/dead-letter.js';
import type { OperationContext } from '@aion/core/introspection/domain/operation.js';
import { healthFixture } from '@aion/core/introspection/domain/test-support/health.fixture.js';
import { orchestratorLedgerKey } from '@aion/core/reflection/application/orchestrator.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GateSubstrate, REMOTE_JUDGE_ABSENT, waitFor } from './gate-substrate.fixture.js';

/**
 * One installation's generation provider, end to end, with only that provider's key: a fresh
 * reflection through the shipped pipeline, a recall the model assesses, and an exhausted job
 * `dead_letter` takes back on its own once its conditions change.
 *
 * It never runs by default. It spends money: `AION_PROVIDER_CHECK=1` opts in, and
 * `AION_GENERATION_PROVIDER` selects the provider whose key must be the only one exported. The
 * other provider's key being set fails the run, since the claim is that one key is enough.
 *
 * The exhaustion is induced. The job's attempt count is written to the ceiling, which is the state
 * a real failure leaves; `dead-letter-recovery.test.ts` covers a worker failing for real. What this
 * file shows is the recovery running unattended against a live model: the first retry, the hold
 * under unchanged conditions, and the reconsidered cycle after a build change completing.
 */

const ENABLED = process.env.AION_PROVIDER_CHECK === '1' && !REMOTE_JUDGE_ABSENT;

const ENRICH_DEADLINE_MS = 900_000;

const WRITER = 'provider-check-writer';

const READER = 'provider-check-reader';

const EPISODES = [
  {
    turns: [
      {
        role: 'user',
        text: 'The halyard ingest worker keeps falling behind when it polls Postgres. Options?',
      },
      {
        role: 'assistant',
        text:
          'We decided to move the halyard ingest worker off Postgres polling and onto the Valkey ' +
          'queue. Priya owns the cutover, planned for Tuesday.',
      },
    ],
    summary: 'moved the halyard ingest worker onto the Valkey queue',
  },
  {
    turns: [
      {
        role: 'assistant',
        text:
          'The orders connection pool was resized from 20 to 60 slots after the June checkout ' +
          'outage, which was caused by pool exhaustion.',
      },
    ],
    summary: 'orders pool resized after the June outage',
  },
  {
    turns: [
      {
        role: 'assistant',
        text:
          'Cutover done: the halyard ingest worker now reads from Valkey and drains about 40 ' +
          'jobs a second at peak. Postgres polling is switched off.',
      },
    ],
    summary: 'halyard cutover to Valkey completed',
  },
] as const;

const DEAD_LETTER_EPISODE = {
  turns: [
    {
      role: 'assistant',
      text: 'The ledger export job runs nightly at 02:00 UTC and writes to the finance bucket.',
    },
  ],
  summary: 'ledger export schedule',
} as const;

describe.skipIf(!ENABLED)('one generation provider with only its own key', () => {
  const substrate = new GateSubstrate('provider-check');
  let worker: ReflectionWorker;
  const buildBefore = process.env.AION_BUILD_SHA;
  let deadLetterEpisode = '';

  function operationContext(): OperationContext {
    return {
      driver: substrate.driver,
      db: substrate.db,
      config: substrate.config,
      logger: substrate.logger,
      provider: substrate.provider,
      health: healthFixture(),
      now: new Date(),
      signal: new AbortController().signal,
      intake: substrate.intakeDeps(),
    };
  }

  function jobFor(episodeId: string): { id: string; attempts: number } | undefined {
    return substrate.db
      .prepare('SELECT id, attempts FROM reflection_queue WHERE episode_id = ?')
      .get(episodeId) as { id: string; attempts: number } | undefined;
  }

  /** Writes the attempt count to the ceiling, the state a job that failed every attempt is in. */
  function exhaust(jobId: string): void {
    substrate.db
      .prepare(
        `UPDATE reflection_queue SET attempts = ?, claimed_at = NULL, claimed_by = NULL,
           last_error = 'induced by the provider check' WHERE id = ?`,
      )
      .run(substrate.config.operational.workerMaxAttempts, jobId);
  }

  beforeAll(async () => {
    await substrate.open();
    worker = substrate.worker();
  }, 300_000);

  afterAll(async () => {
    if (buildBefore === undefined) {
      delete process.env.AION_BUILD_SHA;
    } else {
      process.env.AION_BUILD_SHA = buildBefore;
    }
    await worker.stop();
    await substrate.close();
  });

  it('runs with the selected provider key alone', () => {
    const selected = substrate.config.generation.provider;
    for (const other of GENERATION_PROVIDERS.filter((provider) => provider !== selected)) {
      expect((process.env[PROVIDER_KEY_ENV_VARS[other]] ?? '').trim()).toBe('');
    }
    console.log(`PROVIDER CHECK route ${JSON.stringify(substrate.provider.route)}`);
    expect(substrate.provider.route?.provider).toBe(selected);
  });

  it('takes an exhausted job back on its own, holds it under unchanged conditions, and retries it after a build change', async () => {
    process.env.AION_BUILD_SHA = 'provider-check-build-a';
    const stored = await substrate.store(DEAD_LETTER_EPISODE, { identity: WRITER });
    deadLetterEpisode = stored.episode_id;
    const job = jobFor(deadLetterEpisode);
    expect(job).toBeDefined();
    const jobId = job!.id;
    const deadLetter = deadLetterOperation();

    exhaust(jobId);
    const first = await deadLetter.run(operationContext());
    console.log(`PROVIDER CHECK dead_letter first: ${first.detail ?? ''}`);
    expect(first.detail).toContain('1 relaned to bulk for a first retry');
    expect(jobFor(deadLetterEpisode)?.attempts).toBe(0);

    // The retry failed the same way, under the same build, route and evidence.
    exhaust(jobId);
    const held = await deadLetter.run(operationContext());
    console.log(`PROVIDER CHECK dead_letter unchanged: ${held.detail ?? ''}`);
    expect(held.detail).toContain('0 reconsidered');
    expect(held.detail).toContain('1 exhausted again under conditions already tried');
    expect(jobFor(deadLetterEpisode)?.attempts).toBe(
      substrate.config.operational.workerMaxAttempts,
    );

    // A new build is a changed condition, and nobody asks for the retry.
    process.env.AION_BUILD_SHA = 'provider-check-build-b';
    const reconsidered = await deadLetter.run(operationContext());
    console.log(`PROVIDER CHECK dead_letter changed: ${reconsidered.detail ?? ''}`);
    expect(reconsidered.detail).toContain('1 reconsidered under changed conditions');

    const marker = getLedgerEntry(substrate.db, `intro:dead_letter:seen:${jobId}`)?.summary as
      { retries?: unknown[] } | undefined;
    expect(marker?.retries).toHaveLength(2);

    await worker.start();
    await waitFor('the reconsidered job to complete', ENRICH_DEADLINE_MS, () =>
      Promise.resolve(substrate.enriched(deadLetterEpisode)),
    );
    expect(jobFor(deadLetterEpisode)).toBeUndefined();
  }, 1_200_000);

  it('reflects fresh episodes through the shipped pipeline', async () => {
    const ids: string[] = [];
    for (const episode of EPISODES) {
      ids.push((await substrate.store(episode, { identity: WRITER })).episode_id);
    }
    await waitFor('the fresh episodes to enrich', ENRICH_DEADLINE_MS, () =>
      Promise.resolve(ids.every((id) => substrate.enriched(id))),
    );
    await worker.whenIdle();

    for (const id of ids) {
      expect(isLedgerApplied(substrate.db, orchestratorLedgerKey(PIPELINE_VERSION, id))).toBe(true);
      const summary = getLedgerEntry(substrate.db, orchestratorLedgerKey(PIPELINE_VERSION, id))
        ?.summary as { stages?: { name?: string; status?: string }[] } | undefined;
      const stages = (summary?.stages ?? []).map((stage) => `${stage.name}:${stage.status}`);
      console.log(`PROVIDER CHECK reflection ${id}: ${stages.join(' ')}`);
    }
    const leftover = substrate.db
      .prepare('SELECT id, job_type, attempts, last_error FROM reflection_queue')
      .all();
    console.log(`PROVIDER CHECK queue after reflection: ${JSON.stringify(leftover)}`);
    expect(leftover).toEqual([]);
  }, 1_200_000);

  it('assesses a recall on the selected provider', async () => {
    const result = await substrate.recall('what did we decide about the halyard ingest worker', {
      identity: READER,
    });
    const { assessment } = result.pack.metadata;
    console.log(`PROVIDER CHECK recall assessment: ${JSON.stringify(assessment)}`);
    console.log(
      `PROVIDER CHECK recall items: ${JSON.stringify(result.items.map((item) => item.content.slice(0, 90)))}`,
    );
    expect(assessment?.outcome).toBe('selected');
    expect(assessment?.provider).toBe(substrate.config.generation.provider);
    expect(result.pack.metadata.degraded ?? []).not.toContainEqual(
      expect.objectContaining({ stage: 'assessment' }),
    );
    expect(result.items.length).toBeGreaterThan(0);
  }, 300_000);
});
