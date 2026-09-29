/**
 * What the batch lane owes, and how much a reading calls for a run of its pump.
 *
 * The lane has two kinds of waiting work and they are not the same claim. Work nothing has sent is
 * local delay: a run sends it the tick it is chosen. Work a remote job holds is the vendor's time:
 * a run can only ask whether it finished, and asking again soon after the last answer buys
 * nothing. So never-sent work waits from when it was owed, and remote work waits from when it was
 * sent, and both wait at most from the lane's last check, which is what keeps a check that could
 * not help (a refused submission, a job still working) from being repeated on every tick.
 *
 * Work no run can move is counted and scores nothing: never-sent work for a provider with no key,
 * never-sent work on a day whose ceiling is spent, and remote work whose provider key is gone.
 * Choosing the pump for any of those would take a tick and make no progress.
 */

export type BatchBlock = 'missing_key' | 'spent_ceiling';

export type BatchDemand = {
  /** Never-sent rows for the selected provider that a run could submit now. */
  readonly sendable: number;
  /** Never-sent rows for the selected provider that wait on something a run cannot change. */
  readonly blocked: number;
  /** Why `blocked` is not sendable: no key for the selected provider, or the day is spent. */
  readonly blockedBy: BatchBlock | undefined;
  /**
   * Never-sent rows encoded for a provider the installation no longer selects. A run discards
   * them without a call, and a producer that asks again re-encodes them, so they are work.
   */
  readonly obsolete: number;
  /** Rows a remote job holds whose provider key is present, so a run can read their answers. */
  readonly outstanding: number;
  /** Rows a remote job holds whose provider key is gone. Nothing reads them until it is back. */
  readonly unreadable: number;
  /** When the pump last ran, from its durable run record. Undefined when it never has. */
  readonly lastCheckedAt: string | undefined;
  /** How long the oldest sendable or obsolete row has waited since it was owed or last checked. */
  readonly localWaitMs: number | undefined;
  /** How long the oldest readable remote job has waited since it was sent or last checked. */
  readonly remoteWaitMs: number | undefined;
  readonly availability: 'measured' | 'unavailable';
  readonly diagnostic?: string;
};

/**
 * No reading, which is not an empty lane. The pump then keeps the standing claim it had before the
 * lane was observed, so a census nobody could take neither silences it nor calls for it.
 */
export const NEUTRAL_BATCH_DEMAND: BatchDemand = {
  sendable: 0,
  blocked: 0,
  blockedBy: undefined,
  obsolete: 0,
  outstanding: 0,
  unreadable: 0,
  lastCheckedAt: undefined,
  localWaitMs: undefined,
  remoteWaitMs: undefined,
  availability: 'unavailable',
  diagnostic: 'the batch lane was not read on this tick',
};

/**
 * The least a lane with actionable work scores, and what an unread lane scores. Work that was
 * just checked still exists, so it stays a candidate the starvation boost can carry.
 */
export const BATCH_SETTLEMENT_STANDING_RELEVANCE = 0.15;

export type BatchRelevanceScales = {
  /**
   * The wait that earns full relevance. The catalog binds it to one starvation span of wall time,
   * the longest the engine lets any operation be passed over before doubling its claim.
   */
  readonly fullWaitMs: number;
};

export function batchSettlementRelevance(
  demand: BatchDemand,
  scales: BatchRelevanceScales,
): number {
  if (demand.availability !== 'measured') {
    return BATCH_SETTLEMENT_STANDING_RELEVANCE;
  }
  const waits: number[] = [];
  if (demand.sendable + demand.obsolete > 0) {
    waits.push(demand.localWaitMs ?? 0);
  }
  if (demand.outstanding > 0) {
    waits.push(demand.remoteWaitMs ?? 0);
  }
  if (waits.length === 0) {
    return 0;
  }
  if (scales.fullWaitMs <= 0) {
    return 1;
  }
  const longest = waits.reduce((most, wait) => Math.max(most, wait), 0);
  return Math.min(1, Math.max(BATCH_SETTLEMENT_STANDING_RELEVANCE, longest / scales.fullWaitMs));
}
