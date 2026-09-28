import type { AssessmentReport, Degradation, RecallTurn } from '@aion/protocol';
import { z } from 'zod';

import { capsFor } from './recall-policy.js';
import { servable, type ServingAssembly } from './serving-assembly.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { isAbortError } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { isGenerationUnavailable } from '../../infrastructure/providers/errors.js';
import type { ChatMessage, JsonSchema, Provider } from '../../infrastructure/providers/types.js';
import { RECALL_ASSESSMENT_PROMPT } from '../../prompts/recall-assessment.js';
import { describeMeasurement } from '../domain/admission.js';
import type { FusedItem } from '../domain/fusion.js';
import { kindOf, type BucketCaps } from '../domain/pack-buckets.js';
import { renderCandidate, toPackItem } from '../domain/pack-item.js';
import { MAX_ASSESSOR_NOTE_CHARS } from '../domain/pack-notes.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';

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

/**
 * The most of one memory's text the model is shown. The cut is marked with what it left out, so
 * a long episode reads as long rather than as short, and it keeps one transcript from spending
 * the call's input on itself alone.
 */
export const MAX_CANDIDATE_CHARS = 800;

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
export type Population = 'found' | 'associated' | 'reminder';

export type PoolEntry = { readonly item: FusedItem; readonly population: Population };

export type AssessmentPool = {
  /** What the model is shown, numbered from one in this order. */
  readonly entries: readonly PoolEntry[];
  /** Servable candidates the pack caps kept out of view. */
  readonly omitted: number;
};

/** The call's inputs as the caller supplied them, already redacted. */
export type AssessmentQuery = {
  readonly query: string;
  readonly summary?: string;
  readonly recentTurns?: readonly RecallTurn[];
};

export type AssessmentOutcome =
  | {
      readonly kind: 'selected';
      readonly ids: readonly string[];
      readonly unknown: number;
      readonly note?: string;
    }
  | { readonly kind: 'failed'; readonly reason: Degradation['reason']; readonly error?: unknown };

/**
 * How many candidates one call may be shown: every slot the pack has. It is the retrieval limit
 * the ranking path already serves under, so the model sees as many memories as a pack could hold
 * and no second capacity rule appears.
 */
export function candidateBudget(caps: BucketCaps): number {
  return Object.values(caps).reduce((sum, cap) => sum + cap, 0);
}

/**
 * What the model is shown, in the order it is shown. Retrieval's ranking decides only who fits:
 * the admitted candidates, then what the floors refused, each best first, then the associations
 * and the triggered reminders, which keep their own slots so a long list of direct finds never
 * crowds them out. A memory the pack would withhold anyway is left out rather than wasted on.
 */
export function assessmentPool(input: {
  readonly found: readonly FusedItem[];
  readonly associated: readonly FusedItem[];
  readonly reminders: readonly FusedItem[];
  readonly serving: Pick<ServingAssembly, 'served' | 'dedup'>;
  readonly view: ResolvedEvidenceView;
  readonly caps: BucketCaps;
}): AssessmentPool {
  const seen = new Set<string>();
  const unique = (items: readonly FusedItem[]): FusedItem[] =>
    items.filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    });
  const found = unique(input.found);
  const associated = unique(input.associated);
  const reminders = unique(input.reminders);
  const open = servable(
    { ranked: [...found, ...associated, ...reminders], ...input.serving },
    input.view,
  );
  const allowed = (item: FusedItem): boolean =>
    open.selected.includes(item) &&
    !open.suppressedOwn.has(item.id) &&
    !open.suppressed.has(item.id);
  const shownReminders = reminders.filter(allowed).slice(0, input.caps.intentions);
  const shownAssociated = associated.filter(allowed).slice(0, input.caps.resonant);
  const room = Math.max(
    0,
    candidateBudget(input.caps) - shownReminders.length - shownAssociated.length,
  );
  const allowedFound = found.filter(allowed);
  const shownFound = allowedFound.slice(0, room);
  const entries: PoolEntry[] = [
    ...shownFound.map((item) => ({ item, population: 'found' as const })),
    ...shownAssociated.map((item) => ({ item, population: 'associated' as const })),
    ...shownReminders.map((item) => ({ item, population: 'reminder' as const })),
  ];
  const servableCount =
    allowedFound.length + associated.filter(allowed).length + reminders.filter(allowed).length;
  return { entries, omitted: servableCount - entries.length };
}

