import type { Driver } from 'neo4j-driver';

import { errorMessage } from '../../infrastructure/errors.js';
import { recordAccess } from '../../infrastructure/graph/access-tracking.js';
import { decayEdgeWeights, reinforceEdgeWeights } from '../../infrastructure/graph/edge-weights.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { abortRequested } from '../../infrastructure/providers/deadline-signal.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listUsageEventsAfter,
  type DecaySweepPayload,
  type RecallAccessPayload,
  type ReinforcementAppliedPayload,
  type UsageEventCursor,
  type UsageEventRow,
} from '../../infrastructure/sqlite/usage-events.js';

/**
 * The usage stream put back over a rebuilt graph, the way `replay.ts` puts the experience
 * archive back through the pipeline. The archive replay restores what the substrate knows;
 * this restores what it found worth knowing: access stamps, edge weights, and the decay the
 * sweeps applied.
 *
 * Order is the whole mechanism. Reinforcement's step is bounded and its size depends on the
 * weight it starts from, and each sweep's candidates depend on which edges the sweep before it
 * visited, so the same events applied oldest first yield the same numbers and applied in any
 * other order do not.
 *
 * Each event goes to the graph write itself rather than to the operation that first made it.
 * The operations record their own usage, so running them here would append the stream a second
 * time while replaying it.
 *
 * Every write is additive, which makes this a rebuild step and not a repair: applied over a
 * graph that already carries its own stamps, the access counts double. The caller is expected
 * to be pointing at a graph rebuilt from the archive.
 */

export type UsageReplayDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type UsageReplayOptions = {
  readonly batchSize: number;
  /** Events visited at most, across every batch. Unbounded when absent. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
  /** Called once per batch, so a long pass reports progress rather than one line at the end. */
  readonly onBatch?: (progress: UsageReplayProgress) => void;
};

export type UsageReplayCounts = {
  readonly accessApplied: number;
  readonly reinforcementApplied: number;
  readonly decayApplied: number;
  /** Edges the reinforcement events moved, summed over the windows. */
  readonly edgesReinforced: number;
  /** Of the edges the sweeps scanned, the ones whose weight actually moved. */
  readonly edgesDecayed: number;
  /** Events of a kind this build does not apply. */
  readonly skipped: number;
  readonly failed: number;
};

export type UsageReplayProgress = UsageReplayCounts & {
  readonly scanned: number;
  readonly cursor: UsageEventCursor;
};

export type UsageReplayReport = UsageReplayCounts & {
  readonly scanned: number;
  /** Where the pass stopped, so an aborted run resumes instead of starting over. */
  readonly cursor: UsageEventCursor | undefined;
  readonly aborted: boolean;
};

/** The counter one event advances, and how many edges its write moved. */
type EventOutcome = {
  readonly counter: 'access' | 'reinforcement' | 'decay' | 'skipped' | 'failed';
  readonly edges: number;
};

type Tally = {
  scanned: number;
  access: number;
  reinforcement: number;
  decay: number;
  skipped: number;
  failed: number;
  edgesReinforced: number;
  edgesDecayed: number;
};

function countsOf(tally: Tally): UsageReplayCounts {
  return {
    accessApplied: tally.access,
    reinforcementApplied: tally.reinforcement,
    decayApplied: tally.decay,
    edgesReinforced: tally.edgesReinforced,
    edgesDecayed: tally.edgesDecayed,
    skipped: tally.skipped,
    failed: tally.failed,
  };
}

/**
 * One event at the clock it happened on. World time is the row's `occurred_at` for all three
 * kinds: an access stamp dated to the replay would rewrite the recency the seed strategy reads,
 * and a sweep run at today's clock would measure a staleness the original never saw.
 */
async function applyUsageEvent(deps: UsageReplayDeps, row: UsageEventRow): Promise<EventOutcome> {
  const now = new Date(row.occurredAt);

  switch (row.kind) {
    case 'recall_access': {
      const payload = row.payload as RecallAccessPayload;
      await recordAccess(deps.driver, { ids: payload.ids, now });
      return { counter: 'access', edges: 0 };
    }
    case 'reinforcement_applied': {
      const payload = row.payload as ReinforcementAppliedPayload;
      const edges = await reinforceEdgeWeights(deps.driver, {
        pairs: payload.pairs,
        weightFloor: payload.weightFloor,
        now,
      });
      return { counter: 'reinforcement', edges: edges.length };
    }
    case 'decay_sweep': {
      const payload = row.payload as DecaySweepPayload;
      const edges = await decayEdgeWeights(deps.driver, {
        batchSize: payload.batchSize,
        decayRate: payload.decayRate,
        peakDays: payload.peakDays,
        sigma: payload.sigma,
        weightFloor: payload.weightFloor,
        now,
      });
      const moved = edges.filter((edge) => edge.strength !== edge.previousStrength);
      return { counter: 'decay', edges: moved.length };
    }
    default:
      // A kind this build has no write for is stepped over rather than stopping the pass.
      return { counter: 'skipped', edges: 0 };
  }
}

/**
 * An event that throws is counted and the pass continues, the way a replayed experience is:
 * one unreadable row is not a reason to strand the salience behind it. The cursor still
 * advances past it, so a resumed pass does not stall on the same row forever.
 */
async function eventOutcome(deps: UsageReplayDeps, row: UsageEventRow): Promise<EventOutcome> {
  try {
    return await applyUsageEvent(deps, row);
  } catch (err) {
    deps.logger.error(
      { err: errorMessage(err), usageEventId: row.id, kind: row.kind },
      'replay of a usage event failed; continuing with the rest',
    );
    return { counter: 'failed', edges: 0 };
  }
}

/** Oldest first, by the `(occurred_at, id)` keyset the table indexes on. */
export async function replayUsageEvents(
  deps: UsageReplayDeps,
  options: UsageReplayOptions,
): Promise<UsageReplayReport> {
  const tally: Tally = {
    scanned: 0,
    access: 0,
    reinforcement: 0,
    decay: 0,
    skipped: 0,
    failed: 0,
    edgesReinforced: 0,
    edgesDecayed: 0,
  };
  let cursor: UsageEventCursor | undefined;
  let aborted = false;

  for (;;) {
    if (abortRequested(options.signal)) {
      aborted = true;
      break;
    }
    const remaining =
      options.limit === undefined ? options.batchSize : options.limit - tally.scanned;
    const size = Math.min(options.batchSize, remaining);
    if (size <= 0) {
      break;
    }

    const rows = listUsageEventsAfter(deps.db, cursor, size);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      // Checked per event, not per batch: each one is a graph round trip, and the cursor stays
      // at the last completed row, which is where the next pass resumes.
      if (abortRequested(options.signal)) {
        aborted = true;
        break;
      }
      const outcome = await eventOutcome(deps, row);
      tally[outcome.counter] += 1;
      if (outcome.counter === 'reinforcement') {
        tally.edgesReinforced += outcome.edges;
      }
      if (outcome.counter === 'decay') {
        tally.edgesDecayed += outcome.edges;
      }
      tally.scanned += 1;
      cursor = { occurredAt: row.occurredAt, id: row.id };
    }
    if (cursor !== undefined) {
      options.onBatch?.({ ...countsOf(tally), scanned: tally.scanned, cursor });
    }
    if (aborted) {
      break;
    }
  }

  deps.logger.info(
    { ...countsOf(tally), scanned: tally.scanned, aborted },
    'usage replay finished',
  );
  return { ...countsOf(tally), scanned: tally.scanned, cursor, aborted };
}
