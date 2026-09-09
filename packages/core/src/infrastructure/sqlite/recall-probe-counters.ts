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

/**
 * The second-generation reading, kept under keys of its own.
 *
 * The old structural hit rate counted "the pack held the episode, something extracted from it,
 * or a narrative over it" against a denominator that dropped whatever the graph no longer
 * projected. This one counts different things over a different population, and mixing the two
 * would produce a rate whose denominator changed underneath it. The old totals stay where they
 * are, unread by anything new, until a declared replacement scalar has been validated.
 */
const V2 = 'recall_probe:v2:';

const V2_TRIALS_KEY = `${V2}trials`;
const V2_RESOLVABLE_KEY = `${V2}source_resolvable`;
const V2_RELATED_KEY = `${V2}source_related_retrieval`;
const V2_UNAVAILABLE_KEY = `${V2}unavailable`;
const V2_INELIGIBLE_KEY = `${V2}ineligible`;
const V2_SERVED_ITEMS_KEY = `${V2}served_items`;
const V2_SERVED_REFERENCED_KEY = `${V2}served_referenced`;
const V2_SERVED_UNVERSIONED_KEY = `${V2}served_unversioned`;
const V2_SERVED_MEASURED_AT_KEY = `${V2}served_measured_at`;

export type ProbeTrialOutcome = {
  /** The sampled raw record could be inspected with verified identity and evidence. */
  readonly resolvable: boolean;
  /** An emitted item has a recorded source relationship to the sample. Not an answer. */
  readonly relatedRetrieval: boolean;
};

export type ServedReferenceInputV2 = {
  readonly items: number;
  readonly referenced: number;
  /** Items whose incidence carries no acknowledged clock, so after-serve is unknowable. */
  readonly unversioned: number;
  readonly measuredAt: string;
};

export type RecallProbeReadingV2 = {
  readonly trials: number;
  readonly sourceResolvable: number;
  readonly sourceRelatedRetrieval: number;
  /** Trials the probe could not ask at all. Not misses, and never counted as any. */
  readonly unavailable: number;
  /** Samples the declared maturity policy excluded. Not misses either. */
  readonly ineligible: number;
  readonly served:
    | {
        readonly items: number;
        readonly referenced: number;
        readonly unversioned: number;
        readonly measuredAt: string;
      }
    | undefined;
};

/**
 * One scored trial. The two outcomes are counted apart because they answer different questions,
 * and neither of them is `answer_quality`: whether the prose answered is measured by a
 * source-specific fixture or a declared evaluation, never inferred from a structural hit.
 */
export function recordProbeTrialV2(db: SqliteHandle, outcome: ProbeTrialOutcome): void {
  db.transaction(() => {
    setMeta(db, V2_TRIALS_KEY, String(readCount(db, V2_TRIALS_KEY) + 1));
    if (outcome.resolvable) {
      setMeta(db, V2_RESOLVABLE_KEY, String(readCount(db, V2_RESOLVABLE_KEY) + 1));
    }
    if (outcome.relatedRetrieval) {
      setMeta(db, V2_RELATED_KEY, String(readCount(db, V2_RELATED_KEY) + 1));
    }
  }).immediate();
}

/** A trial nobody could run, and a sample the policy excluded. Kept apart from each other. */
export function recordProbeUnavailable(db: SqliteHandle): void {
  setMeta(db, V2_UNAVAILABLE_KEY, String(readCount(db, V2_UNAVAILABLE_KEY) + 1));
}

export function recordProbeIneligible(db: SqliteHandle): void {
  setMeta(db, V2_INELIGIBLE_KEY, String(readCount(db, V2_INELIGIBLE_KEY) + 1));
}

export function recordServedReferenceReadingV2(
  db: SqliteHandle,
  reading: ServedReferenceInputV2,
): void {
  db.transaction(() => {
    setMeta(db, V2_SERVED_ITEMS_KEY, String(Math.max(0, reading.items)));
    setMeta(db, V2_SERVED_REFERENCED_KEY, String(Math.max(0, reading.referenced)));
    setMeta(db, V2_SERVED_UNVERSIONED_KEY, String(Math.max(0, reading.unversioned)));
    setMeta(db, V2_SERVED_MEASURED_AT_KEY, reading.measuredAt);
  }).immediate();
}

/**
 * The raw tallies, and no rate. A single number over a population that changed is what the
 * versioning exists to prevent; whoever compares these compares counts and the evidence behind
 * them.
 */
export function recallProbeReadingV2(db: SqliteHandle): RecallProbeReadingV2 {
  const measuredAt = getMeta(db, V2_SERVED_MEASURED_AT_KEY);
  return {
    trials: readCount(db, V2_TRIALS_KEY),
    sourceResolvable: readCount(db, V2_RESOLVABLE_KEY),
    sourceRelatedRetrieval: readCount(db, V2_RELATED_KEY),
    unavailable: readCount(db, V2_UNAVAILABLE_KEY),
    ineligible: readCount(db, V2_INELIGIBLE_KEY),
    served:
      measuredAt === undefined
        ? undefined
        : {
            items: readCount(db, V2_SERVED_ITEMS_KEY),
            referenced: readCount(db, V2_SERVED_REFERENCED_KEY),
            unversioned: readCount(db, V2_SERVED_UNVERSIONED_KEY),
            measuredAt,
          },
  };
}
