import type { AssessmentReport, Degradation } from '@aion/protocol';
import { z } from 'zod';

import {
  assessmentPool,
  buildAssessmentMessages,
  candidateBudget,
  type AssessmentPool,
  type AssessmentQuery,
  type PoolEntry,
  type Population,
} from './assessment-pool.js';
import { capsFor } from './recall-policy.js';
import type { ServingAssembly } from './serving-assembly.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { isAbortError, roundMs } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { isGenerationUnavailable } from '../../infrastructure/providers/errors.js';
import type { JsonSchema, Provider } from '../../infrastructure/providers/types.js';
import { describeMeasurement } from '../domain/admission.js';
import type { FusedItem } from '../domain/fusion.js';
import { MAX_ASSESSOR_NOTE_CHARS } from '../domain/pack-notes.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';

export {
  assessmentPool,
  buildAssessmentMessages,
  candidateBudget,
  MAX_CANDIDATE_CHARS,
  type AssessmentPool,
  type AssessmentQuery,
  type PoolEntry,
  type Population,
} from './assessment-pool.js';

/**
 * Recall's `assess` mode: after retrieval and the evidence reading, the recall model is shown what
 * was found and chooses what helps, most useful first. Its selection is the pack.
 *
 * The host checks identity, never judgment. A number that names no candidate is dropped, and a
 * selected memory is served as the record it is, with its own standing, time and currency. A valid
 * selection is honored whatever it holds: many memories, one surprising association, or none.
 * A call that produces no usable answer (unavailable, timed out, failed, unreadable) serves the
 * existing ranking of the same candidates and says so.
 */

export const RECALL_ASSESSMENT_SURFACE = 'recall_assessment';

/** The answer is a list of numbers and at most one short note. */
const ASSESSMENT_MAX_TOKENS = 1024;

const ASSESSMENT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    selected: { type: 'array', items: { type: 'integer' } },
    note: { type: 'string' },
  },
  required: ['selected'],
};

/** Numbers as the model wrote them; a `#3` or `"3"` is still candidate three. */
const AssessmentOutputSchema = z.object({
  selected: z.array(z.union([z.number(), z.string()])),
  note: z.string().nullish(),
});

/** How a candidate reached the pool, which is also the pack bucket it serves in. */
export type AssessmentOutcome =
  | {
      readonly kind: 'selected';
      readonly ids: readonly string[];
      readonly unknown: number;
      readonly note?: string;
    }
  | { readonly kind: 'failed'; readonly reason: Degradation['reason']; readonly error?: unknown };

/**
 * The model's numbers, as real candidate ids, in its order. A number that names no candidate is
 * counted and dropped. A list that named candidates and matched none is not a selection at all,
 * so it reads as unusable output rather than as an empty choice.
 */
