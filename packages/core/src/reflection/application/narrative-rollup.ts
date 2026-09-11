import { synthesizeGrounded } from './consolidation-synthesis.js';
import { readMemberCursor, nextMemberCursor, writeMemberCursor } from './rollup-cursor.js';
import {
  bindRollupCoverage,
  proveRollupFamily,
  type RollupCoverageBinding,
} from './rollup-family-fence.js';
import { publishCalendarRollup } from './rollup-publish.js';
import { attachVector, type RollupWriteDeps } from './rollup-write.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import {
  findOpenNarratives,
  findRollupMembers,
  findWindowRollups,
  type WindowNarrative,
} from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
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

export type RollupDeps = RollupWriteDeps & {
  /** The coordinator every calendar summary and every repair close now lands through. */
  readonly publications?: PublicationCoordinator;
};

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
  /** Windows the family fence refused, which this pass no longer represents. */
  readonly fenced: number;
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

type WindowOutcome = 'created' | 'skipped' | 'vetoed' | 'failed' | 'blocked' | 'fenced';

type WindowResult = {
  readonly outcome: WindowOutcome;
  readonly absorbed: number;
  /**
   * Why V1 refused the window, where it did. Carried for the record and read by nothing: the
   * pass counts outcomes, so a caller wanting the cause reads the warning this field was built
   * beside rather than this field.
   */
  readonly blockedReason?: string;
  /** The window reached a provider before this outcome, so the attempt budget charges it. */
  readonly spent?: boolean;
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
  coverage: RollupCoverageBinding,
): Promise<WindowResult> {
  const memberScope = rollupMemberScope(settings.scope);
  // Before the decision, and over the COMPLETE population a publication here would touch: the
  // members it covers and every version the window already carries, which is what the writer
  // closes. A window this pass cannot prove it owns costs no provider call, and the repair branch
  // below absorbs without asking a model, so the proof has to come before both.
  const proof = await proveRollupFamily(deps, {
    scope: settings.scope,
    windowKey: window.key,
    memberIds: window.members.map((member) => member.id),
    headIds: existing.map((rollup) => rollup.id),
    coverage,
    now: settings.now,
  });
  if (proof.status === 'refused') {
    return { outcome: 'fenced', absorbed: 0, blockedReason: proof.reason };
  }
  // Another family's node standing in the same window is not a version of this one. Leaving it in
  // would let it decide the next version number and then be closed as if it were a predecessor.
  const versions = existing.filter((rollup) => !proof.proof.foreignHeads.includes(rollup.id));
  const decision = decideSessionNarrative(
    window.members.map((member) => ({
      id: member.id,
      text: member.text,
      ...(member.summary === undefined ? {} : { summary: member.summary }),
      ...(member.occurredAt === undefined ? {} : { occurredAt: member.occurredAt }),
    })),
    versions,
  );
  const rollupId = rollupNodeId(settings.scope, window.key, decision.coverageKey);
  const span = narrativeSpan(window.members);
  const occurredAt = span.end ?? window.start;
  // What the decision was taken over, carried into the intent so the guard can ask whether it is
  // still the window. Owned versions only: another family's node is not a version here.
  const bound = {
    scope: settings.scope,
    windowKey: window.key,
    memberIds: window.members.map((member) => member.id),
    windowStart: window.start,
    windowEnd: window.end,
    memberScope,
    expectedHeads: versions.map((rollup) => rollup.id),
    coverage,
    proof: proof.proof,
  } as const;

  if (decision.action === 'skip') {
    // The repair a crash between the node write and its supersession leaves behind: the open
    // stragglers beside the standing version, and the members that version never closed. It
    // generates nothing and it still closes nodes, so it lands through the same publication.
    const standing = versions.find((rollup) => rollup.id === rollupId);
    const members = standing?.open === true ? decision.episodeIds : [];
    // Only what is actually still open. A settled window has nothing left to close, and opening a
    // publication every pass to close nothing is a receipt per window per tick.
    const closes = await findOpenNarratives(
      deps.driver,
      [...decision.supersedes, ...members].filter((id) => id !== rollupId),
    );
    if (closes.length === 0) {
      return { outcome: 'skipped', absorbed: 0 };
    }
    const repaired = await publishCalendarRollup(deps, {
      ...bound,
      mode: 'repair',
      nodeId: rollupId,
      version: decision.version,
      coverageKey: decision.coverageKey,
      closes,
      openCloses: closes,
      summary: '',
      narrative: '',
      citations: [],
      sentenceCount: 0,
      spanStart: null,
      spanEnd: null,
      occurredAt,
    });
    return repaired.status === 'acknowledged'
      ? { outcome: 'skipped', absorbed: 0 }
      : { outcome: 'fenced', absorbed: 0, blockedReason: repaired.reason };
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

  // The guard opens here and not before: the summary is written, its members absorbed and their
  // edges closed inside one publication whose precondition is the family proof above. A cutover
  // acknowledged while the model was working moves that proof's scope, and this lands nothing.
  const closes = [...new Set([...decision.supersedes, ...decision.episodeIds])].filter(
    (id) => id !== rollupId,
  );
  const landed = await publishCalendarRollup(deps, {
    ...bound,
    mode: 'publish',
    nodeId: rollupId,
    version: decision.version,
    coverageKey: decision.coverageKey,
    closes,
    openCloses: await findOpenNarratives(deps.driver, closes),
    summary: synthesis.grounded.summary,
    narrative: synthesis.grounded.narrative,
    citations: synthesis.grounded.citations,
    sentenceCount: synthesis.grounded.kept,
    spanStart: span.start ?? null,
    spanEnd: span.end ?? null,
    occurredAt,
  });
  if (landed.status !== 'acknowledged') {
    return { outcome: 'fenced', absorbed: 0, blockedReason: landed.reason, spent: true };
  }
  const { absorbed } = landed;
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

function empty(scope: RollupScope): RollupReport {
  return {
    scope,
    windows: 0,
    created: 0,
    skipped: 0,
    vetoed: 0,
    failed: 0,
    blocked: 0,
    fenced: 0,
    absorbed: 0,
  };
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
  // Bound before the first input read and carried through the proof, the request and the intent.
  // A contract read later is a different question from the one these members answered, and a
  // control record nobody can read is a reason for a sweep to stop rather than to guess.
  const coverage = deps.db === undefined ? undefined : bindRollupCoverage(deps.db, settings.now);
  if (coverage === undefined) {
    return empty(settings.scope);
  }
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
  let fenced = 0;
  let absorbed = 0;
  let examined = 0;
  let raced = 0;

  // `windowLimit` bounds the EXPENSIVE ATTEMPTS a tick makes, not the windows it looks at, and
  // the two budgets are deliberately different things. A settled window answers `skip`, a refused
  // one answers `blocked`, and one the family fence turned away before the synthesis answers
  // `fenced`; none of the three asks a provider and none writes, so charging them
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
    const result = await rollUpWindow(deps, settings, window, existing, coverage);
    absorbed += result.absorbed;
    // A fence that turned the window away AFTER the synthesis still spent the call it is there
    // to save, so that one is charged and the free refusals are not.
    raced += result.spent === true ? 1 : 0;
    if (result.outcome === 'created') {
      created += 1;
    } else if (result.outcome === 'skipped') {
      skipped += 1;
    } else if (result.outcome === 'vetoed') {
      vetoed += 1;
    } else if (result.outcome === 'blocked') {
      blocked += 1;
    } else if (result.outcome === 'fenced') {
      fenced += 1;
    } else {
      failed += 1;
    }
    if (created + vetoed + failed + raced >= settings.windowLimit) {
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
    fenced,
    absorbed,
  };
}
