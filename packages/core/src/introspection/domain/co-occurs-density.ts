/**
 * The CO_OCCURS density sense: the three-lever floor packet's data half (birth weighting, hub
 * inhibition, admission floors), read from what the producing operations actually observed. No
 * lever changes here; this file only classifies and folds rows `associations.ts` and
 * `activation.ts` already wrote.
 *
 * Every number below is over a sampled window, never the whole graph's distribution: it folds
 * whatever `co_occurs_observed` / `activation_hub_penalty_observed` rows the caller handed in,
 * and the caller states the scan bound those rows came from.
 */

export type CoOccursEpisodeObservation = {
  readonly pairsProposed: number;
  readonly pairsWritten: number;
  readonly births: number;
  readonly recurrences: number;
  readonly birthStrength: number;
};

export type HubPenaltyObservation = {
  readonly hops: number;
  readonly inhibitedHops: number;
  readonly totalPenalty: number;
  readonly minPenalty: number;
};

export type CoOccursDensitySummary = {
  readonly episodesObserved: number;
  readonly pairsProposed: number;
  readonly pairsWritten: number;
  readonly births: number;
  readonly recurrences: number;
  /**
   * One reading per episode that created at least one edge, ascending. Per episode rather than
   * per edge: `associations.ts` reports what a pass wrote as strength once for the whole pass,
   * so an episode that bore six edges contributes one value here and not six.
   *
   * Episodes with no birth are excluded. Their `birthStrength` is the strength a recurring
   * update wrote, and folding it in reported a birth sample the substrate never produced: one
   * birth at 0.8 followed by two recurrence-only passes at 0.1 read as [0.1, 0.1, 0.8].
   */
  readonly birthStrengths: readonly number[];
  /** The same reading from the recurrence-only passes, named apart rather than pooled in. */
  readonly updateStrengths: readonly number[];
  readonly recallWalksObserved: number;
  readonly totalHops: number;
  readonly inhibitedHops: number;
  /** The mean multiplier actually applied, over every walk folded in; 1 means no inhibition ever fired. */
  readonly meanHubPenalty: number | undefined;
  readonly minHubPenaltyObserved: number | undefined;
};

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function summarizeCoOccursDensity(
  episodes: readonly CoOccursEpisodeObservation[],
  walks: readonly HubPenaltyObservation[],
): CoOccursDensitySummary {
  let pairsProposed = 0;
  let pairsWritten = 0;
  let births = 0;
  let recurrences = 0;
  const birthStrengths: number[] = [];
  const updateStrengths: number[] = [];
  for (const episode of episodes) {
    pairsProposed += episode.pairsProposed;
    pairsWritten += episode.pairsWritten;
    births += episode.births;
    recurrences += episode.recurrences;
    if (episode.births > 0) {
      birthStrengths.push(episode.birthStrength);
    } else {
      updateStrengths.push(episode.birthStrength);
    }
  }

  let totalHops = 0;
  let inhibitedHops = 0;
  let totalPenalty = 0;
  let minPenalty: number | undefined;
  for (const walk of walks) {
    totalHops += walk.hops;
    inhibitedHops += walk.inhibitedHops;
    totalPenalty += walk.totalPenalty;
    minPenalty = minPenalty === undefined ? walk.minPenalty : Math.min(minPenalty, walk.minPenalty);
  }

  return {
    episodesObserved: episodes.length,
    pairsProposed,
    pairsWritten,
    births,
    recurrences,
    birthStrengths: birthStrengths.sort((left, right) => left - right),
    updateStrengths: updateStrengths.sort((left, right) => left - right),
    recallWalksObserved: walks.length,
    totalHops,
    inhibitedHops,
    meanHubPenalty: totalHops === 0 ? undefined : totalPenalty / totalHops,
    minHubPenaltyObserved: minPenalty,
  };
}

export function describeCoOccursDensity(summary: CoOccursDensitySummary): readonly string[] {
  const lines: string[] = [];
  if (summary.episodesObserved > 0) {
    const strength = median(summary.birthStrengths);
    const update = median(summary.updateStrengths);
    lines.push(
      `CO_OCCURS density over ${String(summary.episodesObserved)} sampled episode(s): ` +
        `${String(summary.pairsProposed)} pair(s) proposed, ${String(summary.pairsWritten)} written, ` +
        `${String(summary.births)} first birth(s), ${String(summary.recurrences)} recurrent update(s)${
          strength === undefined
            ? ''
            : `, median birth strength ${strength.toFixed(3)} over ` +
              `${String(summary.birthStrengths.length)} episode(s) that bore an edge (per ` +
              'episode, not per edge)'
        }${
          update === undefined
            ? ''
            : `, median update strength ${update.toFixed(3)} over ` +
              `${String(summary.updateStrengths.length)} recurrence-only episode(s)`
        }`,
    );
  }
  if (summary.recallWalksObserved > 0) {
    lines.push(
      `hub inhibition over ${String(summary.recallWalksObserved)} sampled recall walk(s), ` +
        `${String(summary.totalHops)} hop(s) evaluated (physical degree): ` +
        `${String(summary.inhibitedHops)} hop(s) inhibited${
          summary.meanHubPenalty === undefined
            ? ''
            : `, mean multiplier ${summary.meanHubPenalty.toFixed(3)}`
        }${
          summary.minHubPenaltyObserved === undefined
            ? ''
            : `, strongest observed inhibition ${summary.minHubPenaltyObserved.toFixed(3)}`
        }`,
    );
  }
  return lines;
}
