import { synthesizeGrounded } from './consolidation-synthesis.js';
import { attachVector, closeInto, writeRollup, type RollupWriteDeps } from './rollup-write.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import {
  findRollupMembers,
  findWindowRollups,
  type RollupMemberCursor,
  type WindowNarrative,
} from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  buildRollupMessages,
  renderConsolidationSource,
  rollupNodeId,
  type ConsolidationMember,
} from '../domain/consolidation.js';
import { narrativeScale } from '../domain/narrative-scale.js';
import { decideSessionNarrative, narrativeSpan } from '../domain/narrative.js';
import {
  groupRollupWindows,
  isWindowClosed,
  pagedWindows,
  rollupMemberScope,
  type RollupMember,
  type RollupScope,
  type RollupWindow,
} from '../domain/rollup.js';

/**
 * The scopes above a session. A day rolls up the sessions that ended inside it and a week rolls
 * up those days, each compressing the scope below into one cited view and closing its members as
 * it goes, which is the same versioning a session close already performs over its own episodes.
 *
 * The rule that makes this safe is the one supersession has always carried: nothing is deleted.
 * A rolled-up session narrative stays readable through `as_of` and through the `SUPERSEDES`
 * lineage, and `aion unsupersede` reopens any member. What the rollup takes is the member's
 * standing in default recall, which is the pack-token pressure it exists to relieve.
 *
 * A window is only rolled up once it has finished. Compressing a day that is still being written
 * to writes a version the next session close immediately makes incomplete.
 */

/** Members read per run. A day of sessions and a week of days both sit far inside this. */
export const DEFAULT_ROLLUP_MEMBER_LIMIT = 200;

/**
 * Windows compressed per run, so one tick pays for a bounded number of model calls. A window
 * whose standing rollup already covers it costs no call and does not spend the budget, which is
 * what keeps a run reaching newer windows once the oldest ones are done.
 */
export const DEFAULT_ROLLUP_WINDOW_LIMIT = 2;

export type RollupDeps = RollupWriteDeps;

export type RollupOptions = {
  readonly scope: RollupScope;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly memberLimit?: number;
  readonly windowLimit?: number;
  /** The knob group the synthesis is sized out of; the resolved route picks inside it. */
  readonly reflection?: Config['reflection'];
  /**
   * What the whole window's rendered input is allowed to be. The same allowance a chunk's own
   * synthesis is admitted under, applied to the other renderer C0 has to measure.
   */
  readonly renderedInputAllowance?: number;
  readonly now?: Date;
  readonly signal?: AbortSignal;
};

export type RollupReport = {
  readonly scope: RollupScope;
  /** Closed windows the run read, whether or not it spent a model call on one. */
  readonly windows: number;
  readonly created: number;
  readonly skipped: number;
  readonly vetoed: number;
  readonly failed: number;
  /** Windows V1 refused: the required input did not fit, or the membership was not complete. */
  readonly blocked: number;
  /** Member narratives this run closed into a rollup. */
  readonly absorbed: number;
};

type RollupSettings = {
  readonly scope: RollupScope;
  readonly model: string;
  readonly timeoutMs: number;
  readonly memberLimit: number;
  readonly windowLimit: number;
  readonly maxSentences: number;
  /** The rendered input one overview synthesis is allowed, in UTF-16 code units. */
  readonly renderedInputAllowance: number;
  readonly now: Date;
  readonly signal?: AbortSignal;
};

/**
 * Member counts and windows per tick are this operation's own bounds and do not move with the
 * route. What the route sizes is the synthesis itself: how much of each member reaches the
 * model and how long the answer runs, the same two numbers a session narrative reads.
 */
