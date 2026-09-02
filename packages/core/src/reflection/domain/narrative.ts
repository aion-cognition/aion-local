import { z } from 'zod';

import { hashContent } from './content.js';
import type { ChatMessage, JsonSchema } from '../../infrastructure/providers/types.js';

/**
 * Three boundaries warrant a session narrative: the close (the MCP transport ending), silence
 * past the idle window, and a mid-session boundary, whose rule lives in `mid-session.ts` and
 * calls `isSessionIdle` here as one of its arms. Everything here is pure, so the boundary rule,
 * the versioning rule, and the identity of an episode set are all assertable without a graph.
 */

/** The only scope produced here. Day and week scopes belong to maintenance operations. */
export const SESSION_NARRATIVE_SCOPE = 'session';

export type NarrativeEpisode = {
  readonly id: string;
  readonly text: string;
  readonly summary?: string;
  readonly occurredAt?: Date;
  readonly writtenAt?: Date;
};

export type ExistingNarrative = {
  readonly id: string;
  readonly version: number;
  readonly coverageKey: string;
  readonly coverageCount: number;
  readonly open: boolean;
};

/**
 * The identity of an episode set: sorted and deduplicated first, so the same episodes hash
 * the same however the read returned them. This is the operation's idempotency key, and it
 * lives on the node it produced rather than in a ledger, which is what lets a re-close read
 * the answer out of the graph it is about to write to.
 */
export function coverageKey(episodeIds: readonly string[]): string {
  return hashContent([...new Set(episodeIds)].sort());
}

/**
 * The revision of the grounding rule a narrative was written under, stored on the node and
 * folded into a regenerated narrative's id. Two jobs, one value: the cleanup selects the
 * narratives that predate it, and the id it derives cannot collide with the node it is
 * superseding. Bump it when a change to the rule warrants rewriting what already stands.
 */
export const NARRATIVE_GROUNDING = 'grounded-1';

/**
 * Derived from the session and the episode set, never minted: a crash between the node write
 * and the supersession leaves the retry writing the same id, so `MERGE` matches instead of
 * forking a second narrative for one boundary.
 */
export function narrativeNodeId(sessionId: string, key: string, generation = ''): string {
  const parts = generation === '' ? [] : [generation];
  return hashContent(['narrative', sessionId, key, ...parts]);
}

/** Silence since the last thing the substrate heard from the session. */
export function isSessionIdle(lastHeardAt: Date, now: Date, idleMs: number): boolean {
  return now.getTime() - lastHeardAt.getTime() >= idleMs;
}

/**
 * When the substrate last heard from the session, which is what idleness is measured
 * against. System time leads, because `occurred_at` is the caller's claim and a backdated
 * payload would otherwise read as a session that went quiet hours ago.
 */
export function lastActivityAt(episodes: readonly NarrativeEpisode[]): Date | undefined {
  let latest: Date | undefined;
  for (const episode of episodes) {
    const stamp = episode.writtenAt ?? episode.occurredAt;
    if (stamp !== undefined && (latest === undefined || stamp > latest)) {
      latest = stamp;
    }
  }
  return latest;
}

export type NarrativeSpan = {
  readonly start?: Date;
  readonly end?: Date;
};

/** World time, not system time: the period the narrative claims to be about. */
export function narrativeSpan(episodes: readonly NarrativeEpisode[]): NarrativeSpan {
  const stamps = episodes
    .map((episode) => episode.occurredAt)
    .filter((stamp): stamp is Date => stamp !== undefined)
    .sort((left, right) => left.getTime() - right.getTime());
  return { start: stamps[0], end: stamps[stamps.length - 1] };
}

export type NarrativeDecision = {
  readonly action: 'create' | 'skip';
  readonly reason: string;
  readonly coverageKey: string;
  readonly version: number;
  readonly episodeIds: readonly string[];
  /**
   * Open versions this run closes. On a create they are the predecessors; on a skip they are
   * the stragglers a crash left open beside the matching version, which is the one repair
   * this decision performs.
   */
  readonly supersedes: readonly string[];
};

function openVersions(existing: readonly ExistingNarrative[]): readonly ExistingNarrative[] {
  return existing.filter((narrative) => narrative.open);
}

