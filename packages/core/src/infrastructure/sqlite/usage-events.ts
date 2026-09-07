import type { SqliteHandle } from './database.js';
import { isLedgerApplied, markLedgerApplied } from './ops-ledger.js';

/**
 * The usage stream: what recall, the flush and the decay sweep did to the graph, appended as
 * it happens and read back oldest first, plus the signals nobody can read off the graph at all.
 *
 * The experience archive holds what the substrate was told, so a replay from it rebuilds every
 * fact. Salience is not a fact: access stamps, edge weights and sweep moments live only in the
 * graph, and a rebuilt graph therefore knows everything and remembers nothing about what
 * mattered. These rows close that gap.
 *
 * Four kinds record no graph change at all. What a pack emitted, that it arrived, that a caller
 * used it and that somebody confirmed it are four different statements, and the substrate can
 * observe exactly one of them on its own. They are kept apart rather than folded together
 * because collapsing them is how assembly starts reading as proof that a model used something.
 *
 * Every appender is insert-only, which is why they are named for the append rather than for a
 * record or an update. A row is a measurement of a moment that has passed.
 */

export const USAGE_EVENT_KINDS = [
  'recall_access',
  'reinforcement_applied',
  'decay_sweep',
  'pack_emitted',
  'delivery_acknowledged',
  'memory_used',
  'memory_confirmed',
] as const;

export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

/**
 * The kinds that state a signal instead of recording a write. A replay steps over them: there is
 * no graph change to put back, and nothing about them is reconstructible from a rebuilt graph.
 */
export const SIGNAL_EVENT_KINDS = [
  'pack_emitted',
  'delivery_acknowledged',
  'memory_used',
  'memory_confirmed',
] as const;

export type SignalEventKind = (typeof SIGNAL_EVENT_KINDS)[number];

/** The two kinds a caller states about itself, which is what keeps them out of the third. */
export type SelfReportKind = 'delivery_acknowledged' | 'memory_used';

/**
 * The nodes one recall's access tracking bumped, in the order the surfaced set produced them.
 * Order is kept rather than sorted so the row reads as what happened.
 */
export type RecallAccessPayload = {
  readonly ids: readonly string[];
};

/** One pair's bounded step, exactly as the flush handed it to the graph write. */
export type ReinforcementStep = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly learningRate: number;
};

/**
 * One flush window, written when the graph write lands rather than when a signal is enqueued.
 * The queue is capped and trimmed, so an enqueue-time row would record co-activations that
 * never reached an edge.
 *
 * `weightFloor` rides the row because the bounded step reads it: replaying under a floor the
 * original run did not use produces a different weight from the same pairs.
 *
 * `triggers` are the distinct trigger names the claimed window held. A window can mix them,
 * and the fold has already spent them by the time a step exists, so they are provenance for a
 * reader rather than an input a replay applies.
 */
export type ReinforcementAppliedPayload = {
  readonly pairs: readonly ReinforcementStep[];
  readonly triggers: readonly string[];
  readonly weightFloor: number;
};

/**
 * One sweep's scan parameters. Decay is a pure function of weights, access clocks and sweep
 * moments, so the moment plus these five numbers is the whole re-runnable record; per-edge
 * deltas are deliberately absent, since the scan finds its own candidates and would find them
 * again from the same graph state.
 */
export type DecaySweepPayload = {
  readonly batchSize: number;
  readonly decayRate: number;
  readonly peakDays: number;
  readonly sigma: number;
  readonly weightFloor: number;
};

/**
 * One recall's two populations, kept apart.
 *
 * `ids` holds the ids assembly emitted to the caller, and nothing else: withheld repeats are
 * not in it. `retrieved` holds the full pre-assembly candidate union from fusion, resonance
 * and intentions, before caps or subtractions apply, so the gap between the two reads as how
 * much of retrieval reached the wire.
 *
 * Emission is what this process did. It is not receipt: no row here says the pack reached a
 * client, and none says a model read it.
 */