function settingsOf(options: RollupOptions, provider: Provider): RollupSettings {
  const scale = narrativeScale(
    provider.route?.provider === 'anthropic',
    options.reflection ?? DEFAULTS.reflection,
  );
  return {
    scope: options.scope,
    model: options.model ?? DEFAULTS.models.reflect,
    timeoutMs: options.timeoutMs ?? DEFAULTS.reflection.stageTimeoutMs,
    memberLimit: options.memberLimit ?? DEFAULT_ROLLUP_MEMBER_LIMIT,
    windowLimit: options.windowLimit ?? DEFAULT_ROLLUP_WINDOW_LIMIT,
    maxSentences: scale.maxSentences,
    renderedInputAllowance:
      options.renderedInputAllowance ?? DEFAULTS.maintenance.chunkRenderedInputAllowance,
    now: options.now ?? new Date(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function toMembers(window: RollupWindow, memberScope: string): readonly ConsolidationMember[] {
  return window.members.map((member) => ({
    id: member.id,
    kind: `${memberScope} narrative`,
    text: member.text.length > 0 ? member.text : (member.summary ?? ''),
    ...(member.occurredAt === undefined ? {} : { occurredAt: member.occurredAt }),
  }));
}

type WindowOutcome = 'created' | 'skipped' | 'vetoed' | 'failed' | 'blocked';

type WindowResult = {
  readonly outcome: WindowOutcome;
  readonly absorbed: number;
  /** Why V1 refused the window, where it did. */
  readonly blockedReason?: string;
};

/**
 * What the whole window would render to, with nothing clipped.
 *
 * The renderer's per-member clip is what V1 refuses to rely on: a clipped member is a partial
 * overview claiming to cover the window whole, and the coverage number it stores says 1. So the
 * required input is measured unclipped, and a window that does not fit is refused rather than
 * trimmed until it does.
 */
const UNCLIPPED = Number.MAX_SAFE_INTEGER;

async function rollUpWindow(
  deps: RollupDeps,
  settings: RollupSettings,
  window: RollupWindow,
  existing: readonly WindowNarrative[],
): Promise<WindowResult> {
  const memberScope = rollupMemberScope(settings.scope);
  const decision = decideSessionNarrative(
    window.members.map((member) => ({
      id: member.id,
      text: member.text,
      ...(member.summary === undefined ? {} : { summary: member.summary }),
      ...(member.occurredAt === undefined ? {} : { occurredAt: member.occurredAt }),
    })),
    existing,
  );
  const rollupId = rollupNodeId(settings.scope, window.key, decision.coverageKey);
  const span = narrativeSpan(window.members);
  const occurredAt = span.end ?? window.start;

  if (decision.action === 'skip') {
    // The repair a crash between the node write and its supersession leaves behind: the open
    // stragglers beside the standing version, and the members that version never closed. Both
    // are `coalesce`d closes, so a window with nothing left to repair writes nothing.
    const standing = existing.find((rollup) => rollup.id === rollupId);
    const members = standing?.open === true ? decision.episodeIds : [];
    await closeInto(deps, rollupId, [...decision.supersedes, ...members], settings.now, occurredAt);
    return { outcome: 'skipped', absorbed: 0 };
  }

  const source = renderConsolidationSource(
    toMembers(window, memberScope),
    UNCLIPPED,
    settings.maxSentences,
  );
  if (source.text.length > settings.renderedInputAllowance) {
    // V1 BLOCKS. No provider call, no publication, and the members stand exactly where they
    // were: a partial overview is worse than none, because the one it wrote would claim the
    // window whole. The measured size travels with the reason so a person can see what would
    // have to change, and an unchanged window blocks again here without generating anything.
    const reason =
      `blocked_window_capacity: ${String(source.text.length)} rendered units over an ` +
      `allowance of ${String(settings.renderedInputAllowance)} across ` +
      `${String(window.members.length)} member(s)`;
    deps.logger.warn(
      {
        scope: settings.scope,
        window: window.key,
        requiredUnits: source.text.length,
        allowance: settings.renderedInputAllowance,
        members: window.members.map((member) => member.id),
      },
      'narrative rollup blocked: the window does not fit the rendered input allowance',
    );
    return { outcome: 'blocked', absorbed: 0, blockedReason: reason };
  }
  const synthesis = await synthesizeGrounded(
    deps.provider,
    source,
    buildRollupMessages(source, settings.scope),
    {
      model: settings.model,
      surface: 'narrative_rollup',
      timeoutMs: settings.timeoutMs,
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    },
  );

  if (synthesis.status === 'vetoed') {
    deps.logger.info(
      { scope: settings.scope, window: window.key, reason: synthesis.reason },
      'rollup vetoed by review; the member narratives stand',
    );
    return { outcome: 'vetoed', absorbed: 0 };
  }
  if (synthesis.status === 'failed') {
    deps.logger.warn(
      { scope: settings.scope, window: window.key, detail: synthesis.detail },
      'rollup synthesis failed',
    );
    return { outcome: 'failed', absorbed: 0 };
  }

  await writeRollup(deps, {
    rollupId,
    scope: settings.scope,
    windowKey: window.key,
    version: decision.version,
    coverageKey: decision.coverageKey,
    memberIds: decision.episodeIds,
    summary: synthesis.grounded.summary,
    narrative: synthesis.grounded.narrative,
    citations: synthesis.grounded.citations,
    sentenceCount: synthesis.grounded.kept,
    ...(span.start === undefined ? {} : { spanStart: span.start }),
    ...(span.end === undefined ? {} : { spanEnd: span.end }),
    occurredAt,
    now: settings.now,
  });

  const absorbed = await closeInto(
    deps,
    rollupId,
    [...decision.supersedes, ...decision.episodeIds],
    settings.now,
    occurredAt,
  );
  await attachVector(deps, rollupId, synthesis.grounded.narrative);

  deps.logger.info(
    {
      scope: settings.scope,
      window: window.key,
      rollupId,
      version: decision.version,
      members: decision.episodeIds.length,
      sentences: synthesis.grounded.kept,
      absorbed,
    },
    'narrative rollup stored',
  );
  return { outcome: 'created', absorbed };
}

/** Where the last pass of one scope stopped reading members. */
function memberCursorKey(scope: RollupScope): string {
  return `narrative-rollup:member-cursor:${scope}`;
}

function readMemberCursor(
  db: SqliteHandle | undefined,
  scope: RollupScope,
): RollupMemberCursor | undefined {
  if (db === undefined) {
    return undefined;
  }
  const summary = getLedgerEntry(db, memberCursorKey(scope))?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { occurredAt, id } = summary as { occurredAt?: unknown; id?: unknown };
  if (typeof occurredAt !== 'string' || typeof id !== 'string' || id === '') {
    return undefined;
  }
  const at = new Date(occurredAt);
  return Number.isNaN(at.getTime()) ? undefined : { occurredAt: at, id };
}

function writeMemberCursor(
  db: SqliteHandle | undefined,
  scope: RollupScope,
  cursor: RollupMemberCursor | undefined,
): void {
  if (db === undefined) {
    return;
  }
  markLedgerApplied(
    db,
    memberCursorKey(scope),
    cursor === undefined ? {} : { occurredAt: cursor.occurredAt.toISOString(), id: cursor.id },
  );
}

/**
 * Where the next page starts, which is only ever a WINDOW boundary.
 *
 * Three positions, and the reason for each. A short page reached the end of the enumeration and
 * clears the position. A full page that proved at least one window whole stops at the last member
 * of the last whole one, so the cut window is read again from its own beginning with a fresh page
 * to itself. A full page that proved NONE whole holds a single window larger than the page: it can
 * never be enumerated at this bound, so the position steps past the window's calendar end, and the
 * window stays blocked instead of publishing the part of it that fit.
 *
 * A cursor that stopped at the last MEMBER read is the defect this replaces. It leaves a position
 * inside a window, and the run that comes back to it sees a suffix and calls it a complete window.
 */
function nextMemberCursor(
  members: readonly RollupMember[],
  memberLimit: number,
  paged: { readonly whole: readonly RollupWindow[]; readonly cut: RollupWindow | undefined },
): RollupMemberCursor | undefined {
  if (members.length < memberLimit) {
    return undefined;
  }
  const lastWhole = paged.whole[paged.whole.length - 1];
  if (lastWhole !== undefined) {
    const stopAt = lastWhole.members[lastWhole.members.length - 1];
    return stopAt?.occurredAt === undefined
      ? undefined
      : { occurredAt: stopAt.occurredAt, id: stopAt.id };
  }
  if (paged.cut !== undefined) {
    // The window's own exclusive end. Nothing inside it sorts at or after this, and a member
    // occurring exactly at it belongs to the next window and is reached by the id half of the key.
    return { occurredAt: paged.cut.end, id: '' };
  }
  // A full page of members none of which could be placed in a window at all.
  const last = members[members.length - 1];
  return last?.occurredAt === undefined ? undefined : { occurredAt: last.occurredAt, id: last.id };
}

/**
 * One scope's rollup pass. Finding nothing is the ordinary answer on a young substrate: a day
 * rollup needs a day that has ended with session narratives inside it, and a week rollup needs
 * the days. Neither is a gate on shipping the operation, and both start working the moment the
 * history exists.
 */
export async function rollUpNarratives(
  deps: RollupDeps,
  options: RollupOptions,
): Promise<RollupReport> {
  const settings = settingsOf(options, deps.provider);
  const memberScope = rollupMemberScope(settings.scope);
  const cursor = readMemberCursor(deps.db, settings.scope);
  let members = await findRollupMembers(deps.driver, {
    scope: memberScope,
    rollupScope: settings.scope,
    limit: settings.memberLimit,
    ...(cursor === undefined ? {} : { after: cursor }),
  });
  if (members.length === 0 && cursor !== undefined) {
    // The end of the enumeration, reached inside this run rather than costing one. Starting from
    // the front again is what makes the position a position and not a discharge.
    members = await findRollupMembers(deps.driver, {
      scope: memberScope,
      rollupScope: settings.scope,
      limit: settings.memberLimit,
    });
  }

  // Windows over EVERY member on the page, open ones included: which window a full page cut in
  // half is a question about the page, and a window that is still open is as capable of being cut
  // as a closed one.
  const paged = pagedWindows(
    groupRollupWindows(members, settings.scope),
    members.length >= settings.memberLimit,
  );
  // The cut window is not one this run can enumerate completely, so it is BLOCKED with its reason
  // rather than quietly dropped from the list — and never published from the part of it that fits.
  const truncated = paged.cut?.key;
  const closed = paged.whole
    .concat(paged.cut === undefined ? [] : [paged.cut])
    .filter((window) => isWindowClosed(window, settings.now));
  writeMemberCursor(
    deps.db,
    settings.scope,
    nextMemberCursor(members, settings.memberLimit, paged),
  );

  let created = 0;
  let skipped = 0;
  let vetoed = 0;
  let failed = 0;
  let blocked = 0;
  let absorbed = 0;
  let examined = 0;

  // `windowLimit` bounds the EXPENSIVE ATTEMPTS a tick makes, not the windows it looks at, and
  // the two budgets are deliberately different things. A settled window answers `skip` and a
  // refused one answers `blocked`; neither asks a provider and neither writes, so charging either
  // against the budget would leave the run re-examining the same oldest days forever and never
  // reaching the ones that need a rollup — an unchanged blocked prefix would hide every fitting
  // window behind it for as long as it stood. What bounds the scan is the member read above.
  //
  // Nothing is remembered about a refusal, which is what makes the wakeup free: a window whose
  // input or allowance changed is measured again on the next pass and publishes if it now fits.
  // The recorded block is a diagnostic and authorizes nothing.
  for (const window of closed) {
    if (settings.signal?.aborted === true) {
      break;
    }
    examined += 1;
    if (window.key === truncated) {
      blocked += 1;
      continue;
    }
    const existing = await findWindowRollups(deps.driver, settings.scope, window.key);
    const result = await rollUpWindow(deps, settings, window, existing);
    absorbed += result.absorbed;
    if (result.outcome === 'created') {
      created += 1;
    } else if (result.outcome === 'skipped') {
      skipped += 1;
    } else if (result.outcome === 'vetoed') {
      vetoed += 1;
    } else if (result.outcome === 'blocked') {
      blocked += 1;
    } else {
      failed += 1;
    }
    if (created + vetoed + failed >= settings.windowLimit) {
      break;
    }
  }

  return {
    scope: settings.scope,
    windows: examined,
    created,
    skipped,
    vetoed,
    failed,
    blocked,
    absorbed,
  };
}