function skip(
  reason: string,
  key: string,
  version: number,
  episodeIds: readonly string[],
  supersedes: readonly string[],
): NarrativeDecision {
  return { action: 'skip', reason, coverageKey: key, version, episodeIds, supersedes };
}

/**
 * The versioning rule: a close that covers more episodes than the standing narrative mints
 * version n+1 and supersedes n, so the lineage of what the session was understood to be is
 * preserved rather than overwritten. A close that covers the same set writes nothing, and
 * one that covers fewer (every case of it is an episode forgotten after the fact) leaves
 * the standing narrative alone rather than regressing it.
 */
export type NarrativeDecisionOptions = {
  /**
   * Rewrites the standing narrative over the same episode set. Only the cleanup path sets it:
   * an ordinary close must stay a no-op when nothing new arrived.
   */
  readonly regenerate?: boolean;
};

export function decideSessionNarrative(
  episodes: readonly NarrativeEpisode[],
  existing: readonly ExistingNarrative[],
  options: NarrativeDecisionOptions = {},
): NarrativeDecision {
  const episodeIds = episodes.map((episode) => episode.id);
  const key = coverageKey(episodeIds);
  const open = openVersions(existing);
  const highestVersion = existing.reduce((top, narrative) => Math.max(top, narrative.version), 0);

  if (episodes.length === 0) {
    return skip('the session holds no episodes', key, highestVersion, episodeIds, []);
  }

  if (options.regenerate === true) {
    return {
      action: 'create',
      reason: `regenerated over ${String(episodes.length)} episodes`,
      coverageKey: key,
      version: highestVersion + 1,
      episodeIds,
      supersedes: open.map((narrative) => narrative.id),
    };
  }

  const matching = existing.find((narrative) => narrative.coverageKey === key);
  if (matching !== undefined) {
    const stragglers = open
      .filter((narrative) => narrative.id !== matching.id)
      .map((narrative) => narrative.id);
    const reason = matching.open
      ? `version ${String(matching.version)} already covers these ${String(episodes.length)} episodes`
      : `these ${String(episodes.length)} episodes were superseded by a later version`;
    return skip(reason, key, matching.version, episodeIds, matching.open ? stragglers : []);
  }

  // The highest open version, picked here rather than taken from the read's order: a caller
  // whose Cypher loses its ORDER BY would otherwise judge this close against an older version.
  const standing = open.reduce<ExistingNarrative | undefined>(
    (top, narrative) => (top === undefined || narrative.version > top.version ? narrative : top),
    undefined,
  );
  if (standing !== undefined && episodes.length <= standing.coverageCount) {
    return skip(
      `version ${String(standing.version)} covers ${String(standing.coverageCount)} episodes, this close ${String(episodes.length)}`,
      key,
      standing.version,
      episodeIds,
      [],
    );
  }

  return {
    action: 'create',
    reason:
      standing === undefined
        ? `first narrative for ${String(episodes.length)} episodes`
        : `${String(episodes.length)} episodes, up from ${String(standing.coverageCount)}`,
    coverageKey: key,
    version: highestVersion + 1,
    episodeIds,
    supersedes: open.map((narrative) => narrative.id),
  };
}

/** A node the narrative may cite: the episode itself, or something extracted from it. */
export type NarrativeSourceNode = {
  readonly id: string;
  /** How the prompt names the node, lowercased: `episode`, `decision`, `insight`. */
  readonly kind: string;
  readonly text: string;
  readonly occurredAt?: Date;
};

/** An extracted node carries the episode it came from, which is what orders it in the prompt. */
export type NarrativeExtractedNode = NarrativeSourceNode & {
  readonly episodeId: string;
};

/** The tag the model cites, paired with the graph id that tag resolves to. */
export type NarrativeSourceItem = NarrativeSourceNode & {
  readonly handle: string;
};

export type NarrativeSource = {
  readonly text: string;
  readonly items: readonly NarrativeSourceItem[];
  readonly renderedCount: number;
  /** Fraction of the covered episodes the model actually saw. */
  readonly coverage: number;
  /** How many sentences the source can support, which is also what assembly enforces. */
  readonly sentenceBudget: number;
};

/**
 * A ceiling, not a target. Eight sentences over one thin episode is how a length quota gets
 * filled with invention.
 */
