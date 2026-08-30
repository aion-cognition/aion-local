import type { Driver } from 'neo4j-driver';

import type { RecallCompletion, RecallListener } from './recall.js';
import { recordAccess } from '../../infrastructure/graph/access-tracking.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  DEFAULT_REINFORCEMENT_QUEUE_CAP,
  enqueueReinforcementSignal,
} from '../../infrastructure/sqlite/reinforcement-queue.js';
import type { ActivatedNode } from '../domain/activation.js';

/**
 * The two recall-hot-path side effects, wired through `RecallDeps.onRecalled` so
 * `handleRecall` itself stays free of a second Neo4j round trip. Reinforcement rows are cheap
 * local SQLite inserts and are written inline from the listener; the access-tracking write is
 * a real network round trip, so it is deferred and never awaited by the listener.
 * `whenIdle()` is the only way to observe it finishing, and only tests should call it.
 * Construct one instance per process, the same lifetime as `SessionManager` and `CueCache`.
 */

/**
 * Only the top-ranked slice of the co-activated set enters the pairwise fan-out. The
 * activated set can run into the hundreds on a well-populated graph, and pairing all of it
 * is O(n^2) queue rows for a signal whose value is "these few things fired strongly
 * together". Nodes far down the activation curve barely co-fired at all.
 */
export const REINFORCEMENT_TOP_N = 10;

/** The name for this trigger source, distinct from reflection's co-occurrence signal. */
export const REINFORCEMENT_TRIGGER = 'recall_co_activation';

/**
 * Every pair among the top-N activated nodes, ordered by rank so the same activation result
 * enqueues the same pairs in the same order. `activated` arrives score-descending
 * (`activation.ts`'s `collect`), so slicing to `REINFORCEMENT_TOP_N` first keeps the
 * strongest co-activations and drops the long tail rather than sampling it arbitrarily.
 *
 * Structural nodes are dropped before the slice. Every session hangs off the Member and the
 * global Workspace, so those two co-activate with everything by construction; reinforcing them
 * would teach the graph a fact about its own wiring and crowd the queue with pairs no amount
 * of use should make stronger.
 */
export function reinforcementPairs(
  activated: readonly ActivatedNode[],
): readonly (readonly [string, string])[] {
  const top = activated.filter((node) => !node.isStructural).slice(0, REINFORCEMENT_TOP_N);
  const pairs: (readonly [string, string])[] = [];
  for (let i = 0; i < top.length; i += 1) {
    for (let j = i + 1; j < top.length; j += 1) {
      const source = top[i];
      const target = top[j];
      if (source === undefined || target === undefined) {
        continue;
      }
      pairs.push([source.nodeId, target.nodeId]);
    }
  }
  return pairs;
}

export class RecallSideEffects {
  readonly #driver: Driver;
  readonly #db: SqliteHandle;
  readonly #logger: Logger;
  readonly #reinforcementQueueCap: number;
  /** Chained so `whenIdle()` waits for every write scheduled so far, not just the latest. */
  #pending: Promise<void> = Promise.resolve();

  constructor(
    driver: Driver,
    db: SqliteHandle,
    logger: Logger,
    reinforcementQueueCap: number = DEFAULT_REINFORCEMENT_QUEUE_CAP,
  ) {
    this.#driver = driver;
    this.#db = db;
    this.#logger = logger;
    this.#reinforcementQueueCap = reinforcementQueueCap;
  }

  /**
   * Bound as a class field so it can be assigned directly to `RecallDeps.onRecalled`.
   *
   * Both effects are writes shaped by "this memory just fired", which an `as_of` or `knew_at`
   * recall did not do: it asked what the substrate held at another moment. Bumping access
   * metadata there would rewrite the recency signal the seed strategy reads back and feed
   * plasticity an event that never happened, so time travel is read-only.
   */
  readonly onRecalled: RecallListener = (completion) => {
    if (isTimeTravel(completion.mode)) {
      return;
    }
    this.#enqueueReinforcement(completion);
    this.#scheduleAccessTracking(completion);
  };

  /**
   * Resolves once every access-tracking write scheduled so far has settled. Production
   * wiring never calls this: `onRecalled` is fire-and-forget by `recall.ts`'s own contract.
   * Tests call it after `handleRecall` returns to observe the deferred write without a
   * sleep: `await handleRecall(...); await sideEffects.whenIdle();`.
   */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }

  #enqueueReinforcement(completion: RecallCompletion): void {
    try {
      const ts = completion.now.toISOString();
      for (const [sourceId, targetId] of reinforcementPairs(completion.activated)) {
        enqueueReinforcementSignal(
          this.#db,
          sourceId,
          targetId,
          REINFORCEMENT_TRIGGER,
          ts,
          this.#reinforcementQueueCap,
        );
      }
    } catch (err) {
      this.#logger.warn({ err }, 'recall reinforcement enqueue failed');
    }
  }

  /**
   * Deferred with `setImmediate` so the write genuinely starts after `handleRecall`'s
   * caller has already received the pack, not merely after this synchronous listener
   * returns. `recall.ts`'s `notify` invokes `onRecalled` without awaiting it, but a
   * synchronous listener body still runs to completion before `handleRecall`'s `return`.
   * Ids come from the fused, surfaced set (`completion.items`), not the trimmed pack: a
   * memory recall judged relevant enough to rank counts as accessed even when the token
   * budget cut it from the rendered text.
   */
  #scheduleAccessTracking(completion: RecallCompletion): void {
    const ids = [...new Set(completion.items.map((item) => item.id))];
    if (ids.length === 0) {
      return;
    }
    const { now } = completion;
    this.#pending = this.#pending.then(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            recordAccess(this.#driver, { ids, now })
              .catch((err: unknown) => {
                this.#logger.warn({ err }, 'recall access-tracking write failed');
              })
              .finally(resolve);
          });
        }),
    );
  }
}