export type PackEmittedPayload = {
  readonly sessionId: string;
  readonly ids: readonly string[];
  readonly retrieved: readonly string[];
};

/**
 * A caller's account of memories it was served: that they arrived, or that it acted on them.
 *
 * Always a self-report, whatever `reporter` says. A transport role names no person and
 * agent-to-agent traffic arrives under `user`, so the field records who the report is filed
 * under and never establishes who filed it. Nothing here is evidence that a memory is true.
 */
export type SelfReportPayload = {
  readonly sessionId: string;
  readonly memories: readonly string[];
  readonly reporter: string;
  /** Where the report is written down, when the caller had anywhere to point at. */
  readonly evidence?: string;
};

/**
 * A confirmation somebody stated, carried into the stream from the record the reflection call
 * wrote. Evidence is required here and optional above, which is the whole difference: a
 * confirmation is attributable because the reference is, and one that cites nothing is a
 * self-report wearing a confirmer's name.
 */
export type MemoryConfirmedPayload = {
  /** The experience the confirmation was stated in. */
  readonly episodeId: string;
  readonly memories: readonly string[];
  readonly confirmedBy: string;
  readonly evidence: string;
};

export type UsageEventPayload =
  | RecallAccessPayload
  | ReinforcementAppliedPayload
  | DecaySweepPayload
  | PackEmittedPayload
  | SelfReportPayload
  | MemoryConfirmedPayload;

export type UsageEventRow = {
  /** The stream position. Never reused, so a cursor holding one can only move forward. */
  readonly id: number;
  readonly kind: UsageEventKind;
  readonly payload: UsageEventPayload;
  /** The operation's own clock, which is what a replay re-applies the step at. */
  readonly occurredAt: string;
  readonly recordedAt: string;
};

/** Where a keyset page left off: the last row's `(occurred_at, id)`, oldest first. */
export type UsageEventCursor = {
  readonly occurredAt: string;
  readonly id: number;
};

type UsageEventRowData = {
  id: number;
  kind: string;
  payload_json: string;
  occurred_at: string;
  recorded_at: string;
};

/** Both clocks every appender takes. `recordedAt` defaults to the wall clock at write time. */
type UsageEventStamps = {
  readonly occurredAt: Date;
  readonly recordedAt?: Date;
};