export const NARRATIVE_MAX_SENTENCES = 6;

/** Source characters that earn one sentence. Below one sentence's worth, the answer is one. */
const CHARS_PER_SENTENCE = 150;

/**
 * Header plus per-sentence JSON, so a thin session cannot be padded to the ceiling. The
 * per-sentence allowance covers the citation envelope as well as the sentence: a truncated
 * answer is unparseable JSON, not a shorter narrative.
 */
const NARRATIVE_BASE_TOKENS = 160;
const NARRATIVE_TOKENS_PER_SENTENCE = 150;
const NARRATIVE_MAX_TOKENS_CEILING = 1_200;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Shared with the consolidation engine, which renders its members the same way. */
export function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Header and content on separate lines. Run together, a thin item's whole line reads as a
 * sentence and the model copies the header with it into the stored narrative.
 */
export function renderItem(item: NarrativeSourceItem): string {
  const when = item.occurredAt === undefined ? '' : ` ${item.occurredAt.toISOString()}`;
  return `[${item.handle}] ${item.kind}${when}\n${item.text}`;
}

/**
 * Length scales with the source: the budget is what the rendered items can support, capped,
 * and one sentence is the floor. A session of one short observation is one sentence.
 */
export function narrativeSentenceBudget(items: readonly NarrativeSourceItem[]): number {
  const chars = items.reduce((total, item) => total + item.text.length, 0);
  const bySize = Math.floor(chars / CHARS_PER_SENTENCE);
  return Math.max(1, Math.min(NARRATIVE_MAX_SENTENCES, items.length, bySize));
}

export function narrativeMaxTokens(sentenceBudget: number): number {
  return Math.min(
    NARRATIVE_MAX_TOKENS_CEILING,
    NARRATIVE_BASE_TOKENS + sentenceBudget * NARRATIVE_TOKENS_PER_SENTENCE,
  );
}

/**
 * The compression input. A long session is rendered from its most recent episodes rather
 * than truncated mid-history, and the ratio it saw is recorded as the narrative's coverage
 * score, so the node says how much of what it claims to cover actually reached the model.
 * Every item carries a tag the answer must cite, and an extracted node follows the episode it
 * came from so the model reads the session as an arc rather than two lists. Clipping is a
 * byte slice, not term selection: nothing here decides what an episode means.
 */
export function renderNarrativeSource(
  episodes: readonly NarrativeEpisode[],
  extracted: readonly NarrativeExtractedNode[],
  maxEpisodes: number,
  maxEpisodeChars: number,
): NarrativeSource {
  const rendered = episodes.slice(Math.max(0, episodes.length - maxEpisodes));
  const items: NarrativeSourceItem[] = [];

  for (const episode of rendered) {
    items.push({
      handle: `S${String(items.length + 1)}`,
      id: episode.id,
      kind: 'episode',
      text: clip(episode.summary ?? episode.text, maxEpisodeChars),
      ...(episode.occurredAt === undefined ? {} : { occurredAt: episode.occurredAt }),
    });
    for (const node of extracted.filter((candidate) => candidate.episodeId === episode.id)) {
      items.push({
        handle: `S${String(items.length + 1)}`,
        id: node.id,
        kind: node.kind,
        text: clip(node.text, maxEpisodeChars),
      });
    }
  }

  return {
    text: items.map(renderItem).join('\n\n'),
    items,
    renderedCount: rendered.length,
    coverage: episodes.length === 0 ? 0 : round(rendered.length / episodes.length),
    sentenceBudget: narrativeSentenceBudget(items),
  };
}

export const NARRATIVE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          source_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'source_ids'],
      },
    },
  },
  required: ['sentences'],
};

export const NarrativeOutputSchema = z.object({
  sentences: z.array(
    z.object({
      text: z.string(),
      source_ids: z.array(z.string()),
    }),
  ),
});

export type NarrativeOutput = z.infer<typeof NarrativeOutputSchema>;

export type GroundedNarrative = {
  /** The first grounded sentence, so the one line every pack shows is itself cited. */
  readonly summary: string;
  readonly narrative: string;
  /** Graph ids of the cited nodes, in the order they were first cited. */
  readonly citations: readonly string[];
  readonly kept: number;
  readonly dropped: number;
};

