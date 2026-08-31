import type { HealthSnapshot } from './health.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';

/**
 * Classification and horizons for `proposal_hygiene`, the operation that ages a stale
 * proposal out of the review queue. Everything here reads structural signals only: an
 * episode's own turn and tool-execution counts, and the clock on the proposal itself. No
 * text is read and no model is consulted here; the one judgment call the op makes (whether
 * a fuzzy entity-merge pair names the same thing) happens in the application layer, because
 * a model call is not a pure function.
 */

export type HygieneProposalTable = 'supersession' | 'entity_merge';

/** The structural facts a hygiene classification reads off the proposal's source episode. */
export type HygieneEpisodeSignal = {
  readonly occurredAt: Date;
  readonly turnCount: number;
  readonly toolExecutionCount: number;
};

export type HygieneAgeClass = 'tooling_exhaust' | 'ordinary_residue';

export type HygieneHorizons = {
  readonly pollutedHours: number;
  readonly residueDays: number;
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Tooling exhaust: an episode with no turns and at least one tool call, which is the shape
 * a subagent-stop flush without any conversation produces. The episode's own clock has to be
 * no later than the proposal's `created_at`, because a re-detection upsert repoints
 * `episode_id` to whatever episode most recently found the same pair while leaving
 * `created_at` alone; an episode newer than the proposal it is joined to is a sign this read
 * is looking at a different detection than the one that actually opened the row, so it falls
 * through to the ordinary horizon instead of the fast one. An unreadable episode (forgotten,
 * or the id names nothing) gets the same fallback, on the same reasoning: nothing here can
 * confirm it was tool exhaust.
 */
export function classifyHygieneAge(
  createdAt: Date,
  episode: HygieneEpisodeSignal | undefined,
): HygieneAgeClass {
  if (
    episode?.turnCount === 0 &&
    episode.toolExecutionCount > 0 &&
    episode.occurredAt.getTime() <= createdAt.getTime()
  ) {
    return 'tooling_exhaust';
  }
  return 'ordinary_residue';
}

export function hygieneHorizonMs(ageClass: HygieneAgeClass, horizons: HygieneHorizons): number {
  return ageClass === 'tooling_exhaust'
    ? horizons.pollutedHours * MS_PER_HOUR
    : horizons.residueDays * MS_PER_DAY;
}

export function hygieneAgeMs(createdAt: Date, now: Date): number {
  return Math.max(0, now.getTime() - createdAt.getTime());
}

/** For the ledger summary: an age a person reads at a glance, not a raw millisecond count. */
export function hygieneAgeDays(createdAt: Date, now: Date): number {
  return hygieneAgeMs(createdAt, now) / MS_PER_DAY;
}

/** Whichever horizon the class carries, measured off the proposal's own `created_at`. */
export function isPastHygieneHorizon(
  createdAt: Date,
  now: Date,
  ageClass: HygieneAgeClass,
  horizons: HygieneHorizons,
): boolean {
  return hygieneAgeMs(createdAt, now) >= hygieneHorizonMs(ageClass, horizons);
}

/**
 * Relevance reads the shipped defaults rather than the live config, matching every other
 * operation's own relevance function: the contract gives it only the health snapshot, so a
 * knob an operator retuned changes what the op does but not how urgently the loop thinks it
 * should run. Zero with nothing open or with the oldest row still under the fast horizon,
 * since neither is evidence of a backlog; otherwise the oldest row's age against the ordinary
 * horizon, the same "age rather than count" reading `observe.ts` uses for everything else in
 * this snapshot.
 */
const RELEVANCE_HORIZONS: HygieneHorizons = {
  pollutedHours: DEFAULTS.maintenance.hygienePollutedAgeHours,
  residueDays: DEFAULTS.maintenance.hygieneResidueAgeDays,
};

export function proposalHygieneRelevance(health: HealthSnapshot): number {
  const open = health.proposals.supersessionOpen + health.proposals.entityMergeOpen;
  const oldest = health.proposals.oldestOpenAgeMs;
  if (open === 0 || oldest === undefined) {
    return 0;
  }
  if (oldest < RELEVANCE_HORIZONS.pollutedHours * MS_PER_HOUR) {
    return 0;
  }
  return Math.min(1, oldest / (RELEVANCE_HORIZONS.residueDays * MS_PER_DAY));
}

/** Permanent, keyed by table and id: a dismissal is judged once and the record stands alone. */
export const HYGIENE_LEDGER_PREFIX = 'proposal_hygiene:';

export function hygieneLedgerKey(table: HygieneProposalTable, id: string): string {
  return `${HYGIENE_LEDGER_PREFIX}${table}:${id}`;
}
