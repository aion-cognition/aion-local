import type { PublishedBridge } from '../../infrastructure/graph/bridge-queries.js';

/**
 * The compatibility-calibration sense: whether a bridge's traversal record and its author's own
 * compatibility reading agree, reported as a usefulness observation rather than as a verdict on
 * that reading.
 *
 * Higher compatibility already makes propagation easier (`edges.ts` writes the model's
 * compatibility as both edge legs' strength and confidence), so a bridge that traverses often is
 * partly explained by the weight its own author gave it. Traversal under those weights is
 * evidence the bridge is being used, never independent proof the compatibility judgment that
 * weighted it was right. Non-use is reported the same neutral way: a bridge nothing has walked
 * yet is a missing-opportunity case, not a penalty.
 *
 * The association between the two is the whole point, so it is kept rather than summarized away.
 * Counting compatibility values in one list and traversals in another let two substrates whose
 * high- and low-compatibility bridges had opposite fates read identically: swapping which bridge
 * was crossed changed nothing a reader could see. The populations below are conditional on the
 * traversal outcome, which is the smallest thing that keeps the pairing legible without turning
 * it into an effectiveness threshold.
 */

export type BridgeTraversalRecord = {
  readonly bridgeId: string;
  readonly crossed: boolean;
};

/** What the window's records say about one bridge, and the third case that is not a finding. */
export type CompatibilityOutcome = 'crossed' | 'leg_only' | 'no_record';

/**
 * One outcome's own population: how many bridges landed there, what their authors had scored
 * them, and how old they are. `compatibilityUnknown` counts the bridges in the population whose
 * author gave no reading at all, so a median over four values beside six unknowns is readable as
 * exactly that rather than as a median over ten.
 */
export type CompatibilityPopulation = {
  readonly outcome: CompatibilityOutcome;
  readonly bridges: number;
  /** The authors' own compatibility readings inside this population, ascending. */
  readonly compatibility: readonly number[];
  readonly compatibilityUnknown: number;
  /** Age since publication, milliseconds, ascending. */
  readonly ageMs: readonly number[];
};

export type CompatibilityCalibrationGroup = {
  readonly author: PublishedBridge['author'];
  readonly published: number;
  /** Carried at least one recorded leg contribution, of either direction. */
  readonly observed: number;
  /** Carried a recorded end-to-end crossing: both legs fired in the same walk at least once. */
  readonly crossed: number;
  /** Published bridges this read has no traversal record for at all. */
  readonly missingData: number;
  /** Age since publication, milliseconds, ascending; the opportunity population's own clock. */
  readonly ageMs: readonly number[];
  /** The author's own compatibility reading, where it gave one, ascending. */
  readonly compatibility: readonly number[];
  /** The same bridges, split by what the window's records say happened to each. */
  readonly populations: readonly CompatibilityPopulation[];
};

export type CompatibilityCalibrationSummary = {
  readonly asOf: string;
  readonly totalPublished: number;
  readonly groups: readonly CompatibilityCalibrationGroup[];
};

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * One entry per bridge id actually observed, folding every row the traversal stream carries for
 * it: `crossed` once any walk crossed it end to end, `observed` for the rest.
 */
function foldObservations(
  records: readonly BridgeTraversalRecord[],
): ReadonlyMap<string, { crossed: boolean }> {
  const folded = new Map<string, { crossed: boolean }>();
  for (const record of records) {
    const existing = folded.get(record.bridgeId);
    folded.set(record.bridgeId, { crossed: (existing?.crossed ?? false) || record.crossed });
  }
  return folded;
}

const OUTCOME_ORDER: readonly CompatibilityOutcome[] = ['crossed', 'leg_only', 'no_record'];

function outcomeFor(record: { readonly crossed: boolean } | undefined): CompatibilityOutcome {
  if (record === undefined) {
    return 'no_record';
  }
  return record.crossed ? 'crossed' : 'leg_only';
}

/**
 * Matches published bridges against their traversal record. `bridges` is the graph's own list of
 * what the substrate currently stands behind (`listPublishedBridges`); `records` is every
 * `bridge_traversal_observed` row in the sense's window, one entry per leg contribution or
 * crossing a walk reported. A bridge id in `records` that names no currently-published bridge is
 * silently excluded: it was superseded or forgotten since, and this summary reports the live
 * population.
 */
