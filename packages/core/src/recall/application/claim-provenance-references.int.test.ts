import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RecallDeps } from './recall.js';
import {
  ClaimProvenanceSubstrate,
  OFF_TOPIC,
  RECALLED_AT,
  ROOT_ID,
  SEEDED_AT,
} from './test-support/claim-provenance.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import * as claimQueries from '../../infrastructure/graph/claim-provenance-queries.js';
import { fetchClaimProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getExperienceByEpisode } from '../../infrastructure/sqlite/experience-archive.js';
import { findPendingReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';
import * as storeQueries from '../../reflection/application/experience-store.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import type { ReflectionRun } from '../../reflection/application/orchestrator.js';
import { settleStatedReferences } from '../../reflection/application/stated-references.js';
import { ReflectionWorker } from '../../reflection/application/worker.js';
import { directIntakePublisher } from '../../reflection/test-support/direct-intake.fixture.js';

/**
 * A reference the substrate accepted has to survive the graph refusing it, the archive already
 * holding the content, and the job that would have written it finishing first. Every case here
 * ends with the reference readable, or says which write was lost.
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

it('retains accepted source references durably when graph attachment fails', async () => {
  const spy = vi
    .spyOn(claimQueries, 'resolveProvenanceTargets')
    .mockRejectedValueOnce(new Error('injected temporary graph error'));
  let id: string;
  try {
    id = await substrate.push('durable source on graph error', 'review-durability', {
      derived_from: [ROOT_ID],
    });
  } finally {
    spy.mockRestore();
  }
  const rows = await fetchClaimProvenance(substrate.driver, {
    ids: [id],
    maxRoots: 3,
    mode: withCurrency(RECALLED_AT),
  });
  expect(rows.get(id)?.roots).toEqual([id]);
  expect(getExperienceByEpisode(db, id)?.payload.provenance?.derived_from).toEqual([ROOT_ID]);
});

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
   * The repair the reflection worker runs on every integrate job, so an attachment the graph
   * refused at intake lands without anyone asking for it.
   */
  it('re-states references the graph refused at intake, from the archive alone', async () => {
    const spy = vi
      .spyOn(claimQueries, 'resolveProvenanceTargets')
      .mockRejectedValueOnce(new Error('injected temporary graph error'));
    let id: string;
    try {
      id = await substrate.push('a source the graph refused once', 'review-repair', {
        derived_from: [ROOT_ID],
      });
    } finally {
      spy.mockRestore();
    }
    const before = await fetchClaimProvenance(substrate.driver, {
      ids: [id],
      maxRoots: 3,
      mode: withCurrency(RECALLED_AT),
    });
    expect(before.get(id)?.roots).toEqual([id]);

    await settleStatedReferences({ driver: substrate.driver, db, logger }, id, SEEDED_AT);

    const after = await fetchClaimProvenance(substrate.driver, {
      ids: [id],
      maxRoots: 3,
      mode: withCurrency(RECALLED_AT),
    });
    expect(after.get(id)?.roots).toEqual([ROOT_ID]);
  });

  it('archives references newly supplied on duplicate content before a failed attachment', async () => {
    const text = 'same experience gains references later';
    const identity = 'fix-review-durable-duplicate';
    const id = await substrate.push(text, identity);
    const spy = vi
      .spyOn(claimQueries, 'resolveProvenanceTargets')
      .mockRejectedValueOnce(new Error('injected temporary graph error'));
    try {
      expect(await substrate.push(text, identity, { derived_from: [ROOT_ID] })).toBe(id);
    } finally {
      spy.mockRestore();
    }
    expect(getExperienceByEpisode(db, id)?.payload.provenance?.derived_from).toEqual([ROOT_ID]);
  });
});

/**
 * Two orderings that can lose a reference the substrate already accepted: a worker woken the
 * instant the job exists, and one already running when the reference arrives. Both end with the
 * job acked, so if the write is not made before the ack nothing is left to make it.
 */