/**
 * Reading the tag back out of the answer, not judging its content: a model that writes `[s1]`
 * or `S1.` cited S1, and only the tag's identity is at stake here.
 */
function normalizeHandle(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function resolveCitations(raw: readonly string[], byHandle: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const value of raw) {
    const id = byHandle.get(normalizeHandle(value));
    if (id !== undefined && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The graph ids one sentence's tags resolve to, in the order the model wrote them, with
 * anything the prompt never offered dropped. The consolidation engine keeps citations per
 * sentence rather than per node, because its reviewer checks a sentence against the items that
 * sentence cited.
 */
export function citedSourceIds(raw: readonly string[], source: NarrativeSource): readonly string[] {
  return resolveCitations(raw, new Map(source.items.map((item) => [item.handle, item.id])));
}

/** One kept sentence and the graph ids it cited, which is what a per-sentence review reads. */
export type GroundedSentence = {
  readonly text: string;
  /** Never empty: a sentence citing nothing the prompt offered is dropped. */
  readonly citations: readonly string[];
};

export type GroundedSentences = {
  readonly sentences: readonly GroundedSentence[];
  /** Every cited id, in the order it was first cited. */
  readonly citations: readonly string[];
  readonly dropped: number;
};

/**
 * The grounding rule, enforced rather than requested: a sentence citing no source item the
 * prompt actually supplied never reaches the node, and the budget caps what a model that
 * ignored it can still store. Both axes filter here; what differs is the shape each one stores,
 * which is the caller's to fold.
 */
export function groundSentences(
  output: NarrativeOutput,
  source: NarrativeSource,
): GroundedSentences {
  const byHandle = new Map(source.items.map((item) => [item.handle, item.id]));
  const sentences: GroundedSentence[] = [];
  const citations: string[] = [];
  let dropped = 0;

  for (const sentence of output.sentences) {
    const text = sentence.text.trim();
    const cited = resolveCitations(sentence.source_ids, byHandle);
    if (text.length === 0 || cited.length === 0 || sentences.length >= source.sentenceBudget) {
      dropped += 1;
      continue;
    }
    sentences.push({ text, citations: cited });
    for (const id of cited) {
      if (!citations.includes(id)) {
        citations.push(id);
      }
    }
  }

  return { sentences, citations, dropped };
}

/** The session axis's flat shape: one body, one citation list. */
export function assembleNarrative(
  output: NarrativeOutput,
  source: NarrativeSource,
): GroundedNarrative {
  const grounded = groundSentences(output, source);
  const kept = grounded.sentences.map((sentence) => sentence.text);

  return {
    summary: kept[0] ?? '',
    narrative: kept.join(' '),
    citations: grounded.citations,
    kept: kept.length,
    dropped: grounded.dropped,
  };
}

/**
 * The one synthesis prompt both axes run on. The rules are identical; what a caller supplies is
 * what it is compressing and the noun its members answer to, so a change to the grounding rule
 * reaches the day rollup and the session narrative together.
 */
export function synthesisSystemPrompt(input: {
  readonly opening: string;
  readonly source: string;
  readonly noun: string;
  readonly sentenceBudget: number;
}): string {
  return [
    input.opening,
    `The input is ${input.source} in the order they happened; each starts with a header line tagged like [S1] and its content follows.`,
    `Answer with sentences. Every sentence lists in "source_ids" the tags of the ${input.noun} it draws on.`,
    `State only what the cited ${input.noun} state: never add a cause, motive, outcome, participant, quantity or judgement they do not contain.`,
    `Name the concrete work, decisions and results the ${input.noun} record, in their own wording where it is specific.`,
    'Write your own sentences; never copy a tag or a header line into one.',
    `Write at most ${String(input.sentenceBudget)} sentences, and fewer when the ${input.noun} say little.`,
    'A sentence you cannot cite is a sentence you must not write.',
  ].join(' ');
}

export function buildNarrativeMessages(source: NarrativeSource): ChatMessage[] {
  return [
    {
      role: 'system',
      content: synthesisSystemPrompt({
        opening: "You compress an AI coding agent's work session into one durable memory.",
        source: "the session's source items",
        noun: 'items',
        sentenceBudget: source.sentenceBudget,
      }),
    },
    { role: 'user', content: `Session:\n${source.text}` },
  ];
}