function excerpt(content: string): string {
  if (content.length <= MAX_CANDIDATE_CHARS) {
    return content;
  }
  const rest = content.length - MAX_CANDIDATE_CHARS;
  return `${content.slice(0, MAX_CANDIDATE_CHARS)} [... ${String(rest)} more characters]`;
}

const SECTION_HEADINGS: Readonly<Record<Population, string>> = {
  found: 'Candidates retrieval found for the query:',
  associated: "Candidates associated with the situation rather than the query's words:",
  reminder: 'Standing intentions this situation triggered:',
};

function candidateLines(pool: AssessmentPool, view: ResolvedEvidenceView): string {
  const numbers = new Map(pool.entries.map((entry, index) => [entry.item.id, index + 1]));
  const sections: string[] = [];
  let current: Population | undefined;
  let lines: string[] = [];
  pool.entries.forEach((entry, index) => {
    if (entry.population !== current) {
      if (current !== undefined) {
        sections.push([SECTION_HEADINGS[current], ...lines].join('\n'));
      }
      current = entry.population;
      lines = [];
    }
    const { item } = entry;
    const provenance = view.provenance.get(item.id);
    const relatedClaim = view.relatedClaims.get(item.id);
    const packItem = toPackItem({ ...item, content: excerpt(item.content) }, index + 1, {
      ...(provenance === undefined ? {} : { provenance }),
      ...(relatedClaim === undefined ? {} : { relatedClaim }),
    });
    lines.push(renderCandidate(packItem, kindOf(item.labels), (id) => numbers.get(id)));
  });
  if (current !== undefined) {
    sections.push([SECTION_HEADINGS[current], ...lines].join('\n'));
  }
  if (pool.omitted > 0) {
    sections.push(
      `(${String(pool.omitted)} further candidate(s) retrieval found are not shown, for space.)`,
    );
  }
  return sections.join('\n\n');
}

export function buildAssessmentMessages(
  input: AssessmentQuery,
  pool: AssessmentPool,
  view: ResolvedEvidenceView,
): ChatMessage[] {
  const summary = input.summary?.trim();
  const turns = input.recentTurns ?? [];
  const sections = [
    `Query:\n${input.query.trim()}`,
    `Conversation summary:\n${summary === undefined || summary === '' ? '(none provided)' : summary}`,
    `Recent turns:\n${
      turns.length === 0
        ? '(none provided)'
        : turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n')
    }`,
    candidateLines(pool, view),
  ];
  return [
    { role: 'system', content: RECALL_ASSESSMENT_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

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
  for (const entry of chosen) {
    candidates.set(entry.item.id, entry.item);
  }
  return {
    assembly: {
      ...ranking,
      ranked: chosen.map((entry) => entry.item),
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
    candidates,
  };
}

/**
 * The assessment for one recall: the pool, then the call. Everything it reads was already read by
 * the stages before it, so the only new cost is the model call itself.
 */
export type AssessmentRun = { readonly pool: AssessmentPool; readonly outcome: AssessmentOutcome };

export async function runAssessment(
  deps: Pick<AssessmentDeps, 'provider' | 'logger'> & { readonly config: Config },
  input: {
    readonly query: AssessmentQuery;
    readonly found: readonly FusedItem[];
    readonly associated: readonly FusedItem[];
    readonly reminders: readonly FusedItem[];
    readonly serving: Pick<ServingAssembly, 'served' | 'dedup'>;
    readonly view: ResolvedEvidenceView;
  },
): Promise<AssessmentRun> {
  const pool = assessmentPool({ ...input, caps: capsFor(deps.config) });
  const call = { ...deps, budgetMs: deps.config.recall.cueBudgetMs };
  return { pool, outcome: await assessCandidates(call, input.query, pool, input.view) };
}

/** The floors' refusals the assessment may be shown: none outside the `assess` mode. */
export function assessmentReach(
  config: Config,
  refused: readonly FusedItem[],
): readonly FusedItem[] {
  if (config.recall.mode !== 'assess') {
    return [];
  }
  return refused.slice(0, candidateBudget(capsFor(config)));
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
  return {
    ...ranking,
    assembly: {
      ...ranking.assembly,
      assessment: { ...assessed.report, outcome: 'discarded', selected: 0 },
    },
  };
}