describe('a reference that arrives while its job is being handled', () => {
  it('repairs duplicate provenance when the enqueue callback wakes the worker immediately', async () => {
    const text = 'review immediate wake duplicate';
    const identity = 'review-immediate-wake';
    const id = await substrate.push(text, identity);
    const runner = {
      run: vi.fn(async (episodeId: string) => ({
        episodeId,
        status: 'completed' as const,
        applied: true,
        summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
      })),
    };
    const worker = new ReflectionWorker(
      { driver: substrate.driver, db, provider, logger, runner },
      {
        clock: () => SEEDED_AT,
      },
    );
    try {
      await worker.start();
      expect(findPendingReflectionJob(db, 'integrate', 'episode_id', id)).toBeUndefined();
      const spy = vi
        .spyOn(claimQueries, 'resolveProvenanceTargets')
        .mockRejectedValueOnce(new Error('injected temporary graph error'));
      try {
        const result = await handleReflection(
          {
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
            onJobEnqueued: () => {
              worker.wake();
            },
          },
          { observations: [text], provenance: { derived_from: [ROOT_ID] } },
          {
            identity,
            now: SEEDED_AT,
          },
        );
        expect(result.episode_id).toBe(id);
      } finally {
        spy.mockRestore();
      }
      await worker.whenIdle();
      expect(getExperienceByEpisode(db, id)?.payload.provenance?.derived_from).toEqual([ROOT_ID]);
      expect(findPendingReflectionJob(db, 'integrate', 'episode_id', id)).toBeUndefined();
      expect(worker.retrying).toBe(0);
      const rows = await fetchClaimProvenance(substrate.driver, {
        ids: [id],
        maxRoots: 3,
        mode: withCurrency(RECALLED_AT),
      });
      expect(rows.get(id)?.roots).toEqual([ROOT_ID]);
    } finally {
      await worker.stop();
    }
  });

  it('repairs duplicate provenance supplied after a running job read the archive', async () => {
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
    const worker = new ReflectionWorker(
      { driver: substrate.driver, db, provider, logger, runner },
      {
        clock: () => SEEDED_AT,
      },
    );
    const started = worker.start();
    try {
      await entered;
      const spy = vi
        .spyOn(claimQueries, 'resolveProvenanceTargets')
        .mockRejectedValueOnce(new Error('injected temporary graph error'));
      try {
        await handleReflection(
          {
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
            onJobEnqueued: () => {
              worker.wake();
            },
          },
          { observations: [text], provenance: { derived_from: [ROOT_ID] } },
          {
            identity,
            now: SEEDED_AT,
          },
        );
      } finally {
        spy.mockRestore();
      }
      release();
      await started;
      await worker.whenIdle();
      expect(getExperienceByEpisode(db, id)?.payload.provenance?.derived_from).toEqual([ROOT_ID]);
      expect(findPendingReflectionJob(db, 'integrate', 'episode_id', id)).toBeUndefined();
      expect(worker.retrying).toBe(0);
      const rows = await fetchClaimProvenance(substrate.driver, {
        ids: [id],
        maxRoots: 3,
        mode: withCurrency(RECALLED_AT),
      });
      expect(rows.get(id)?.roots).toEqual([ROOT_ID]);
    } finally {
      release();
      await started;
      await worker.stop();
    }
  });

  /**
   * The narrowest of the three: the reference is archived after the running job's last look at
   * it and before that job is acked. The duplicate's own attach is refused, so the job is the
   * only thing left that can write the reference, and acking it would leave nothing pending.
   */
  it('repairs duplicate provenance archived between the settle and the ack', async () => {
    const text = 'review final ack duplicate';
    const identity = 'review-final-ack';
    const id = await substrate.push(text, identity, { derived_from: [ROOT_ID] });
    const secondRoot = 'review-second-root';
    await substrate.writeEpisode(secondRoot, 'a second independent capture', OFF_TOPIC);
    function completedRun(episodeId: string): ReflectionRun {
      return {
        episodeId,
        status: 'completed',
        applied: true,
        summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
      };
    }
    // Replaced synchronously below: a Promise executor runs before the constructor returns.
    let enter = (): void => undefined;
    let releaseRun = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const heldRun = new Promise<ReflectionRun>((resolve) => {
      releaseRun = (): void => {
        resolve(completedRun(id));
      };
    });
    const runner = {
      run: vi.fn((episodeId: string) => {
        if (episodeId === id) {
          enter();
          return heldRun;
        }
        return Promise.resolve(completedRun(episodeId));
      }),
    };
    const worker = new ReflectionWorker(
      { driver: substrate.driver, db, provider, logger, runner },
      {
        clock: () => SEEDED_AT,
      },
    );
    const started = worker.start();
    // The duplicate is held at its own store, so releasing it puts everything it does after
    // that point, the archive merge included, inside the worker's own await.
    let releaseStore = (): void => undefined;
    let storeIsReady = (): void => undefined;
    const storeReady = new Promise<void>((resolve) => {
      storeIsReady = resolve;
    });
    // Read out before the spy replaces it: the held call still makes the real write.
    const { storeExperience } = storeQueries;
    type Stored = Awaited<ReturnType<typeof storeExperience>>;
    let resolveStored: (value: Stored) => void = () => undefined;
    let rejectStored: (reason: unknown) => void = () => undefined;
    const heldStore = new Promise<Stored>((resolve, reject) => {
      resolveStored = resolve;
      rejectStored = reject;
    });
    const storeSpy = vi.spyOn(storeQueries, 'storeExperience');
    const targetSpy = vi.spyOn(claimQueries, 'resolveProvenanceTargets');
    let duplicate: Promise<unknown> | undefined;
    try {
      await entered;
      storeSpy.mockImplementationOnce((...args) => {
        void storeExperience(...args).then((stored) => {
          releaseStore = (): void => {
            resolveStored(stored);
          };
          storeIsReady();
        }, rejectStored);
        return heldStore;
      });
      duplicate = handleReflection(
        {
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
          onJobEnqueued: () => {
            worker.wake();
          },
        },
        { observations: [text], provenance: { derived_from: [secondRoot] } },
        {
          identity,
          now: SEEDED_AT,
        },
      );
      await storeReady;
      targetSpy.mockRejectedValueOnce(new Error('injected temporary graph error'));
      // One turn, the worker's continuation first: its settle finds the archive as it left it,
      // and the duplicate archives its reference before the ack that follows.
      releaseRun();
      releaseStore();
      await started;
      await duplicate;
      await worker.whenIdle();
      expect(getExperienceByEpisode(db, id)?.payload.provenance?.derived_from).toEqual([
        ROOT_ID,
        secondRoot,
      ]);
      expect(findPendingReflectionJob(db, 'integrate', 'episode_id', id)).toBeUndefined();
      expect(worker.retrying).toBe(0);
      const rows = await fetchClaimProvenance(substrate.driver, {
        ids: [id],
        maxRoots: 3,
        mode: withCurrency(RECALLED_AT),
      });
      expect(rows.get(id)?.roots).toEqual([ROOT_ID, secondRoot].sort());
    } finally {
      releaseStore();
      releaseRun();
      await duplicate;
      await started;
      await worker.stop();
      storeSpy.mockRestore();
      targetSpy.mockRestore();
    }
  });
});
