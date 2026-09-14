import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import type { RecallCompletion, RecallListener } from './recall.js';
import { recordAccess } from '../../infrastructure/graph/access-tracking.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  DEFAULT_REINFORCEMENT_QUEUE_CAP,
  enqueueReinforcementSignal,
} from '../../infrastructure/sqlite/reinforcement-queue.js';
import {
  appendActivationHubPenaltyEvent,
  appendBridgeTraversalEvent,
  appendResonanceServedEvent,
} from '../../infrastructure/sqlite/sense-usage-events.js';
import {
  appendPackEmittedEvent,
  appendRecallAccessEvent,
} from '../../infrastructure/sqlite/usage-events.js';
import { RECALL_PACK_EXPOSURE_TRIGGER } from '../../plasticity/domain/reinforcement.js';
import type { BridgeLegContribution } from '../domain/activation-observations.js';
import type { ActivatedNode } from '../domain/activation.js';

/**
 * The recall-hot-path side effects, wired through `RecallDeps.onRecalled` so `handleRecall`
 * itself stays free of a second Neo4j round trip. Reinforcement rows and the emission row are
 * cheap local SQLite inserts and are written inline from the listener; the access-tracking write
 * is a real network round trip, so it is deferred and never awaited by the listener.
 * `whenIdle()` is the only way to observe it finishing, and only tests should call it.
 * Construct one instance per process, the same lifetime as `SessionManager` and `CueCache`.
 *
 * Both writes that change the graph are charged against what the pack printed. A node the spread
 * reached, the floors refused, a cap cut, the budget turned away or a subtraction withheld is
 * retrieval, and retrieval is a fact about this query rather than about the memory: strengthening
 * on it teaches the graph that a search ran.
 */

/**
 * Only the top-ranked slice of the co-activated set enters the pairwise fan-out. The
 * activated set can run into the hundreds on a well-populated graph, and pairing all of it
 * is O(n^2) queue rows for a signal whose value is "these few things fired strongly
 * together". Nodes far down the activation curve barely co-fired at all.
 */
export const REINFORCEMENT_TOP_N = 10;

/**
 * The name for this trigger source, distinct from reflection's co-occurrence signal and from the
 * wider-population name recall used to write. The string lives with the policy table that reads
 * it, so the producer and the flush cannot drift.
 */
export { RECALL_PACK_EXPOSURE_TRIGGER as REINFORCEMENT_TRIGGER };