function toUsageEventRow(row: UsageEventRowData): UsageEventRow {
  return {
    id: row.id,
    kind: row.kind as UsageEventKind,
    payload: JSON.parse(row.payload_json) as UsageEventPayload,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function append(
  db: SqliteHandle,
  kind: UsageEventKind,
  payload: UsageEventPayload,
  stamps: UsageEventStamps,
): void {
  db.prepare(
    `INSERT INTO usage_events (kind, payload_json, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    kind,
    JSON.stringify(payload),
    stamps.occurredAt.toISOString(),
    (stamps.recordedAt ?? new Date()).toISOString(),
  );
}

export type RecallAccessEvent = RecallAccessPayload & UsageEventStamps;

/** Called from recall's deferred access-tracking write, once the graph has taken the bump. */
export function appendRecallAccessEvent(db: SqliteHandle, event: RecallAccessEvent): void {
  append(db, 'recall_access', { ids: [...event.ids] }, event);
}

export type ReinforcementAppliedEvent = ReinforcementAppliedPayload & UsageEventStamps;

export function appendReinforcementAppliedEvent(
  db: SqliteHandle,
  event: ReinforcementAppliedEvent,
): void {
  append(
    db,
    'reinforcement_applied',
    {
      pairs: event.pairs.map((pair) => ({
        sourceId: pair.sourceId,
        targetId: pair.targetId,
        learningRate: pair.learningRate,
      })),
      triggers: [...event.triggers],
      weightFloor: event.weightFloor,
    },
    event,
  );
}

export type PackEmittedEvent = PackEmittedPayload & UsageEventStamps;

/**
 * Called inline from recall's listener, before the graph write it precedes. The two are separate
 * rows because they can disagree: a pack is emitted whether or not the access bump behind it
 * lands, and a run that lost the graph still served somebody a pack.
 */
export function appendPackEmittedEvent(db: SqliteHandle, event: PackEmittedEvent): void {
  append(
    db,
    'pack_emitted',
    {
      sessionId: event.sessionId,
      ids: [...event.ids],
      retrieved: [...event.retrieved],
    },
    event,
  );
}

/**
 * A feedback row's own name, which is what makes a second statement of the same thing a no-op.
 * The clock is deliberately out of it: a client retrying a push states the same report again
 * under a fresh wall clock, and two rows for one statement would read as two reports.
 */
export type KeyedEvent = { readonly key: string };

/**
 * Recorded once per key, inside one transaction so a concurrent writer cannot land between the
 * check and the append. Returns false when the key was already recorded, which is a caller
 * repeating itself rather than a failure.
 */
function appendOnce(
  db: SqliteHandle,
  kind: SignalEventKind,
  key: string,
  payload: UsageEventPayload,
  stamps: UsageEventStamps,
): boolean {
  return db
    .transaction((): boolean => {
      if (isLedgerApplied(db, key)) {
        return false;
      }
      append(db, kind, payload, stamps);
      markLedgerApplied(db, key, { kind });
      return true;
    })
    .immediate();
}

export type SelfReportEvent = SelfReportPayload & UsageEventStamps & KeyedEvent;

export function appendSelfReportEvent(
  db: SqliteHandle,
  kind: SelfReportKind,
  event: SelfReportEvent,
): boolean {
  return appendOnce(
    db,
    kind,
    event.key,
    {
      sessionId: event.sessionId,
      memories: [...event.memories],
      reporter: event.reporter,
      ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
    },
    event,
  );
}

export type MemoryConfirmedEvent = MemoryConfirmedPayload & UsageEventStamps & KeyedEvent;

export function appendMemoryConfirmedEvent(db: SqliteHandle, event: MemoryConfirmedEvent): boolean {
  return appendOnce(
    db,
    'memory_confirmed',
    event.key,
    {
      episodeId: event.episodeId,
      memories: [...event.memories],
      confirmedBy: event.confirmedBy,
      evidence: event.evidence,
    },
    event,
  );
}

export type DecaySweepEvent = DecaySweepPayload & UsageEventStamps;

export function appendDecaySweepEvent(db: SqliteHandle, event: DecaySweepEvent): void {
  append(
    db,
    'decay_sweep',
    {
      batchSize: event.batchSize,
      decayRate: event.decayRate,
      peakDays: event.peakDays,
      sigma: event.sigma,
      weightFloor: event.weightFloor,
    },
    event,
  );
}

/**
 * A page of events ordered oldest first by `(occurred_at, id)`, the pair the table indexes on.
 * `cursor` is the last row of the previous page, or `undefined` for the first page; passing the
 * last row returned back in as the next cursor visits every row exactly once, so a multi-batch
 * replay aborted between pages resumes without re-applying a step.
 *
 * Ordering on the operation clock rather than on insert order alone is what keeps the stream in
 * the order the substrate lived it: recall's log write is deferred behind its graph write, so a
 * flush that started later can reach the table first.
 */
export function listUsageEventsAfter(
  db: SqliteHandle,
  cursor: UsageEventCursor | undefined,
  limit: number,
): readonly UsageEventRow[] {
  const where = cursor === undefined ? '' : 'WHERE occurred_at > ? OR (occurred_at = ? AND id > ?)';
  const parameters = cursor === undefined ? [] : [cursor.occurredAt, cursor.occurredAt, cursor.id];
  const rows = db
    .prepare(
      `SELECT id, kind, payload_json, occurred_at, recorded_at FROM usage_events ${where}
       ORDER BY occurred_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...parameters, limit) as UsageEventRowData[];
  return rows.map(toUsageEventRow);
}

/** How many events the stream holds, for an operator asking whether there is anything to replay. */
export function countUsageEvents(db: SqliteHandle): number {
  const row = db.prepare('SELECT count(*) AS n FROM usage_events').get() as { n: number };
  return row.n;
}
