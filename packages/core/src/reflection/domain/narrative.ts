import { z } from 'zod';
import type { ChatMessage, JsonSchema } from '../../infrastructure/providers/types.js';
import { hashContent } from './content.js';

/**
 * Whitepaper §6.10, with this build's pinned trigger: a session's close — the MCP transport
 * ending, or 30 minutes of silence — is the boundary that warrants a narrative. Everything
 * here is pure, so the boundary rule, the versioning rule, and the identity of an episode
 * set are all assertable without a graph.
 */

/** The only scope P3 produces. Day and week scopes are maintenance operations (P5). */
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
 * Derived from the session and the episode set, never minted: a crash between the node write
 * and the supersession leaves the retry writing the same id, so `MERGE` matches instead of
 * forking a second narrative for one boundary.
 */
export function narrativeNodeId(sessionId: string, key: string): string {
  return hashContent(['narrative', sessionId, key]);
}

/** Silence since the last thing the substrate heard from the session. */
export function isSessionIdle(lastActivityAt: Date, now: Date, idleMs: number): boolean {
  return now.getTime() - lastActivityAt.getTime() >= idleMs;
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
 * one that covers fewer — every case of it is an episode forgotten after the fact — leaves
 * the standing narrative alone rather than regressing it.
 */
export function decideSessionNarrative(
  episodes: readonly NarrativeEpisode[],
  existing: readonly ExistingNarrative[],
): NarrativeDecision {
  const episodeIds = episodes.map((episode) => episode.id);
  const key = coverageKey(episodeIds);
  const open = openVersions(existing);
  const highestVersion = existing.reduce((top, narrative) => Math.max(top, narrative.version), 0);

  if (episodes.length === 0) {
    return skip('the session holds no episodes', key, highestVersion, episodeIds, []);
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

  const standing = open[0];
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

export type NarrativeSource = {
  readonly text: string;
  readonly renderedCount: number;
  /** Fraction of the covered episodes the model actually saw. */
  readonly coverage: number;
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function renderEpisode(episode: NarrativeEpisode, maxChars: number): string {
  const body = episode.summary ?? episode.text;
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  const when = episode.occurredAt === undefined ? '' : ` (${episode.occurredAt.toISOString()})`;
  return `episode${when}:\n${clipped}`;
}

/**
 * The compression input. A long session is rendered from its most recent episodes rather
 * than truncated mid-history, and the ratio it saw is recorded as the narrative's coverage
 * score — the node then says how much of what it claims to cover actually reached the model.
 * Clipping is a byte slice, not term selection: nothing here decides what an episode means.
 */
export function renderNarrativeSource(
  episodes: readonly NarrativeEpisode[],
  maxEpisodes: number,
  maxEpisodeChars: number,
): NarrativeSource {
  const rendered = episodes.slice(Math.max(0, episodes.length - maxEpisodes));
  return {
    text: rendered.map((episode) => renderEpisode(episode, maxEpisodeChars)).join('\n\n'),
    renderedCount: rendered.length,
    coverage: episodes.length === 0 ? 0 : round(rendered.length / episodes.length),
  };
}

export const NARRATIVE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    narrative: { type: 'string' },
  },
  required: ['summary', 'narrative'],
};

export const NarrativeOutputSchema = z.object({
  summary: z.string().min(1),
  narrative: z.string().min(1),
});

export type NarrativeOutput = z.infer<typeof NarrativeOutputSchema>;

const NARRATIVE_SYSTEM_PROMPT = [
  "You compress an AI coding agent's work session into one durable memory.",
  'The input is the session\'s episodes in the order they happened.',
  'Ground every sentence in the episodes: name the work, the decisions, and the outcomes they record, and add nothing they do not state.',
  'Write "summary" as one sentence naming what the session was about.',
  'Write "narrative" as a single past-tense paragraph of at most eight sentences covering the arc of the session.',
].join(' ');

export function buildNarrativeMessages(source: string): ChatMessage[] {
  return [
    { role: 'system', content: NARRATIVE_SYSTEM_PROMPT },
    { role: 'user', content: `Session:\n${source}` },
  ];
}