export function readSelection(pool: AssessmentPool, answer: unknown): AssessmentOutcome {
  const parsed = AssessmentOutputSchema.safeParse(answer);
  if (!parsed.success) {
    return { kind: 'failed', reason: 'invalid_output' };
  }
  const ids: string[] = [];
  let unknown = 0;
  for (const raw of parsed.data.selected) {
    const number = Number(String(raw).trim().replace(/^#/, ''));
    const entry = Number.isInteger(number) ? pool.entries[number - 1] : undefined;
    if (entry === undefined) {
      unknown += 1;
      continue;
    }
    if (!ids.includes(entry.item.id)) {
      ids.push(entry.item.id);
    }
  }
  if (ids.length === 0 && unknown > 0) {
    return { kind: 'failed', reason: 'invalid_output' };
  }
  const note = parsed.data.note?.trim();
  return {
    kind: 'selected',
    ids,
    unknown,
    ...(note === undefined || note === '' ? {} : { note }),
  };
}

export type AssessmentDeps = {
  readonly provider: Provider;
  /** `config.recall.cueBudgetMs`: the hang guard recall's one model call already runs under. */
  readonly budgetMs: number;
  readonly logger: Logger;
};

/**
 * The one call. Nothing is held while it runs: the publication guard is taken only at the commit
 * that follows, so a slow answer delays this recall and nobody else's write.
 */
export async function assessCandidates(
  deps: AssessmentDeps,
  input: AssessmentQuery,
  pool: AssessmentPool,
  view: ResolvedEvidenceView,
): Promise<AssessmentOutcome> {
  if (pool.entries.length === 0) {
    // Nothing to judge, so nothing is asked: the pack is empty for the reason it was always empty.
    return { kind: 'selected', ids: [], unknown: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.budgetMs);
  let answer: unknown;
  try {
    answer = await deps.provider.generate({
      surface: RECALL_ASSESSMENT_SURFACE,
      // The backend names its own model; this is what a request is required to carry.
      model: deps.provider.route?.model ?? 'unrouted',
      messages: buildAssessmentMessages(input, pool, view),
      schema: ASSESSMENT_JSON_SCHEMA,
      maxTokens: ASSESSMENT_MAX_TOKENS,
      temperature: 0,
      think: false,
      signal: controller.signal,
    });
  } catch (error) {
    if (isGenerationUnavailable(error)) {
      deps.logger.debug({ reason: 'unavailable' }, 'recall assessment unavailable');
      return { kind: 'failed', reason: 'unavailable', error };
    }
    const reason = isAbortError(error) ? 'timeout' : 'model_error';
    deps.logger.warn(
      { err: error, reason, route: deps.provider.route },
      'recall assessment failed',
    );
    return { kind: 'failed', reason, error };
  } finally {
    clearTimeout(timer);
  }
  const outcome = readSelection(pool, answer);
  if (outcome.kind === 'failed') {
    deps.logger.warn({ route: deps.provider.route }, 'recall assessment answer was unusable');
  }
  return outcome;
}

/**
 * An item the floors refused, served because the model chose it. Its admission says so, and lists
 * what retrieval measured, so the pack never presents it as having cleared a floor it did not.
 */
function selectedOverFloor(item: FusedItem): FusedItem {
  const measured = [...new Set((item.evidence ?? []).map(describeMeasurement))];
  return {
    ...item,
    admittedBy: {
      rule: 'assessment',
      score: 0,
      qualifying: measured.length === 0 ? ['no query measurement'] : measured,
    },
  };
}

export type AssessedServing = {
  readonly assembly: ServingAssembly;
  readonly report: AssessmentReport;
  /** Ids the model was shown, which the recall's telemetry counts as offered. */
  readonly shown: readonly string[];
  /** Ids the model chose, which the pack serves; empty for a failed call. */
  readonly chosen: readonly string[];
  /** Every candidate the pack may hold, for the effects that record what it served. */
  readonly candidates: ReadonlyMap<string, FusedItem>;
  readonly degradation?: Degradation;
};

/**
 * What gets served for one outcome. A selection becomes an assembly of exactly those memories in
 * the model's order; the restatement filter is off there, because whether a Goal that says the
 * query back is worth reading is the judgment the model was asked for. A failure is the ranking
 * assembly the path would have served anyway, marked degraded.
 */
export function assessedServing(input: {
  readonly outcome: AssessmentOutcome;
  readonly pool: AssessmentPool;
  readonly ranking: ServingAssembly;
  readonly candidates: ReadonlyMap<string, FusedItem>;
  readonly admitted: ReadonlySet<string>;
  readonly route: Provider['route'];
}): AssessedServing {
  const { outcome, pool, ranking } = input;
  const shown = pool.entries.map((entry) => entry.item.id);
  const base = {
    shown: pool.entries.length,
    omitted: pool.omitted,
    ...(input.route === undefined ? {} : { provider: input.route.provider }),
    ...(input.route?.model === undefined ? {} : { model: input.route.model }),
  };
  if (outcome.kind === 'failed') {
    const degradation: Degradation = { stage: 'assessment', reason: outcome.reason };
    const report: AssessmentReport = { ...base, outcome: 'fallback', selected: 0 };
    return {
      assembly: {
        ...ranking,
        assembly: {
          ...ranking.assembly,
          degraded: [...(ranking.assembly.degraded ?? []), degradation],
          assessment: report,
        },
      },
      report,
      shown,
      chosen: [],
      candidates: input.candidates,
      degradation,
    };
  }
  const byId = new Map(pool.entries.map((entry) => [entry.item.id, entry]));
  const chosen: PoolEntry[] = [];
  for (const id of outcome.ids) {
    const entry = byId.get(id);
    if (entry !== undefined) {
      const item = input.admitted.has(id) ? entry.item : selectedOverFloor(entry.item);
      chosen.push({ item, population: entry.population });
    }
  }
  const of = (population: Population): FusedItem[] =>
    chosen.filter((entry) => entry.population === population).map((entry) => entry.item);
  const report: AssessmentReport = {
    ...base,
    outcome: 'selected',
    selected: chosen.length,
    ...(outcome.unknown === 0 ? {} : { unknown: outcome.unknown }),
    ...(outcome.note === undefined ? {} : { note: outcome.note.slice(0, MAX_ASSESSOR_NOTE_CHARS) }),
  };
  const candidates = new Map(input.candidates);
  for (const item of [...chosen.map((entry) => entry.item), ...pool.withheld]) {
    candidates.set(item.id, item);
  }
  return {
    assembly: {
      ...ranking,
      ranked: [...chosen.map((entry) => entry.item), ...pool.withheld],
      assembly: {
        ...ranking.assembly,
        items: of('found'),
        resonant: of('associated'),
        intentions: of('reminder'),
        order: chosen.map((entry) => entry.item.id),
        restating: new Set<string>(),
        assessment: report,
      },
    },
    report,
    shown,
    chosen: chosen.map((entry) => entry.item.id),
    candidates,
  };
}

/** One recall's assessment: what the model was shown and what it answered. */
export type AssessmentRun = { readonly pool: AssessmentPool; readonly outcome: AssessmentOutcome };

/**
 * The `assess` mode's model call, timed, or nothing in the other two modes. The pool is built
 * here and the call made; everything it reads was read by the stages before it.
 */
export async function runAssessment(
  deps: Pick<AssessmentDeps, 'provider' | 'logger'> & { readonly config: Config },
  input: {
    readonly query: AssessmentQuery;
    readonly found: readonly FusedItem[];
    readonly associated: readonly FusedItem[];
    readonly reminders: readonly FusedItem[];
    readonly serving: Pick<ServingAssembly, 'served' | 'dedup'>;
    readonly view: ResolvedEvidenceView;
    readonly unreached: number;
  },
): Promise<{ readonly run: AssessmentRun; readonly ms: number } | undefined> {
  if (deps.config.recall.mode !== 'assess') {
    return undefined;
  }
  const started = performance.now();
  const pool = assessmentPool({ ...input, caps: capsFor(deps.config) });
  const call = { ...deps, budgetMs: deps.config.recall.cueBudgetMs };
  const outcome = await assessCandidates(call, input.query, pool, input.view);
  return { run: { pool, outcome }, ms: roundMs(performance.now() - started) };
}

/**
 * The floors' refusals the assessment may be shown, and how many more it may not: none outside the
 * `assess` mode. One the run already holds another way (a triggered intention, say) is left to
 * that way, so it keeps its own bucket and rationale.
 */
export function assessmentReach(
  config: Config,
  refused: readonly FusedItem[],
  held: ReadonlyMap<string, FusedItem>,
): { readonly items: readonly FusedItem[]; readonly beyond: number } {
  if (config.recall.mode !== 'assess') {
    return { items: [], beyond: 0 };
  }
  const open = refused.filter((item) => !held.has(item.id));
  const items = open.slice(0, candidateBudget(capsFor(config)));
  return { items, beyond: open.length - items.length };
}

/** What a finished run serves, over the ranking assembly the path built anyway. */
export function assessedFor(
  run: AssessmentRun | undefined,
  input: {
    readonly ranking: ServingAssembly;
    readonly candidates: ReadonlyMap<string, FusedItem>;
    readonly route: Provider['route'];
  },
): AssessedServing | undefined {
  if (run === undefined) {
    return undefined;
  }
  return assessedServing({ ...run, ...input, admitted: new Set(input.candidates.keys()) });
}

/**
 * The ranking assembly, served because the evidence a selection was made on moved before it could
 * be recorded. The selection is dropped rather than re-served under a reading it never saw; a
 * failed call keeps its own report, since there was no selection to drop.
 */
export function withoutAssessment(
  ranking: ServingAssembly,
  assessed: AssessedServing | undefined,
): ServingAssembly {
  if (assessed === undefined) {
    return ranking;
  }
  if (assessed.report.outcome !== 'selected') {
    return assessed.assembly;
  }
  // The note and the unknown count describe a selection that is not served, so they go with it.
  const { report } = assessed;
  const discarded: AssessmentReport = {
    outcome: 'discarded',
    shown: report.shown,
    omitted: report.omitted,
    selected: 0,
    ...(report.provider === undefined ? {} : { provider: report.provider }),
    ...(report.model === undefined ? {} : { model: report.model }),
  };
  return { ...ranking, assembly: { ...ranking.assembly, assessment: discarded } };
}
