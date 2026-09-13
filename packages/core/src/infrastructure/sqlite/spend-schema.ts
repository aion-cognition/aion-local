/**
 * The money side of generation, in the one place both routes read before they dispatch.
 *
 * A reservation is written before a request leaves the machine and reconciled when its answer is
 * in hand. That order is the whole point: a ceiling consulted after the fact is a report, and the
 * spend it would have stopped is already gone. It outlives the process for the same reason
 * `batch_work` does, and more sharply: a batch submitted before a restart is money committed, and
 * a book that forgot it would authorize the same dollars twice.
 *
 * `settled_usd` null on a held row is a request still in flight. Null on a settled row is a
 * dispatch that reached the wire and never came back with a charge anyone could size, and the
 * day's total reads it at the bound that was held for it rather than at zero. Unknown is not
 * free, and `aion costs` names how much of the day those rows are.
 *
 * `priced` is zero where the model has no entry in the price table. The bound then comes from the
 * top of the published card instead of the model's own rate, because a ceiling an unlisted model
 * walks past is a ceiling on the one model the table happens to carry. Such a call is held,
 * refused when it does not fit, and counted separately in the report.
 */
export const SPEND_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS generation_spend (
    reservation_id TEXT PRIMARY KEY,
    -- The UTC calendar day the hold counts against, matching how api_calls groups its days.
    day TEXT NOT NULL,
    surface TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('messages', 'batch')),
    reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
    priced INTEGER NOT NULL DEFAULT 1 CHECK (priced IN (0, 1)),
    settled_usd REAL CHECK (settled_usd >= 0),
    -- held: in flight. settled: the answer came back and the row holds what it cost.
    -- released: the request never reached the wire, so it costs the day nothing.
    state TEXT NOT NULL CHECK (state IN ('held', 'settled', 'released')),
    opened_at TEXT NOT NULL,
    settled_at TEXT
  )`,
];

export const SPEND_INDEX_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS generation_spend_day_idx ON generation_spend (day, state)',
];
