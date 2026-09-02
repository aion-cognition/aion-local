import {
  isSessionIdle,
  lastActivityAt,
  type ExistingNarrative,
  type NarrativeEpisode,
} from './narrative.js';

/**
 * When a session may be narrated before anyone closes it. A session that runs for hours used to
 * be one narrative at its close and nothing at all before it, so everything recall could reach
 * mid-flight was the raw episodes.
 *
 * Two things say a stretch of work is finished enough to compress: a run of episodes the standing
 * narrative does not cover, and a pause long enough that what came before it reads as done.
 * Crossing either writes the same session narrative an early close would, and the close then
 * supersedes it through the ordinary versioning rule.
 *
 * Pure, so the rule is assertable without a graph or a clock of its own.
 */

/**
 * Uncovered episodes that make a running session worth compressing, standing in for
 * `reflection.midSessionEpisodes` (`AION_REFLECTION_MID_SESSION_EPISODES`). Twelve is under a
 * third of the source ceiling a narrative renders, so a session crossing it has enough behind it
 * to compress and enough ahead of it that the close still has something to add.
 */
export const MID_SESSION_EPISODES_DEFAULT = 12;

/**
 * Silence that reads as one stretch of work finishing, standing in for
 * `reflection.midSessionGapMinutes` (`AION_REFLECTION_MID_SESSION_GAP_MINUTES`). A third of the
 * idle window: shorter than the silence that ends a session, longer than a pause for a build.
 */
export const MID_SESSION_GAP_MS_DEFAULT = 10 * 60 * 1000;

/**
 * The mid-session rollup's kill switch, on from the first run. Off, the only boundaries are the
 * close and the idle rule, exactly as before. Reads `reflection.midSessionRollup`
 * (`AION_REFLECTION_MID_SESSION_ROLLUP`) once the config schema carries it.
 */
export const MID_SESSION_ROLLUP_DEFAULT = true;

/**
 * Silence between the two newest episodes: a session that stopped and started again. System time
 * leads for the reason `lastActivityAt` uses it, and a session of one episode has no gap at all.
 */
export function trailingGapMs(episodes: readonly NarrativeEpisode[]): number {
  const stamps = episodes
    .map((episode) => episode.writtenAt ?? episode.occurredAt)
    .filter((stamp): stamp is Date => stamp !== undefined)
    .sort((left, right) => left.getTime() - right.getTime());
  const last = stamps[stamps.length - 1];
  const previous = stamps[stamps.length - 2];
  if (last === undefined || previous === undefined) {
    return 0;
  }
  return last.getTime() - previous.getTime();
}

/** Episodes the standing version already compresses; zero when no version is open. */
export function standingCoverage(existing: readonly ExistingNarrative[]): number {
  return existing.reduce(
    (top, narrative) => (narrative.open ? Math.max(top, narrative.coverageCount) : top),
    0,
  );
}

export type MidSessionBoundaryInput = {
  readonly episodeCount: number;
  readonly coveredCount: number;
  readonly trailingGapMs: number;
  readonly episodeBoundary: number;
  readonly gapMs: number;
};

export type MidSessionBoundary = {
  readonly cross: boolean;
  readonly reason: string;
};

export function decideMidSessionBoundary(input: MidSessionBoundaryInput): MidSessionBoundary {
  const uncovered = input.episodeCount - input.coveredCount;
  if (uncovered <= 0) {
    return { cross: false, reason: 'the standing narrative covers every episode' };
  }
  if (uncovered >= input.episodeBoundary) {
    return { cross: true, reason: `${String(uncovered)} episodes since the standing narrative` };
  }
  if (input.trailingGapMs >= input.gapMs) {
    return {
      cross: true,
      reason: `the session paused for ${String(Math.round(input.trailingGapMs / 60_000))} minutes`,
    };
  }
  return { cross: false, reason: `${String(uncovered)} uncovered episodes and no pause` };
}

/** What the boundary reads off the closer's own settings, by the names it already holds them under. */
export type SessionBoundarySettings = {
  readonly now: Date;
  readonly idleMs: number;
  readonly midSession: boolean;
};

export type SessionBoundary = {
  readonly narrate: boolean;
  readonly reason: string;
};

/**
 * The whole rule for a trigger that has only the session's own shape to go on: the sweep and the
 * reflection stage. Silence past the idle window is the end of a session; short of that, a
 * mid-session boundary is the other way a narrative becomes due.
 */
export function decideSessionBoundary(
  episodes: readonly NarrativeEpisode[],
  existing: readonly ExistingNarrative[],
  settings: SessionBoundarySettings,
): SessionBoundary {
  const activity = lastActivityAt(episodes);
  if (activity === undefined) {
    return { narrate: false, reason: 'the session carries no activity timestamp' };
  }
  if (isSessionIdle(activity, settings.now, settings.idleMs)) {
    return { narrate: true, reason: 'the session has gone quiet' };
  }
  if (!settings.midSession) {
    return { narrate: false, reason: 'the session is still active' };
  }
  const boundary = decideMidSessionBoundary({
    episodeCount: episodes.length,
    coveredCount: standingCoverage(existing),
    trailingGapMs: trailingGapMs(episodes),
    episodeBoundary: MID_SESSION_EPISODES_DEFAULT,
    gapMs: MID_SESSION_GAP_MS_DEFAULT,
  });
  return boundary.cross
    ? { narrate: true, reason: boundary.reason }
    : { narrate: false, reason: `the session is still active: ${boundary.reason}` };
}
