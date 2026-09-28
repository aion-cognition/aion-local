import type { RecallTurn } from '@aion/protocol';

import { servable, type ServingAssembly } from './serving-assembly.js';
import type { ChatMessage } from '../../infrastructure/providers/types.js';
import { RECALL_ASSESSMENT_PROMPT } from '../../prompts/recall-assessment.js';
import type { FusedItem } from '../domain/fusion.js';
import { kindOf, type BucketCaps } from '../domain/pack-buckets.js';
import { renderCandidate, toPackItem } from '../domain/pack-item.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';

/**
 * What the recall assessment is shown, and how: the candidate pool retrieval's ranking fills, and
 * the prompt input rendered from it. Split out of `assessment.ts` at the line cap; the call, the
 * reading of its answer and what gets served stay there.
 */

/**
 * The most of one memory's text the model is shown. The cut is marked with what it left out, so
 * a long episode reads as long rather than as short, and it keeps one transcript from spending
 * the call's input on itself alone.
 */
export const MAX_CANDIDATE_CHARS = 800;

export type Population = 'found' | 'associated' | 'reminder';

export type PoolEntry = { readonly item: FusedItem; readonly population: Population };

export type AssessmentPool = {
  /** What the model is shown, numbered from one in this order. */
  readonly entries: readonly PoolEntry[];
  /** Candidates retrieval found that the pack caps kept out of view. */
  readonly omitted: number;
  /**
   * What the session already holds or wrote itself, kept out of view because the pack would
   * withhold it anyway. Serving still reads it, so the pack says what it withheld and the session's
   * holdings stay current, as they do on the ranking path.
   */
  readonly withheld: readonly FusedItem[];
};

/** The call's inputs as the caller supplied them, already redacted. */
export type AssessmentQuery = {
  readonly query: string;
  readonly summary?: string;
  readonly recentTurns?: readonly RecallTurn[];
};

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
  /** Floor refusals past the reach the evidence was read for, counted as omitted. */
  readonly unreached?: number;
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
  const withheld = [...found, ...associated, ...reminders].filter(
    (item) => open.suppressedOwn.has(item.id) || open.suppressed.has(item.id),
  );
  return {
    entries,
    omitted: servableCount - entries.length + (input.unreached ?? 0),
    withheld,
  };
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
