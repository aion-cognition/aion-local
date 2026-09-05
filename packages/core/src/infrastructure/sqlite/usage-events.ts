import type { SqliteHandle } from './database.js';

/**
 * The usage stream: what recall, the flush and the decay sweep did to the graph, appended as
 * it happens and read back oldest first.
 *
 * The experience archive holds what the substrate was told, so a replay from it rebuilds every
 * fact. Salience is not a fact: access stamps, edge weights and sweep moments live only in the
 * graph, and a rebuilt graph therefore knows everything and remembers nothing about what
 * mattered. These rows close that gap.
 *
 * Every appender is insert-only, which is why they are named for the append rather than for a
 * record or an update. A row is a measurement of a moment that has passed.
 */

export const USAGE_EVENT_KINDS = ['recall_access', 'reinforcement_applied', 'decay_sweep'] as const;

export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

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

export type UsageEventPayload =
  RecallAccessPayload | ReinforcementAppliedPayload | DecaySweepPayload;

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
