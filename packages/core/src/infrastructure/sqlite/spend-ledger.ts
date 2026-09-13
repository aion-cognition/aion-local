import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * Reads and writes over `generation_spend`: what the day has committed, and the hold one dispatch
 * takes against it.
 *
 * The day's total is `COALESCE(settled_usd, reserved_usd)` over everything that is not released.
 * One expression covers the three states that cost money: a request in flight counts at the
 * maximum held for it, a reconciled one counts at what it cost, and a hold nobody came back to
 * keeps counting at its maximum, because a charge that cannot be sized is not a charge that did
 * not happen.
 */

export type SpendRoute = 'messages' | 'batch';

/** The UTC calendar day a hold counts against, spelled the way `api_calls` groups its days. */
export function spendDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type OpenSpendReservation = {
  readonly reservationId: string;
  readonly day: string;
  readonly surface: string;
  readonly route: SpendRoute;
  readonly reservedUsd: number;
  /** False where the model has no price, which is a call no dollar ceiling can bound. */
  readonly priced: boolean;
};

export type SpendDayTotals = {
  readonly day: string;
  /** Everything the day has committed: reconciled charges plus what is still held. */
  readonly committedUsd: number;
  /** The part of it that is still a maximum rather than a bill. */
  readonly inFlightUsd: number;
  /** Requests in flight, including any a dead process left behind. */
  readonly inFlight: number;
  /** Dispatches against a model the price table does not carry. They bound nothing. */
  readonly unpriced: number;
};

const COMMITTED = `COALESCE(settled_usd, reserved_usd)`;

function totalsFor(db: SqliteHandle, day: string): SpendDayTotals {
  const row = db
    .prepare(
      `SELECT COALESCE(sum(${COMMITTED}), 0) AS committedUsd,
              COALESCE(sum(CASE WHEN state = 'held' THEN ${COMMITTED} ELSE 0 END), 0) AS inFlightUsd,
              sum(CASE WHEN state = 'held' THEN 1 ELSE 0 END) AS inFlight,
              sum(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced
       FROM generation_spend
       WHERE day = ? AND state <> 'released'`,
    )
    .get(day) as {
    committedUsd: number;
    inFlightUsd: number;
    inFlight: number | null;
    unpriced: number | null;
  };
  return {
    day,
    committedUsd: row.committedUsd,
    inFlightUsd: row.inFlightUsd,
    inFlight: row.inFlight ?? 0,
    unpriced: row.unpriced ?? 0,
  };
}

/** What the day has committed so far, for a report or a check that takes no hold. */
export function readSpendDay(db: SqliteHandle, now: Date): SpendDayTotals {
  return totalsFor(db, spendDay(now));
}

export type ReserveSpendInput = {
  readonly surface: string;
  readonly route: SpendRoute;
  /**
   * The most this dispatch can cost, or undefined where the model carries no price. An
   * unpriced dispatch is recorded and allowed: a ceiling in dollars has nothing to hold it
   * against, and refusing every call on an unlisted model would make the price table a kill
   * switch nobody wrote.
   */
  readonly maxUsd: number | undefined;
  readonly ceilingUsd: number;
  readonly now: Date;
};

export type ReserveSpendOutcome =
  | { readonly ok: true; readonly reservation: OpenSpendReservation }
  | { readonly ok: false; readonly totals: SpendDayTotals; readonly maxUsd: number };

/**
 * Holds the most one dispatch can cost against the day's ceiling, or refuses.
 *
 * The read and the insert are one immediate transaction, so two callers reserving at once cannot
 * both read the same headroom and both take it. That is what makes the ceiling shared rather than
 * per caller: an ordinary call and a batch submission compete for the same dollars, in whatever
 * order SQLite serializes them.
 */
export function reserveGenerationSpend(
  db: SqliteHandle,
  input: ReserveSpendInput,
): ReserveSpendOutcome {
  const day = spendDay(input.now);
  const reservedUsd = input.maxUsd ?? 0;
  return db
    .transaction((): ReserveSpendOutcome => {
      const totals = totalsFor(db, day);
      if (input.maxUsd !== undefined && totals.committedUsd + input.maxUsd > input.ceilingUsd) {
        return { ok: false, totals, maxUsd: input.maxUsd };
      }
      const reservationId = randomUUID();
      db.prepare(
        `INSERT INTO generation_spend
         (reservation_id, day, surface, route, reserved_usd, priced, state, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, 'held', ?)`,
      ).run(
        reservationId,
        day,
        input.surface,
        input.route,
        reservedUsd,
        input.maxUsd === undefined ? 0 : 1,
        input.now.toISOString(),
      );
      return {
        ok: true,
        reservation: {
          reservationId,
          day,
          surface: input.surface,
          route: input.route,
          reservedUsd,
          priced: input.maxUsd !== undefined,
        },
      };
    })
    .immediate();
}

/**
 * Reconciles a hold with what the answer actually cost.
 *
 * `usd` undefined leaves the hold at its maximum: a response whose usage block would not parse,
 * or a model the price table cannot price, is a charge of an unknown size rather than none.
 *
 * A settled row can be settled again, which is what an answer read in more than one pass needs: a
 * batch is re-read until its rows are terminal, and each pass recomputes the same total from the
 * charges on the books rather than adding to a running one. A released row stays released.
 */
export function settleGenerationSpend(
  db: SqliteHandle,
  reservationId: string,
  usd: number | undefined,
  now: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE generation_spend
       SET state = 'settled', settled_usd = ?, settled_at = ?
       WHERE reservation_id = ? AND state IN ('held', 'settled')`,
    )
    .run(usd ?? null, now.toISOString(), reservationId);
  return result.changes > 0;
}

/** The request never reached the wire, so the day gets its dollars back. */
export function releaseGenerationSpend(
  db: SqliteHandle,
  reservationId: string,
  now: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE generation_spend
       SET state = 'released', settled_at = ?
       WHERE reservation_id = ? AND state = 'held'`,
    )
    .run(now.toISOString(), reservationId);
  return result.changes > 0;
}
