import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * What the substrate's own recall probe has found: how often a stored experience comes back
 * when the substrate is asked for it in its own words, and how much of what recall served was
 * ever used afterward. Both survive a restart here, which is what makes them readable numbers
 * rather than a line in a log nobody tails.
 *
 * The two are kept differently on purpose. A probe trial is a fresh question every time, so
 * trials accumulate and the rate is a lifetime figure. The served reading is a rate over rows
 * that are still in `served_items` when the run reads them, and those same rows are read again
 * on the next run, so accumulating it would count one serve many times. It is stored as the
 * latest reading with the moment it was taken.
 */

const PROBE_SAMPLES_KEY = 'recall_probe:samples';
const PROBE_HITS_KEY = 'recall_probe:hits';
const SERVED_ITEMS_KEY = 'recall_probe:served_items';
const SERVED_REFERENCED_KEY = 'recall_probe:served_referenced';
const SERVED_MEASURED_AT_KEY = 'recall_probe:served_measured_at';

export type RecallProbeTrial = {
  /** The pack held the sampled episode, something extracted from it, or a narrative over it. */
  readonly hit: boolean;
};

export type ServedReferenceInput = {
  readonly items: number;
  readonly referenced: number;
  readonly measuredAt: string;
};

export type ServedReferenceReading = {
  readonly items: number;
  readonly referenced: number;
  /** Undefined when no served item was old enough to judge: none of none is not a miss. */
  readonly rate: number | undefined;
  readonly measuredAt: string;
};

export type RecallProbeCounters = {
  readonly samples: number;
  readonly hits: number;
  /** Undefined until the first probe, so a fresh substrate reads as unmeasured, not as failing. */
  readonly hitRate: number | undefined;
  /** Absent until a run has read the served rows at all. */
  readonly served: ServedReferenceReading | undefined;
};

function readCount(db: SqliteHandle, key: string): number {
  const parsed = Number(getMeta(db, key) ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(part: number, total: number): number | undefined {
  if (total <= 0) {
    return undefined;
  }
  return part / total;
}

/**
 * One probe question and its verdict. The read and the write are one unit, as in the counters
 * beside this one: the service and the CLI open the same store, and an increment computed off a
 * stale snapshot is lost for good, since nothing ages these totals out.
 */
export function recordRecallProbeTrial(db: SqliteHandle, trial: RecallProbeTrial): void {
  db.transaction(() => {
    setMeta(db, PROBE_SAMPLES_KEY, String(readCount(db, PROBE_SAMPLES_KEY) + 1));
    if (trial.hit) {
      setMeta(db, PROBE_HITS_KEY, String(readCount(db, PROBE_HITS_KEY) + 1));
    }
  }).immediate();
}

/** The whole reading at once, so a half-written pair can never be read as a rate. */
export function recordServedReferenceReading(
  db: SqliteHandle,
  reading: ServedReferenceInput,
): void {
  db.transaction(() => {
    setMeta(db, SERVED_ITEMS_KEY, String(Math.max(0, reading.items)));
    setMeta(db, SERVED_REFERENCED_KEY, String(Math.max(0, reading.referenced)));
    setMeta(db, SERVED_MEASURED_AT_KEY, reading.measuredAt);
  }).immediate();
}

function servedReading(db: SqliteHandle): ServedReferenceReading | undefined {
  const measuredAt = getMeta(db, SERVED_MEASURED_AT_KEY);
  if (measuredAt === undefined) {
    return undefined;
  }
  const items = readCount(db, SERVED_ITEMS_KEY);
  const referenced = readCount(db, SERVED_REFERENCED_KEY);
  return { items, referenced, rate: rate(referenced, items), measuredAt };
}

export function recallProbeCounters(db: SqliteHandle): RecallProbeCounters {
  const samples = readCount(db, PROBE_SAMPLES_KEY);
  const hits = readCount(db, PROBE_HITS_KEY);
  return { samples, hits, hitRate: rate(hits, samples), served: servedReading(db) };
}