export function summarizeCompatibilityCalibration(
  bridges: readonly PublishedBridge[],
  records: readonly BridgeTraversalRecord[],
  now: Date,
): CompatibilityCalibrationSummary {
  const observations = foldObservations(records);
  const byAuthor = new Map<PublishedBridge['author'], PublishedBridge[]>();
  for (const bridge of bridges) {
    const list = byAuthor.get(bridge.author) ?? [];
    list.push(bridge);
    byAuthor.set(bridge.author, list);
  }

  const groups: CompatibilityCalibrationGroup[] = [...byAuthor.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([author, entries]) => {
      let observed = 0;
      let crossed = 0;
      const ageMs: number[] = [];
      const compatibility: number[] = [];
      const paired = new Map<
        CompatibilityOutcome,
        { compatibility: number[]; unknown: number; ageMs: number[] }
      >();
      for (const bridge of entries) {
        const record = observations.get(bridge.id);
        if (record !== undefined) {
          observed += 1;
          if (record.crossed) {
            crossed += 1;
          }
        }
        const age = Math.max(0, now.getTime() - bridge.createdAt.getTime());
        ageMs.push(age);
        if (bridge.compatibility !== undefined) {
          compatibility.push(bridge.compatibility);
        }
        const outcome = outcomeFor(record);
        const bucket = paired.get(outcome) ?? { compatibility: [], unknown: 0, ageMs: [] };
        bucket.ageMs.push(age);
        if (bridge.compatibility === undefined) {
          bucket.unknown += 1;
        } else {
          bucket.compatibility.push(bridge.compatibility);
        }
        paired.set(outcome, bucket);
      }
      const populations: CompatibilityPopulation[] = OUTCOME_ORDER.flatMap((outcome) => {
        const bucket = paired.get(outcome);
        if (bucket === undefined) {
          return [];
        }
        return [
          {
            outcome,
            bridges: bucket.compatibility.length + bucket.unknown,
            compatibility: [...bucket.compatibility].sort((left, right) => left - right),
            compatibilityUnknown: bucket.unknown,
            ageMs: [...bucket.ageMs].sort((left, right) => left - right),
          },
        ];
      });
      return {
        author,
        published: entries.length,
        observed,
        crossed,
        missingData: entries.length - observed,
        ageMs: ageMs.sort((left, right) => left - right),
        compatibility: compatibility.sort((left, right) => left - right),
        populations,
      };
    });

  return { asOf: now.toISOString(), totalPublished: bridges.length, groups };
}

const OUTCOME_LABEL: Record<CompatibilityOutcome, string> = {
  crossed: 'crossed end to end',
  leg_only: 'one leg only',
  no_record: 'no traversal record in the window',
};

function describePopulation(population: CompatibilityPopulation): string {
  const compat = median(population.compatibility);
  const age = median(population.ageMs);
  const unknown =
    population.compatibilityUnknown === 0
      ? ''
      : `, ${String(population.compatibilityUnknown)} with no compatibility reading`;
  const compatNote = compat === undefined ? '' : `, median compatibility ${compat.toFixed(2)}`;
  const ageNote = age === undefined ? '' : `, median age ${(age / 86_400_000).toFixed(1)}d`;
  return `    ${OUTCOME_LABEL[population.outcome]}: ${String(
    population.bridges,
  )} bridge(s)${compatNote}${ageNote}${unknown}`;
}

export function describeCompatibilityCalibration(
  summary: CompatibilityCalibrationSummary,
): readonly string[] {
  if (summary.totalPublished === 0) {
    return ['compatibility calibration: no published bridges yet'];
  }
  const lines = summary.groups.flatMap((group) => {
    const age = median(group.ageMs);
    const compat = median(group.compatibility);
    return [
      `${group.author}: ${String(group.published)} published, ${String(group.observed)} with ` +
        `recorded traversal (${String(group.crossed)} crossed end to end), ` +
        `${String(group.missingData)} with no traversal record in the window${
          age === undefined ? '' : `, median age ${(age / 86_400_000).toFixed(1)}d`
        }${compat === undefined ? '' : `, median compatibility ${compat.toFixed(2)}`}`,
      ...group.populations.map(describePopulation),
    ];
  });
  return [
    `compatibility calibration as of ${summary.asOf}, ${String(summary.totalPublished)} ` +
      "published bridge(s). Traversal under a bridge's own compatibility weight is a " +
      'usefulness observation, not independent proof the compatibility judgment was right; ' +
      'a bridge with no traversal record has none in the observed window, which says nothing ' +
      'about use before it and is not penalized. The split below is what each outcome ' +
      "population's compatibility readings look like, not a bar any of them has to clear:",
    ...lines,
  ];
}
