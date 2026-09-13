/**
 * The money side of generation, in the one place both routes read before they dispatch.
 *
 * A reservation is written before a request leaves the machine and reconciled when its answer is
 * in hand. That order is the whole point: a ceiling consulted after the fact is a report, and the
 * spend it would have stopped is already gone. It outlives the process for the same reason
 * `batch_work` does, and more sharply: a batch submitted before a restart is money committed, and
 * a book that forgot it would authorize the same dollars twice.
 *
 * `settled_usd` null on a held row is a request still in flight. Null on a row nobody ever came
 * back to is a charge nobody can size, and the day's total reads it at the maximum that was held
 * for it rather than at zero. Unknown is not free.
 *
 * `priced` is zero where the model has no entry in the price table. Such a call cannot be held
 * against a dollar ceiling at all, so it is dispatched and counted, and the report says how many
 * there were rather than quietly reading them as free.
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
