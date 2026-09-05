import type { Driver } from 'neo4j-driver';

import type { ResonanceResult } from './resonance.js';
import type { Config } from '../../infrastructure/config/schema.js';
import {
  findTriggerableIntentions,
  TRIGGERABLE_INTENTION_SCAN_LIMIT,
} from '../../infrastructure/graph/intention-queries.js';
import { isTimeTravel, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import { nodeCandidates } from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { ActivatedNode } from '../domain/activation.js';
import type { FusedItem } from '../domain/fusion.js';
import {
  matchIntentionTriggers,
  triggeredIntentionItem,
  type IntentionTriggerMatch,
} from '../domain/intention-triggers.js';

/**
 * The third way into a pack, after the query's own answer and the second pass: standing
 * intentions whose trigger condition this moment meets. One bounded read and a loop, both
 * deterministic. The hot path keeps exactly one generation call, and this is not it.
 *
 * It runs after resonance because it reads that stage's centroid. Recomputing one here would
 * mean a second pass over the same vectors for the same number.
 */

export type IntentionDeps = {
  readonly driver: Driver;
  readonly config: Config;
  readonly logger: Logger;
};

export type IntentionInput = {
  /** The spread's activated set, seeds included. An entity trigger tests membership in it. */
  readonly activated: readonly ActivatedNode[];
  /** The second pass's own result, read for the centroid a situation trigger compares against. */
  readonly resonance: ResonanceResult;
  /** Everything the run already produced. An intention among them stays where the query put it. */
  readonly served: readonly FusedItem[];
  readonly mode: ReadMode;
  readonly now: Date;
};

/**
 * Why a run brought nothing back, kept apart because the states call for different responses.
 * `disabled` is the kill switch, `time_travel` is a read about the past, `none_open` is a
 * substrate holding no triggerable intention, `no_trigger` is intentions that exist and were
 * not due, and `unavailable` is an outage the caller must not lose a pack over.
 */
export type IntentionSkip = 'disabled' | 'time_travel' | 'none_open' | 'no_trigger' | 'unavailable';

export type IntentionResult = {
  /** Best first, narrowest trigger first. Empty whenever `skipped` is set. */
  readonly items: readonly FusedItem[];
  readonly skipped?: IntentionSkip;
};

function skip(skipped: IntentionSkip): IntentionResult {
  return { items: [], skipped };
}

/**
 * Hydrated through the read every other id-keyed stage uses, so a triggered intention is judged
 * for currency on the row that reaches the agent and one forgotten between the two reads is
 * suppressed. A row with no renderable content is dropped for the reason fusion drops one.
 */
async function hydrateMatches(
  deps: IntentionDeps,
  matches: readonly IntentionTriggerMatch[],
  mode: ReadMode,
): Promise<readonly FusedItem[]> {
  const rows = await nodeCandidates(deps.driver, { ids: matches.map((match) => match.id), mode });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items: FusedItem[] = [];
  for (const match of matches) {
    const candidate = byId.get(match.id);
    if (candidate === undefined || candidate.content.trim().length === 0) {
      continue;
    }
    items.push(triggeredIntentionItem(candidate, match));
  }
  return items;
}

/**
 * Never throws. A graph error here costs the pack its intentions bucket and nothing else: the
 * query has already been answered by the time this runs, and an empty pack is still an answer
 * the caller is entitled to.
 *
 * A time-traveled read evaluates nothing at all. Asking what the substrate held last month is a
 * question about the past, and a trigger is the substrate acting in the present; firing one from
 * a historical vantage point would answer a question nobody asked, at a moment that already
 * happened. This is the same exemption dedup and the own-session filter take.
 */
export async function triggeredIntentions(
  deps: IntentionDeps,
  input: IntentionInput,
): Promise<IntentionResult> {
  if (!deps.config.recall.intentionTriggers) {
    return skip('disabled');
  }
  if (isTimeTravel(input.mode)) {
    return skip('time_travel');
  }

  try {
    const intentions = await findTriggerableIntentions(deps.driver, {
      mode: input.mode,
      now: input.now,
      limit: TRIGGERABLE_INTENTION_SCAN_LIMIT,
    });
    if (intentions.length === 0) {
      return skip('none_open');
    }

    const matches = matchIntentionTriggers(intentions, {
      activatedIds: new Set(input.activated.map((node) => node.nodeId)),
      ...(input.resonance.centroid === undefined ? {} : { centroid: input.resonance.centroid }),
      now: input.now,
      situationFloor: deps.config.recall.intentionSituationFloor,
      limit: deps.config.recall.maxIntentions,
      exclude: new Set(input.served.map((item) => item.id)),
    });
    if (matches.length === 0) {
      return skip('no_trigger');
    }

    const items = await hydrateMatches(deps, matches, input.mode);
    deps.logger.debug(
      { open: intentions.length, matched: matches.length, items: items.length },
      'intention triggers fired',
    );
    return { items };
  } catch (err) {
    deps.logger.warn({ err }, 'intention triggers failed; the pack keeps the answer it has');
    return skip('unavailable');
  }
}
