/**
 * What the batch lane owes, and how much a reading calls for a run of its pump.
 *
 * The lane has three kinds of waiting work and they are not the same claim. Work nothing has
 * sent is local delay: a run sends it the tick it is chosen. Work a remote job holds is the
 * vendor's time: a run can only ask whether it finished, and asking again soon after the last
 * answer buys nothing. A settled job whose files the vendor would not delete is cleanup the lane
 * still owes after its last row settled, since those files hold memory text until a retry removes
 * them. Never-sent work waits from when it was owed and remote work from when it was sent, both
 * at most from the lane's last check; a failed deletion waits from the pass that last tried it.
 * That is what keeps a check that could not help (a refused submission, a job still working, a
 * deletion refused again) from being repeated on every tick.
 *
 * Work no run can move is counted and scores nothing: never-sent work for a provider with no key,
 * never-sent work on a day whose ceiling cannot hold the batch a run would send, and remote work
 * or a deletion whose provider key is gone. Choosing the pump for any of those would take a tick
 * and make no progress.
 */

export type BatchBlock = 'missing_key' | 'spent_ceiling';

export type BatchDemand = {
  /** Never-sent rows for the selected provider that a run could submit now. */
  readonly sendable: number;
  /** Never-sent rows for the selected provider that wait on something a run cannot change. */
  readonly blocked: number;
  /**
   * Why `blocked` is not sendable: no key for the selected provider, or no room left under the
   * day's ceiling for the batch a run would send.
   */
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
  /** Settled jobs whose files a deletion at the vendor failed to remove, with that key present. */
  readonly releases: number;
  /** Failed deletions whose provider key is gone, so no run can retry them yet. */
  readonly unkeyedReleases: number;
  /** When the pump last ran, from its durable run record. Undefined when it never has. */
  readonly lastCheckedAt: string | undefined;
  /** How long the oldest sendable or obsolete row has waited since it was owed or last checked. */
  readonly localWaitMs: number | undefined;
  /** How long the oldest readable remote job has waited since it was sent or last checked. */
  readonly remoteWaitMs: number | undefined;
  /** How long the retryable deletions have waited since the pass that last tried them. */
  readonly releaseWaitMs: number | undefined;
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
  releases: 0,
  unkeyedReleases: 0,
  lastCheckedAt: undefined,
  localWaitMs: undefined,
  remoteWaitMs: undefined,
  releaseWaitMs: undefined,
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
  if (demand.releases > 0) {
    waits.push(demand.releaseWaitMs ?? 0);
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
