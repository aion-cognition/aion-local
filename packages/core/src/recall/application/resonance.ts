import type { Driver } from 'neo4j-driver';

import type { Config } from '../../infrastructure/config/schema.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import { contextVectors, resonantNodes } from '../../infrastructure/graph/resonance-queries.js';
import { nodeCandidates } from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import type { ActivatedNode } from '../domain/activation.js';
import type { FusedItem } from '../domain/fusion.js';
import { contextCentroid, resonantItem, usableForCentroid } from '../domain/resonance.js';

/**
 * Context resonance, the second pass. The first pass answers what the query asked about; this
 * one answers what the shape of that answer resembles. It takes the activated set, averages the
 * context vectors of its members weighted by activation, searches the context vector index with
 * that centroid, and returns what it finds as a bucket of its own.
 *
 * ADMISSION. A resonant hit is admitted on `contextResonance.contextSearchThreshold`, applied
 * by the search itself, and never on the content floors. The two numbers are cosines in
 * different spaces and neither says anything about the other: `recall.vectorAdmissionFloor` was
 * measured against the noise between a query and a memory's own text, while this one is measured
 * between two means of neighborhoods. A floor calibrated on one distribution is not a floor on
 * the other, so the honest bar is the one the algorithm specifies, and the value it carries sits
 * above the content floor rather than under it. The bucket is a second way in, not a lower one.
 *
 * WHAT THE CENTROID IS BUILT FROM. The whole activated set, weighted by activation, minus the
 * part of it that carries no evidence about the query: a structural node (the graph's own
 * plumbing, traversed but never a memory) and a node no cue-seeded path ever contributed to
 * (`usableForCentroid` in `domain/resonance.ts`). Fusion's own admission is not the filter:
 * whether the first pass could ANSWER the query and whether the spread reached something worth
 * averaging are different questions, and conditioning the second pass on the first's admission
 * is exactly the cap this stage used to carry (`no_anchor` below has kept its name; what
 * qualifies for it has not).
 *
 * Measured on the live substrate, against the OLD anchored-only design this replaced. A centroid
 * over forty arbitrary context vectors returns Postgres, Datadog, psql and a preference about
 * squash merges at 0.95 to 0.98, and it returns them for a nonsense query as readily as for a
 * real one: averaging the whole activated set with no exclusion is the failure the support
 * filter exists to prevent. The centroid of the one node a nonsense query used to admit returns
 * that node's own neighborhood: the Unicode and multilingual test memories around it, at 0.996
 * and up. Same threshold, same query, opposite answers. The threshold was never the
 * discriminator; the source of the centroid is, which is why the filter reads where each node's
 * activation came from rather than fusion's verdict: the nonsense query's sole activation was a
 * recency seed no cue ever reached, so the corrected stage excludes it and finds nothing to
 * average either, honestly rather than by accident of what fusion happened to admit.
 *
 * WHAT IT REFUSES TO RUN ON. The centroid is only meaningful when something in the activated
 * set carries real evidence about the query: a seed a content or lexical strategy found, or a
 * node the spread reached along a path that started at one. Resonance runs precisely when fusion
 * admitted nothing but that evidence still exists — that is the case the stage exists for, since
 * a query fusion answered directly has less need of a second way in. Only when NOTHING usable
 * survives the exclusion does the stage decline: resonating from recency or structural plumbing
 * alone would hand back memories related to the shape of nothing at all.
 */

export type ResonanceDeps = {
  readonly driver: Driver;
  readonly config: Config;
  readonly logger: Logger;
};

export type ResonanceInput = {
  /** The spread's activated set, seeds included. Its scores are the centroid's weights. */
  readonly activated: readonly ActivatedNode[];
  /**
   * Every id the first pass already produced: seeds, the activated set, and the items fusion
   * admitted. A hit on one of these is not a discovery, and a memory that reaches the pack
   * twice under two rationales explains itself with neither.
   */
  readonly exclude: ReadonlySet<string>;
  readonly mode: ReadMode;
};

/**
 * Why a run produced nothing, distinguished because they are different states with different
 * responses. `disabled` is a setting, `no_activation` is a spread that reached nothing,
 * `no_anchor` is activation with nothing usable in it (every node was structural, unreached by
 * any cue-seeded path, or both), `no_context_vectors` is a substrate whose enrichment has not
 * caught up, and
 * `unavailable` is an outage in a stage the caller is not entitled to lose a pack over.
 */
