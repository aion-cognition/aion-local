import type { Driver } from 'neo4j-driver';

import { synthesizeGrounded } from './consolidation-synthesis.js';
import { attachContentVectors } from './vectors.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import {
  supersede,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import {
  findRollupMembers,
  findWindowRollups,
  ROLLUP_WINDOW_PROPERTY,
  type WindowNarrative,
} from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  buildRollupMessages,
  renderConsolidationSource,
  rollupNodeId,
  type ConsolidationMember,
} from '../domain/consolidation.js';
import { decideSessionNarrative, narrativeSpan, NARRATIVE_GROUNDING } from '../domain/narrative.js';
import {
  groupRollupWindows,
  isWindowClosed,
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

export const ROLLUP_EXTRACTION_METHOD = 'narrative_rollup';

const ROLLUP_SIGNALS = ['compression'];
const ROLLUP_PROVENANCE = [ROLLUP_EXTRACTION_METHOD];

/** Members read per run. A day of sessions and a week of days both sit far inside this. */
export const DEFAULT_ROLLUP_MEMBER_LIMIT = 200;

/**
 * Windows compressed per run, so one tick pays for a bounded number of model calls. A window
 * whose standing rollup already covers it costs no call and does not spend the budget, which is
 * what keeps a run reaching newer windows once the oldest ones are done.
 */
export const DEFAULT_ROLLUP_WINDOW_LIMIT = 2;

export type RollupDeps = {
  readonly driver: Driver;
  readonly provider: Provider;
  readonly logger: Logger;
};

export type RollupOptions = {
  readonly scope: RollupScope;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly memberLimit?: number;
  readonly windowLimit?: number;
  readonly maxMemberChars?: number;
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
  /** Member narratives this run closed into a rollup. */
  readonly absorbed: number;
};

type RollupSettings = {
  readonly scope: RollupScope;
  readonly model: string;
  readonly timeoutMs: number;
  readonly memberLimit: number;
  readonly windowLimit: number;
  readonly maxMemberChars: number;
  readonly now: Date;
  readonly signal?: AbortSignal;
};

function settingsOf(options: RollupOptions): RollupSettings {
  return {
    scope: options.scope,
    model: options.model ?? DEFAULTS.models.reflect,
    timeoutMs: options.timeoutMs ?? DEFAULTS.reflection.stageTimeoutMs,
    memberLimit: options.memberLimit ?? DEFAULT_ROLLUP_MEMBER_LIMIT,
    windowLimit: options.windowLimit ?? DEFAULT_ROLLUP_WINDOW_LIMIT,
    maxMemberChars: options.maxMemberChars ?? DEFAULTS.reflection.maxNarrativeEpisodeChars,
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

type RollupWrite = {
  readonly rollupId: string;
  readonly scope: RollupScope;
  readonly windowKey: string;
  readonly version: number;
  readonly coverageKey: string;
  readonly memberIds: readonly string[];
  readonly summary: string;
  readonly narrative: string;
  readonly citations: readonly string[];
  readonly sentenceCount: number;
  readonly spanStart?: Date;
  readonly spanEnd?: Date;
  readonly occurredAt: Date;
  readonly now: Date;
};

function rollupProperties(input: RollupWrite): GraphProperties {
  return {
    [MEMORY_PROPERTIES.summary]: input.summary,
    [MEMORY_PROPERTIES.text]: input.narrative,
    [MEMORY_PROPERTIES.extractionMethod]: ROLLUP_EXTRACTION_METHOD,
    [NARRATIVE_PROPERTIES.citations]: [...input.citations],
    [NARRATIVE_PROPERTIES.sentenceCount]: input.sentenceCount,
    [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    [NARRATIVE_PROPERTIES.scope]: input.scope,
    [ROLLUP_WINDOW_PROPERTY]: input.windowKey,
    [NARRATIVE_PROPERTIES.version]: input.version,
    [NARRATIVE_PROPERTIES.coverageKey]: input.coverageKey,
    [NARRATIVE_PROPERTIES.coverageCount]: input.memberIds.length,
    // Every member of the window is rendered, and a window the member read may have cut short
    // is not rolled up at all, so a stored rollup saw the whole of what it claims to cover.
    [NARRATIVE_PROPERTIES.coverage]: 1,
    [NARRATIVE_PROPERTIES.spanStart]: input.spanStart,
    [NARRATIVE_PROPERTIES.spanEnd]: input.spanEnd,
  };
}

/**
 * The node and the member edges in one transaction, mirroring a session narrative's own write:
 * `(member)-[:SUMMARIZED_BY]->(rollup)`, counted zero because a structural fact repeated is not
 * an observation repeated.
 */
async function writeRollup(deps: RollupDeps, input: RollupWrite): Promise<void> {
  await inWriteTransaction(deps.driver, async (tx) => {
    await writeStampedDerivedNodeInTransaction(tx, {
      label: 'Narrative',
      id: input.rollupId,
      now: input.now,
      occurredAt: input.occurredAt,
      properties: rollupProperties(input),
    });

    for (const memberId of input.memberIds) {
      await upsertEdgeInTransaction(tx, {
        type: SUMMARIZED_BY_TYPE,
        sourceId: memberId,
        targetId: input.rollupId,
        strength: 1,
        confidence: 1,
        signals: ROLLUP_SIGNALS,
        provenance: ROLLUP_PROVENANCE,
        count: 0,
        now: input.now,
      });
    }
  });
}

/**
 * Closing what the rollup absorbed, and any earlier version of the rollup itself. Both go
 * through `supersede`, so both are reversible by `aion unsupersede` and both stay readable
 * through `as_of`. `validUntil` is the world time the rollup covers up to rather than the moment
 * the sweep ran.
 */
async function closeInto(
  deps: RollupDeps,
  rollupId: string,
  ids: readonly string[],
  now: Date,
  validUntil: Date,
): Promise<number> {
  let closed = 0;
  for (const oldId of ids) {
    if (oldId === rollupId) {
      continue;
    }
    await supersede(deps.driver, {
      oldId,
      newId: rollupId,
      now,
      validUntil,
      signals: ROLLUP_SIGNALS,
      provenance: ROLLUP_PROVENANCE,
    });
    closed += 1;
  }
  return closed;
}

async function attachVector(deps: RollupDeps, rollupId: string, text: string): Promise<void> {
  try {
    await attachContentVectors(deps.driver, deps.provider, [{ id: rollupId, text }]);
  } catch (err) {
    deps.logger.warn({ err, rollupId }, 'rollup vector deferred; the rollup is stored');
  }
}

type WindowOutcome = 'created' | 'skipped' | 'vetoed' | 'failed';

async function rollUpWindow(
  deps: RollupDeps,
  settings: RollupSettings,
  window: RollupWindow,
  existing: readonly WindowNarrative[],
): Promise<{ outcome: WindowOutcome; absorbed: number }> {
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

  const source = renderConsolidationSource(toMembers(window, memberScope), settings.maxMemberChars);
  const synthesis = await synthesizeGrounded(
    deps.provider,
    source,
    buildRollupMessages(source, settings.scope),
    {
      model: settings.model,
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
  const settings = settingsOf(options);
  const memberScope = rollupMemberScope(settings.scope);
  const members = await findRollupMembers(deps.driver, {
    scope: memberScope,
    rollupScope: settings.scope,
    limit: settings.memberLimit,
  });

  const grouped = groupRollupWindows(members, settings.scope).filter((window) =>
    isWindowClosed(window, settings.now),
  );
  // The member read is capped across every window at once, so a read that came back full may
  // have cut its newest window short. A rollup asserts it saw the whole of what it covers, so
  // that window waits for a run whose read reaches all of it.
  const closed = members.length < settings.memberLimit ? grouped : grouped.slice(0, -1);

  let created = 0;
  let skipped = 0;
  let vetoed = 0;
  let failed = 0;
  let absorbed = 0;
  let examined = 0;

  // `windowLimit` bounds the rollups a tick writes, not the windows it looks at. A settled
  // window answers `skip` and writes nothing, so spending the budget on it would leave the run
  // re-examining the same oldest days forever and never reaching the ones that need a rollup.
  for (const window of closed) {
    if (settings.signal?.aborted === true) {
      break;
    }
    examined += 1;
    const existing = await findWindowRollups(deps.driver, settings.scope, window.key);
    const result = await rollUpWindow(deps, settings, window, existing);
    absorbed += result.absorbed;
    if (result.outcome === 'created') {
      created += 1;
    } else if (result.outcome === 'skipped') {
      skipped += 1;
    } else if (result.outcome === 'vetoed') {
      vetoed += 1;
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
    absorbed,
  };
}
