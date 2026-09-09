import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RecallDeps } from './recall.js';
import {
  ClaimProvenanceSubstrate,
  OFF_TOPIC,
  RECALLED_AT,
  ROOT_ID,
  SEEDED_AT,
} from './test-support/claim-provenance.fixture.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { fetchClaimProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listStatedLinks } from '../../infrastructure/sqlite/evidence-links.js';
import { getExperienceByEpisode } from '../../infrastructure/sqlite/experience-archive.js';
import {
  findPendingReflectionJob,
  listReflectionJobs,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import type { ReflectionRun } from '../../reflection/application/orchestrator.js';
import { ReflectionWorker } from '../../reflection/application/worker.js';
import {
  directCompletionPublisher,
  directIntakePublisher,
} from '../../reflection/test-support/direct-intake.fixture.js';

/**
 * A reference the substrate accepted has to survive an interrupted acceptance, a target the graph
 * does not hold, the archive already holding the content, and the job that would have written it
 * finishing first. Every case here ends with the reference readable, or says which write was lost.
 */

const substrate = new ClaimProvenanceSubstrate('claim-provenance-references');

let db: SqliteHandle;
let logger: Logger;
let provider: Provider;
let deps: RecallDeps;

beforeAll(async () => {
  await substrate.open();
  ({ db, logger, provider, deps } = substrate);
}, 300_000);

afterAll(async () => {
  await substrate.close();
});

/**
 * An acceptance is one publication: the reference records and the edges they stand for land
 * together under one receipt, or neither does and a recovery finishes what the receipt says was
 * committed. That is where the durability lives now. The archive payload does not carry
 * provenance and the worker does not re-state it: statements travel as their own accepted batch,
 * which is what `reference-acceptance.ts` records and what `intake-publication.ts` projects.
 */

/** The targets a source's accepted batch records, narrowed to what a publication acknowledged. */
function committedTargets(sourceId: string, kind = 'derived_from'): readonly string[] {
  return listStatedLinks(db, sourceId)
    .filter((link) => link.kind === kind && link.knownFrom !== null)
    .map((link) => link.toId);
}

const passingRunner = {
  run: (episodeId: string) =>
    Promise.resolve({
      episodeId,
      status: 'completed' as const,
      applied: true,
      summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
    }),
};

/** One ordinary pass of the worker, for a job an earlier attempt left claimable. */
async function drain(): Promise<void> {
  const worker = heldWorker(passingRunner);
  try {
    await worker.start();
    await worker.whenIdle();
  } finally {
    await worker.stop();
  }
}

async function rootsOf(id: string): Promise<readonly string[] | undefined> {
  const rows = await fetchClaimProvenance(substrate.driver, {
    ids: [id],
    maxRoots: 3,
    mode: withCurrency(RECALLED_AT),
  });
  return rows.get(id)?.roots;
}

function reflectionDeps(overrides: Partial<Parameters<typeof handleReflection>[0]> = {}) {
  return {
    driver: substrate.driver,
    db,
    sessions: deps.sessions,
    provider,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications: directIntakePublisher(substrate.driver, db),
    acceptHookCapture: true,
    ...overrides,
  };
}

function heldWorker(runner: { run: (id: string) => Promise<ReflectionRun> }): ReflectionWorker {
  return new ReflectionWorker(
    {
      driver: substrate.driver,
      db,
      provider,
      logger,
      runner,
      publications: directCompletionPublisher(substrate.driver, db),
      resolver: new EvidenceResolver({
        driver: substrate.driver,
        db,
        logger: { warn: () => undefined },
      }),
    },
    { clock: () => SEEDED_AT },
  );
}

/**
 * The three shapes that let an accepted reference go missing: a source that points at an
 * extracted claim rather than a capture, a chain that loops back on itself, and a re-push that
 * adds references to content the archive already holds.
 */
describe('references the substrate has to keep hold of', () => {
  it("retains an extracted source claim's capture root through a stated derivation", async () => {
    const claimId = 'fix-review-source-claim';
    await substrate.writeClaim(claimId, 'a claim extracted from the common root', OFF_TOPIC);
    await upsertEdge(substrate.driver, {
      type: 'EXTRACTED_FROM',
      sourceId: claimId,
      targetId: ROOT_ID,
      strength: 1,
      confidence: 1,
      signals: ['provenance'],
      provenance: ['test'],
      count: 0,
      now: SEEDED_AT,
    });
    const echoId = await substrate.push(
      'echo derived from a source claim',
      'fix-review-claim-source',
      {
        derived_from: [claimId],
      },
    );
    const rows = await fetchClaimProvenance(substrate.driver, {
      ids: [claimId, echoId, ROOT_ID],
      maxRoots: 3,
      mode: withCurrency(RECALLED_AT),
    });
    expect(rows.get(claimId)?.roots).toEqual([ROOT_ID]);
    expect(rows.get(echoId)).toMatchObject({ roots: [ROOT_ID], complete: true });
  });

  it('marks a source cycle incomplete rather than claiming an empty complete ancestry', async () => {
    const a = await substrate.push('cycle alpha source', 'fix-review-cycle-a');
    const b = await substrate.push('cycle beta source', 'fix-review-cycle-b', {
      derived_from: [a],
    });
    await substrate.push('cycle alpha source', 'fix-review-cycle-a', { derived_from: [b] });
    const rows = await fetchClaimProvenance(substrate.driver, {
      ids: [a],
      maxRoots: 3,
      mode: withCurrency(RECALLED_AT),
    });
    expect(rows.get(a)?.complete).toBe(false);
  });

  /**
   * A statement about a target the graph does not hold. The edge cannot be written and the
   * statement is not lost by that: it is durable against the identity the caller named, recorded
   * as unresolved, and it is what a later materialization has to work from.
   */
  /**
   * An absent target, which is its own shape: the edge cannot be written because there is no far
   * end. It is not a transient failure to attach a target the graph does hold; the interrupted
   * acceptance in the worker battery is where that one lives.
   */
  it('keeps a statement whose target the graph does not hold, durably and unresolved', async () => {
    const id = await substrate.push('a statement about something absent', 'review-unresolved', {
      derived_from: ['never-projected-target'],
    });

    expect(committedTargets(id)).toEqual(['never-projected-target']);
    expect(await rootsOf(id)).toEqual([id]);
    expect(getExperienceByEpisode(db, id)?.payload.provenance).toBeUndefined();
  });

  it('records references newly supplied on duplicate content as their own accepted batch', async () => {
    const text = 'same experience gains references later';
    const identity = 'fix-review-durable-duplicate';
    const id = await substrate.push(text, identity);
    expect(committedTargets(id)).toEqual([]);

    expect(await substrate.push(text, identity, { derived_from: [ROOT_ID] })).toBe(id);

    expect(committedTargets(id)).toEqual([ROOT_ID]);
    expect(await rootsOf(id)).toEqual([ROOT_ID]);
    expect(getExperienceByEpisode(db, id)?.payload.provenance).toBeUndefined();
  });
});

/**
 * A reference arriving around a job the worker is handling. The first case is a re-push whose
 * work the worker has already finished, which owes no new job and still owes its statement; the
 * other two hold one run and let a statement land during it.
 */
describe('a reference that arrives while its job is being handled', () => {
  /**
   * The worker drains the first job before the duplicate is pushed, so this is the reused
   * occurrence: no projection, no enqueue and no index, and the statement the push carried
   * accepted against the original source all the same.
   */
  it('queues no new job for a re-push whose work the worker already finished', async () => {
    const text = 'review immediate wake duplicate';
    const identity = 'review-immediate-wake';
    const id = await substrate.push(text, identity);
    const runner = {
      run: vi.fn((episodeId: string) =>
        Promise.resolve({
          episodeId,
          status: 'completed' as const,
          applied: true,
          summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
        }),
      ),
    };
    const worker = heldWorker(runner);
    try {
      await worker.start();
      expect(findPendingReflectionJob(db, 'integrate', 'episode_id', id)).toBeUndefined();
      const result = await handleReflection(
        reflectionDeps({
          onJobEnqueued: () => {
            worker.wake();
          },
        }),
        { observations: [text], provenance: { derived_from: [ROOT_ID] } },
        { identity, now: SEEDED_AT },
      );
      expect(result.episode_id).toBe(id);
      await worker.whenIdle();
      // The reused occurrence owes no processing job, and it still owes its statement.
      expect(listReflectionJobs(db).filter((job) => job.episodeId === id)).toEqual([]);
      expect(committedTargets(id)).toEqual([ROOT_ID]);
      expect(worker.retrying).toBe(0);
      expect(await rootsOf(id)).toEqual([ROOT_ID]);
    } finally {
      await worker.stop();
    }
  });

  it('keeps duplicate provenance supplied after a running job read the archive', async () => {
    const text = 'review running job duplicate';
    const identity = 'review-running-job';
    const id = await substrate.push(text, identity);
    // Replaced synchronously below: a Promise executor runs before the constructor returns.
    let enter = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = {
      run: vi.fn(async (episodeId: string) => {
        if (episodeId === id) {
          enter();
          await held;
        }
        return {
          episodeId,
          status: 'completed' as const,
          applied: true,
          summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
        };
      }),
    };
    const worker = heldWorker(runner);
    const started = worker.start();
    try {
      await entered;
      await handleReflection(
        reflectionDeps({
          onJobEnqueued: () => {
            worker.wake();
          },
        }),
        { observations: [text], provenance: { derived_from: [ROOT_ID] } },
        { identity, now: SEEDED_AT },
      );
      release();
      await started;
      await worker.whenIdle();
      // The acceptance recorded and projected the reference itself, inside its own publication.
      expect(committedTargets(id)).toEqual([ROOT_ID]);
      expect(await rootsOf(id)).toEqual([ROOT_ID]);
      // The completion measured the references the run STARTED with, so the one that landed
      // while it worked defers it. The job is not acked over an update it never read: it stays
      // claimable, and the attempt that follows settles against what is actually there.
      expect(worker.retrying).toBe(1);
    } finally {
      release();
      await started;
      await worker.stop();
    }
    await drain();
    expect(findPendingReflectionJob(db, 'integrate', 'episode_id', id)).toBeUndefined();
  });

  /**
   * The same hold, with a source that already carried one statement: a second one lands while the
   * run is held, and both survive. It is not a different boundary from the case above; what it
   * adds is that an existing accepted batch is not displaced by the one that arrives.
   */
  it('keeps a second statement accepted while the same run is held', async () => {
    const text = 'review final ack duplicate';
    const identity = 'review-final-ack';
    const id = await substrate.push(text, identity, { derived_from: [ROOT_ID] });
    const secondRoot = 'review-second-root';
    await substrate.writeEpisode(secondRoot, 'a second independent capture', OFF_TOPIC);
    // Replaced synchronously below: a Promise executor runs before the constructor returns.
    let enter = (): void => undefined;
    let releaseRun = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const heldRun = new Promise<ReflectionRun>((resolve) => {
      releaseRun = (): void => {
        resolve({
          episodeId: id,
          status: 'completed',
          applied: true,
          summary: { episodeId: id, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
        });
      };
    });
    const runner = {
      run: vi.fn((episodeId: string) => {
        if (episodeId === id) {
          enter();
          return heldRun;
        }
        return Promise.resolve({
          episodeId,
          status: 'completed' as const,
          applied: true,
          summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
        });
      }),
    };
    const worker = heldWorker(runner);
    const started = worker.start();
    try {
      await entered;
      await handleReflection(
        reflectionDeps({
          onJobEnqueued: () => {
            worker.wake();
          },
        }),
        { observations: [text], provenance: { derived_from: [secondRoot] } },
        { identity, now: SEEDED_AT },
      );
      releaseRun();
      await started;
      await worker.whenIdle();
      expect([...committedTargets(id)].sort()).toEqual([ROOT_ID, secondRoot].sort());
      expect(await rootsOf(id)).toEqual([ROOT_ID, secondRoot].sort());
      // Same fence as above: the second statement moved the version the run was measured on.
      expect(worker.retrying).toBe(1);
    } finally {
      releaseRun();
      await started;
      await worker.stop();
    }
    await drain();
    expect(findPendingReflectionJob(db, 'integrate', 'episode_id', id)).toBeUndefined();
  });
});
