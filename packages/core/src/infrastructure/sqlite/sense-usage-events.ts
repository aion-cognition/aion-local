import type { SqliteHandle } from './database.js';
import { appendUsageEventRow, type UsageEventStamps } from './usage-events.js';

/**
 * The five introspection-sense observation kinds, split out of `usage-events.ts` to keep that
 * file's core stream machinery (the table, the replay cursor, the original four self-report
 * kinds) at a readable size. Every kind here is a signal (`SIGNAL_EVENT_KINDS` in
 * `usage-events.ts`): an outcome observation the tier-3 loop reads as evidence, never a
 * plasticity instruction, and a replay steps over all of them the same way it steps over
 * `pack_emitted`.
 */

/**
 * One bridge's fate in one recall walk. `legs` names which of the bridge's two recorded
 * RELATED_TO legs carried a contribution during this walk (`into` the Bridge node, `out` toward
 * an endpoint); a leg is established by the relation and the `symbiosis_bridge` signal
 * `writeBridge` stamped on it, never by an endpoint merely carrying the `:Bridge` label.
 * `crossed` is true only when both legs fired in this same walk, which is the end-to-end
 * crossing an arrival at one leg alone does not establish.
 *
 * `emitted` is whether the Bridge node itself reached the caller in the pack this walk assembled.
 * The endpoints are not read for it: a pack that served one endpoint and nothing built from the
 * bridge leaves this false. Kept apart from traversal either way, because a bridge can carry
 * activation without anything built from it ever being served.
 */
export type BridgeTraversalPayload = {
  readonly sessionId: string;
  readonly bridgeId: string;
  readonly legs: readonly ('into' | 'out')[];
  readonly crossed: boolean;
  readonly emitted: boolean;
};

/**
 * One resonant-bucket item's served identity at the moment it was handed to a caller. Recorded
 * only for the `resonant` bucket: those hits sit outside the first walk's activated set, so
 * nothing else in the stream can later reconstruct that this item was ever offered by context
 * resonance specifically, on this method, contested or not.
 */
export type ResonanceServedPayload = {
  readonly sessionId: string;
  readonly itemId: string;
  readonly method: string;
  /** The condition the item holds under, when the wire item carried one (`MemoryPackItem.context`). */
  readonly context?: string;
  /** `standing.contested` on the wire item: a competing reading of the same memories stands. */
  readonly contested: boolean;
};

/**
 * One supersession-lineage transition, recorded at the moment the graph write it describes
 * committed. `producedBy` is the writer's own provenance tag, already stored on the SUPERSEDES
 * edge and carried here so a reversal is legible from the stream even where a later point-in-time
 * graph read would only show the node's latest state and lose the intermediate transition.
 */
export type JudgmentTransitionPayload = {
  readonly nodeId: string;
  readonly transition: 'superseded' | 'reopened';
  readonly producedBy: readonly string[];
};

/**
 * One episode's association-stage pass over its co-occurring pairs, recorded at the producing
 * operation: `associations.ts` is the one place that knows both the proposed pair count and the
 * strength each pair actually wrote, since edge strength on a later read already carries whatever
 * reinforcement or decay touched it since birth.
 */
export type CoOccursObservedPayload = {
  readonly episodeId: string;
  readonly pairsProposed: number;
  readonly pairsWritten: number;
  /** Edges this pass created new, versus ones it bumped an existing count on. */
  readonly births: number;
  readonly recurrences: number;
  /** What this pass itself wrote as strength, before any later reinforcement or decay touches it. */
  readonly birthStrength: number;
};

/**
 * One recall walk's hub-inhibition exposure, summarized rather than carried per hop: the recall
 * trace records activated ids and aggregate counts, and adding a per-hop array here would grow
 * the row with the walk's breadth for a number nothing downstream needs at that resolution.
 * `degree` throughout is physical degree, the number hub inhibition is calibrated against; a
 * walk that also measured active degree reports a different number under a different name.
 */
export type ActivationHubPenaltyPayload = {
  readonly sessionId: string;
  readonly hops: number;
  readonly inhibitedHops: number;
  readonly totalPenalty: number;
  readonly minPenalty: number;
};

export type SenseUsageEventPayload =
  | BridgeTraversalPayload
  | ResonanceServedPayload
  | JudgmentTransitionPayload
  | CoOccursObservedPayload
  | ActivationHubPenaltyPayload;

export type BridgeTraversalEvent = BridgeTraversalPayload & UsageEventStamps;

/** Called from recall's listener, once per bridge the walk touched, alongside its other writes. */
export function appendBridgeTraversalEvent(db: SqliteHandle, event: BridgeTraversalEvent): void {
  appendUsageEventRow(
    db,
    'bridge_traversal_observed',
    {
      sessionId: event.sessionId,
      bridgeId: event.bridgeId,
      legs: [...event.legs],
      crossed: event.crossed,
      emitted: event.emitted,
    },
    event,
  );
}

export type ResonanceServedEvent = ResonanceServedPayload & UsageEventStamps;

/** Called from recall's listener, once per resonant-bucket item the assembled pack printed. */
export function appendResonanceServedEvent(db: SqliteHandle, event: ResonanceServedEvent): void {
  appendUsageEventRow(
    db,
    'resonance_served',
    {
      sessionId: event.sessionId,
      itemId: event.itemId,
      method: event.method,
      ...(event.context === undefined ? {} : { context: event.context }),
      contested: event.contested,
    },
    event,
  );
}

export type JudgmentTransitionEvent = JudgmentTransitionPayload & UsageEventStamps;

/** Called from the application layer, once the graph write it describes has committed. */
export function appendJudgmentTransitionEvent(
  db: SqliteHandle,
  event: JudgmentTransitionEvent,
): void {
  appendUsageEventRow(
    db,
    'judgment_transition_observed',
    {
      nodeId: event.nodeId,
      transition: event.transition,
      producedBy: [...event.producedBy],
    },
    event,
  );
}

export type CoOccursObservedEvent = CoOccursObservedPayload & UsageEventStamps;

/** Called from the association stage, once per episode, after its pairs have all been written. */
export function appendCoOccursObservedEvent(db: SqliteHandle, event: CoOccursObservedEvent): void {
  appendUsageEventRow(
    db,
    'co_occurs_observed',
    {
      episodeId: event.episodeId,
      pairsProposed: event.pairsProposed,
      pairsWritten: event.pairsWritten,
      births: event.births,
      recurrences: event.recurrences,
      birthStrength: event.birthStrength,
    },
    event,
  );
}

export type ActivationHubPenaltyEvent = ActivationHubPenaltyPayload & UsageEventStamps;

/** Called from recall's listener, once per recall walk, alongside its other writes. */
export function appendActivationHubPenaltyEvent(
  db: SqliteHandle,
  event: ActivationHubPenaltyEvent,
): void {
  appendUsageEventRow(
    db,
    'activation_hub_penalty_observed',
    {
      sessionId: event.sessionId,
      hops: event.hops,
      inhibitedHops: event.inhibitedHops,
      totalPenalty: event.totalPenalty,
      minPenalty: event.minPenalty,
    },
    event,
  );
}