/**
 * Every pair among the top-N nodes handed over, ordered by rank so the same recall enqueues the
 * same pairs in the same order. Callers pass the activated set already narrowed to what the pack
 * printed; it arrives score-descending (`activation.ts`'s `collect`), so slicing to
 * `REINFORCEMENT_TOP_N` first keeps the strongest of what was served and drops the long tail
 * rather than sampling it arbitrarily.
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
    this.#appendPackEmitted(completion);
    this.#enqueueReinforcement(completion);
    this.#scheduleAccessTracking(completion);
    this.#appendBridgeTraversal(completion);
    this.#appendResonanceServed(completion);
    this.#appendHubPenalty(completion);
  };

  /**
   * Resolves once every access-tracking write scheduled so far has settled. `onRecalled` is
   * fire-and-forget by `recall.ts`'s own contract, so nothing on the recall path itself calls
   * this; the MCP service's shutdown does, between closing its transports and closing the
   * driver, so a write scheduled just before the process stops still lands. Tests call it the
   * same way, after `handleRecall` returns, to observe the deferred write without a sleep:
   * `await handleRecall(...); await sideEffects.whenIdle();`.
   */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }

  /**
   * The emission row, written inline and before the graph write it precedes, so a run that loses
   * the graph still records what it served. Both populations ride it: what the caller was handed
   * and every candidate assembly was offered, all three passes included. Once the pack is gone
   * this row is the only place the difference between the two is legible, so a candidate a cap
   * or a subtraction turned away has to be in it or nothing can say what serving cost.
   */
  #appendPackEmitted(completion: RecallCompletion): void {
    try {
      appendPackEmittedEvent(this.#db, {
        sessionId: completion.sessionId,
        ids: [...completion.emitted],
        retrieved: [...new Set(completion.retrieved)],
        occurredAt: completion.now,
      });
    } catch (err) {
      this.#logger.warn(
        { err, sessionId: completion.sessionId, items: completion.emitted.size },
        'recall pack-emitted append failed',
      );
    }
  }

  #enqueueReinforcement(completion: RecallCompletion): void {
    try {
      const ts = completion.now.toISOString();
      // One id per recall, so two recalls landing in the same millisecond stay two bursts and
      // the flush discounts each as the clique it actually was.
      const burstId = randomUUID();
      // Narrowed before the fan-out, so the top-N slice spends its budget on what was served
      // rather than on the strongest of what the spread merely reached.
      const served = completion.activated.filter((node) => completion.emitted.has(node.nodeId));
      for (const [sourceId, targetId] of reinforcementPairs(served)) {
        enqueueReinforcementSignal(
          this.#db,
          sourceId,
          targetId,
          RECALL_PACK_EXPOSURE_TRIGGER,
          ts,
          this.#reinforcementQueueCap,
          burstId,
        );
      }
    } catch (err) {
      this.#logger.warn(
        {
          err,
          sessionId: completion.sessionId,
          activated: completion.activated.length,
        },
        'recall reinforcement enqueue failed',
      );
    }
  }

  /**
   * One row per bridge this walk's propagation touched, folded from every leg contribution to
   * that bridge's own id. A collector failure here costs observation coverage for this bridge on
   * this recall and nothing else: the pack was already assembled and persisted before this runs.
   */
  #appendBridgeTraversal(completion: RecallCompletion): void {
    if (completion.bridgeLegs.length === 0) {
      return;
    }
    try {
      const byBridge = new Map<string, BridgeLegContribution['direction'][]>();
      for (const leg of completion.bridgeLegs) {
        const directions = byBridge.get(leg.bridgeId) ?? [];
        directions.push(leg.direction);
        byBridge.set(leg.bridgeId, directions);
      }
      for (const [bridgeId, directions] of byBridge) {
        appendBridgeTraversalEvent(this.#db, {
          sessionId: completion.sessionId,
          bridgeId,
          legs: directions,
          crossed: directions.includes('into') && directions.includes('out'),
          emitted: completion.emitted.has(bridgeId),
          occurredAt: completion.now,
        });
      }
    } catch (err) {
      this.#logger.warn(
        { err, sessionId: completion.sessionId, bridges: completion.bridgeLegs.length },
        'recall bridge-traversal append failed',
      );
    }
  }

  /**
   * One row per resonant-bucket item this pack printed, capturing what a later read of the graph
   * cannot reconstruct: that this item was served by context resonance specifically, on this
   * method and condition, contested or not per the wire item's own `standing.contested`.
   * Resonance-only hits sit outside the first walk's activated set, so the reinforcement enqueue
   * above never sees them.
   */
  #appendResonanceServed(completion: RecallCompletion): void {
    const { resonant } = completion.pack;
    if (resonant === undefined || resonant.length === 0) {
      return;
    }
    try {
      for (const item of resonant) {
        appendResonanceServedEvent(this.#db, {
          sessionId: completion.sessionId,
          itemId: item.id,
          method: item.rationale.method,
          ...(item.context === undefined ? {} : { context: item.context }),
          contested: item.standing?.contested === true,
          occurredAt: completion.now,
        });
      }
    } catch (err) {
      this.#logger.warn(
        { err, sessionId: completion.sessionId, resonant: resonant.length },
        'recall resonance-served append failed',
      );
    }
  }

  /** One row per recall walk, summarizing the hub-inhibition exposure `activation.ts` measured. */
  #appendHubPenalty(completion: RecallCompletion): void {
    if (completion.hubPenalty.hops === 0) {
      return;
    }
    try {
      appendActivationHubPenaltyEvent(this.#db, {
        sessionId: completion.sessionId,
        hops: completion.hubPenalty.hops,
        inhibitedHops: completion.hubPenalty.inhibitedHops,
        totalPenalty: completion.hubPenalty.totalPenalty,
        minPenalty: completion.hubPenalty.minPenalty,
        occurredAt: completion.now,
      });
    } catch (err) {
      this.#logger.warn(
        { err, sessionId: completion.sessionId, hops: completion.hubPenalty.hops },
        'recall hub-penalty append failed',
      );
    }
  }

  /**
   * Deferred with `setImmediate` so the write genuinely starts after `handleRecall`'s
   * caller has already received the pack, not merely after this synchronous listener
   * returns. `recall.ts`'s `notify` invokes `onRecalled` without awaiting it, but a
   * synchronous listener body still runs to completion before `handleRecall`'s `return`.
   * Ids come from what the pack printed, not from everything the passes ranked: `last_accessed`
   * is read back by the recency seed strategy, so stamping a memory the budget cut would make the
   * next recall prefer something no agent has ever been shown.
   */
  #scheduleAccessTracking(completion: RecallCompletion): void {
    const ids = [...completion.emitted];
    if (ids.length === 0) {
      return;
    }
    const { now, sessionId } = completion;
    this.#pending = this.#pending.then(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            recordAccess(this.#driver, { ids, now })
              .then(() => {
                this.#appendUsageEvent(ids, now, sessionId);
              })
              .catch((err: unknown) => {
                this.#logger.warn(
                  { err, sessionId, items: ids.length },
                  'recall access-tracking write failed',
                );
              })
              .finally(resolve);
          });
        }),
    );
  }

  /**
   * The stream row for the bump the graph just took, written after it rather than beside it, so
   * the log records salience that actually landed. Fail-open and off the response path with the
   * write it follows: a substrate that cannot append loses replayability for this one recall,
   * which is not a reason to fail a read that already returned.
   */
  #appendUsageEvent(ids: readonly string[], now: Date, sessionId: string): void {
    try {
      appendRecallAccessEvent(this.#db, { ids, occurredAt: now });
    } catch (err) {
      this.#logger.warn({ err, sessionId, items: ids.length }, 'recall usage-event append failed');
    }
  }
}
