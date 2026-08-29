import type { Driver } from 'neo4j-driver';
import type { Config } from '../../infrastructure/config/schema.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import { contextVectors, resonantNodes } from '../../infrastructure/graph/resonance-queries.js';
import { nodeCandidates } from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import type { ActivatedNode } from '../domain/activation.js';
import type { FusedItem } from '../domain/fusion.js';
import { contextCentroid, resonantItem } from '../domain/resonance.js';

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
 * the other, so the honest bar is the one the algorithm specifies, and 0.7 sits above the
 * content floor rather than under it. The bucket is a second way in, not a lower one.
 *
 * WHAT IT REFUSES TO RUN ON. The centroid is only meaningful when the first pass found
 * something. If nothing cleared admission on its own evidence, the activated set is whatever
 * the recency leg happened to return, and resonating from it would hand back memories related
 * to the shape of nothing at all. That is the failure the floors exist to prevent, so the stage
 * declines the query instead.
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
  /** `admission.anchored`: at least one candidate cleared the gate on its own evidence. */
  readonly anchored: boolean;
  readonly mode: ReadMode;
};

/**
 * Why a run produced nothing, distinguished because they are different states with different
 * responses. `disabled` is a setting, `no_anchor` is a query the substrate could not answer,
 * `no_context_vectors` is a substrate whose enrichment has not caught up, and `unavailable` is
 * an outage in a stage the caller is not entitled to lose a pack over.
 */
export type ResonanceSkip =
  | 'disabled'
  | 'no_activation'
  | 'no_anchor'
  | 'no_context_vectors'
  | 'unavailable';

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
};

function skip(skipped: ResonanceSkip, activated: number, covered = 0): ResonanceResult {
  return { items: [], skipped, covered, activated };
}

/** The centroid, or `undefined` when no activated node has been through reflection's last stage. */
async function centroidOf(
  deps: ResonanceDeps,
  input: ResonanceInput,
): Promise<{ centroid?: Vector; covered: number }> {
  const rows = await contextVectors(deps.driver, {
    ids: input.activated.map((node) => node.nodeId),
    mode: input.mode,
  });
  const vectors = new Map<string, Vector>(rows.map((row) => [row.id, row.vector]));
  const centroid = contextCentroid(input.activated, vectors);
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
  if (!input.anchored) {
    deps.logger.debug({ activated }, 'context resonance skipped: the first pass anchored nothing');
    return skip('no_anchor', activated);
  }

  try {
    const { centroid, covered } = await centroidOf(deps, input);
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
      { activated, covered, hits: hits.length, items: items.length },
      'context resonance ran',
    );
    return { items, covered, activated };
  } catch (err) {
    deps.logger.warn({ err }, 'context resonance failed; the pack keeps its first-pass answer');
    return skip('unavailable', activated);
  }
}