export type ResonanceSkip =
  'disabled' | 'no_activation' | 'no_anchor' | 'no_context_vectors' | 'unavailable';

export type ResonanceResult = {
  /** Best first, by context similarity. Empty whenever `skipped` is set. */
  readonly items: readonly FusedItem[];
  readonly skipped?: ResonanceSkip;
  /**
   * How many of the activated nodes carried a context vector. The rate is what says whether a
   * quiet stage is a cold substrate or a stage that ran and found nothing.
   */
  readonly covered: number;
  readonly activated: number;
  /**
   * The centroid this pass searched with, handed back rather than kept, so the intention
   * triggers that run after it compare against the same shape instead of computing a second
   * one. Absent whenever the stage skipped, which is what makes a situation trigger unable to
   * fire on a run that had nothing to take a mean of.
   */
  readonly centroid?: Vector;
};

function skip(skipped: ResonanceSkip, activated: number, covered = 0): ResonanceResult {
  return { items: [], skipped, covered, activated };
}

/**
 * The centroid over the usable part of the activated set, or `undefined` when none of those
 * nodes has been through reflection's last stage. `covered` counts the same restricted set, so
 * a quiet stage still reports coverage of what it actually tried to average.
 */
async function centroidOf(
  deps: ResonanceDeps,
  usable: readonly ActivatedNode[],
  mode: ReadMode,
): Promise<{ centroid?: Vector; covered: number }> {
  const rows = await contextVectors(deps.driver, {
    ids: usable.map((node) => node.nodeId),
    mode,
  });
  const vectors = new Map<string, Vector>(rows.map((row) => [row.id, row.vector]));
  const centroid = contextCentroid(usable, vectors);
  return { ...(centroid === undefined ? {} : { centroid }), covered: vectors.size };
}

/**
 * Hydrated through the same read every other id-keyed stage uses, so a resonant hit is judged
 * for currency on the row that actually reaches the agent and a node forgotten between the two
 * reads is suppressed. A row with no renderable content is dropped for the reason fusion drops
 * one: a memory the pack cannot render has nothing to hand the agent.
 */
async function hydrateHits(
  deps: ResonanceDeps,
  hits: readonly { readonly id: string; readonly similarity: number }[],
  mode: ReadMode,
): Promise<readonly FusedItem[]> {
  const rows = await nodeCandidates(deps.driver, { ids: hits.map((hit) => hit.id), mode });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items: FusedItem[] = [];
  for (const hit of hits) {
    const candidate = byId.get(hit.id);
    if (candidate === undefined || candidate.content.trim().length === 0) {
      continue;
    }
    items.push(resonantItem(candidate, hit.similarity));
  }
  return items;
}

/**
 * Never throws. A graph error here costs the pack its resonant bucket and nothing else: the
 * first pass has already produced an answer by the time this runs, and losing a whole recall to
 * the associative stage would be the wrong trade every time.
 */
export async function resonate(
  deps: ResonanceDeps,
  input: ResonanceInput,
): Promise<ResonanceResult> {
  const activated = input.activated.length;
  if (!deps.config.recall.useContextResonance) {
    return skip('disabled', activated);
  }
  if (activated === 0) {
    return skip('no_activation', activated);
  }
  const usable = usableForCentroid(input.activated);
  if (usable.length === 0) {
    deps.logger.debug(
      { activated },
      'context resonance skipped: nothing but recency or structural plumbing activated',
    );
    return skip('no_anchor', activated);
  }

  try {
    const { centroid, covered } = await centroidOf(deps, usable, input.mode);
    if (centroid === undefined) {
      deps.logger.debug(
        { activated, covered },
        'context resonance skipped: no activated node carries a context vector yet',
      );
      return skip('no_context_vectors', activated, covered);
    }

    const hits = await resonantNodes(deps.driver, {
      centroid,
      threshold: deps.config.contextResonance.contextSearchThreshold,
      limit: deps.config.contextResonance.resonantLimit,
      exclude: input.exclude,
      mode: input.mode,
    });
    const items = await hydrateHits(deps, hits, input.mode);
    deps.logger.debug(
      { activated, usable: usable.length, covered, hits: hits.length, items: items.length },
      'context resonance ran',
    );
    return { items, covered, activated, centroid };
  } catch (err) {
    deps.logger.warn({ err }, 'context resonance failed; the pack keeps its first-pass answer');
    return skip('unavailable', activated);
  }
}
