import type { Driver } from 'neo4j-driver';

import { ensureSessionFamily } from './narrative-family.js';
import { isUnrecorded, readingSessions, rollupOwnership } from './rollup-ownership.js';
import {
  readNarrativeRepresentations,
  type RepresentationReading,
} from '../../evidence/application/narrative-representation.js';
import { EVIDENCE_LIMITS, RequestBudget } from '../../evidence/domain/budget.js';
import {
  findRollupLineage,
  type RollupLineage,
} from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  checkPresentCoverage,
  type CheckedReadContext,
} from '../../recall/application/coverage-checker.js';
import type { RollupScope } from '../domain/rollup.js';

/**
 * Whether the legacy calendar pass owns what a window would write over, absorb and close.
 *
 * The member read nominates on scope and currency, and a session that moved to chunks leaves its
 * old whole-session narrative exactly where it was: same clocks, same intervals, no supersession.
 * Nomination therefore proves nothing about ownership, and this is what the pass asks instead.
 *
 * It asks the representation adapter, which is the only reader that interprets the retirement
 * marker and the committed family preference. Nothing here reads either one.
 *
 * The answer this produces is a PROOF the publication carries: the identities it proved and the
 * family-selection scopes the proof rests on. The handler rechecks the same predicate against a
 * fresh reading under the guard, so a choice that moves between the two is caught by the
 * publication rather than by the ordering of two reads.
 */

/**
 * Representation identities one window may prove the family of.
 *
 * The number is the adapter's own per-request identity allowance, because the publication's
 * recheck runs through the bounded policy reread and has to be able to name everything this
 * reading named. A window whose proof would not fit both sides is refused rather than published
 * on the half that fits.
 */
export const ROLLUP_FAMILY_SCAN_LIMIT = EVIDENCE_LIMITS.requestedIds;

/** Sessions one window may initialize through the producer before it gives up on the window. */
export const ROLLUP_FAMILY_INITIALIZE_LIMIT = 64;

/**
 * The contract one pass reads everything under.
 *
 * Bound once, before the first input read, and carried through the proof, the request and the
 * intent. A contract read after the synthesis is a different question from the one the input
 * answered, and putting that later epoch in the intent asks the coordinator to validate a
 * binding no read was taken under.
 */
export type RollupCoverageBinding = {
  readonly epoch: string;
  readonly context: CheckedReadContext;
};

export function bindRollupCoverage(db: SqliteHandle, now: Date): RollupCoverageBinding | undefined {
  const coverage = checkPresentCoverage(db, now);
  return coverage.status === 'checked'
    ? { epoch: coverage.context.coverageEpoch, context: coverage.context }
    : undefined;
}

export type RollupFenceDeps = {
  readonly driver: Driver;
  readonly db?: SqliteHandle;
  readonly publications?: PublicationCoordinator;
  readonly logger: Pick<Logger, 'warn'>;
};

export type RollupFenceInput = {
  readonly scope: RollupScope;
  readonly windowKey: string;
  /** The binding taken before the member read, not one this proof takes for itself. */
  readonly coverage: RollupCoverageBinding;
  /** What the window covers, which this pass would publish over and absorb. */
  readonly memberIds: readonly string[];
  /** Every version the window already carries, which this pass would close or leave alone. */
  readonly headIds: readonly string[];
  readonly now: Date;
};

/** What the publication carries, and what its guard rechecks the same predicate against. */
export type RollupFamilyProof = {
  readonly ownedIds: readonly string[];
  /** Versions of another family: not this writer's versions, and not its closure targets. */
  readonly foreignHeads: readonly string[];
  readonly dependencies: readonly EvidenceDependency[];
};

export type RollupFamilyReading =
  | { readonly status: 'proved'; readonly proof: RollupFamilyProof }
  | { readonly status: 'refused'; readonly reason: string };

function refuse(
  deps: RollupFenceDeps,
  input: RollupFenceInput,
  reason: string,
  subjects: readonly string[],
): RollupFamilyReading {
  deps.logger.warn(
    { scope: input.scope, window: input.windowKey, reason, subjects },
    'narrative rollup refused: the window holds a representation this pass cannot prove it owns',
  );
  return { status: 'refused', reason };
}

type Candidates = {
  readonly lineage: Map<string, RollupLineage>;
  readonly identities: readonly string[];
};

/** Every identity the window's answer depends on: its candidates and what they rest on. */
async function expand(
  deps: RollupFenceDeps,
  candidates: readonly string[],
): Promise<Candidates | string> {
  const rows = await findRollupLineage(deps.driver, candidates, ROLLUP_FAMILY_SCAN_LIMIT);
  const lineage = new Map(rows.map((row) => [row.id, row] as const));
  const identities = new Set(candidates);
  for (const id of candidates) {
    const row = lineage.get(id);
    if (row === undefined || row.bounded) {
      return 'legacy_family_scan_bound';
    }
    for (const ancestor of row.ancestors) {
      identities.add(ancestor);
    }
  }
  if (identities.size > ROLLUP_FAMILY_SCAN_LIMIT) {
    return 'legacy_family_scan_bound';
  }
  return { lineage, identities: [...identities] };
}

/**
 * Proof that this window is the legacy calendar family's to write.
 *
 * A member it cannot prove refuses the whole window rather than being dropped from the member
 * list: a summary that quietly left out part of its day would still store a coverage of 1 over
 * the whole of it. An existing HEAD of another family is different. It was never a version of
 * this family, so it is excluded from the version set instead of refusing the window, and the
 * pass neither counts it nor closes it.
 */
export async function proveRollupFamily(
  deps: RollupFenceDeps,
  input: RollupFenceInput,
): Promise<RollupFamilyReading> {
  const { db } = deps;
  if (db === undefined) {
    return refuse(deps, input, 'family_fence_unavailable', []);
  }
  const candidates = [...new Set([...input.memberIds, ...input.headIds])];
  if (candidates.length === 0) {
    return { status: 'proved', proof: { ownedIds: [], foreignHeads: [], dependencies: [] } };
  }
  const expanded = await expand(deps, candidates);
  if (typeof expanded === 'string') {
    return refuse(deps, input, expanded, candidates);
  }

  const read = async (): Promise<RepresentationReading> =>
    readNarrativeRepresentations(
      { db, driver: deps.driver },
      expanded.identities,
      input.coverage.context,
      new RequestBudget(),
    );
  const first = await read();
  // Exactly one unproved answer is the producer's to repair: a session with no recorded
  // preference at all. An unreadable record, a pending acknowledgment and a session that has
  // chosen the other family are all answers, and none of them is an uninitialized session.
  const unrecorded = expanded.identities.filter((id) =>
    isUnrecorded(rollupOwnership(id, first, expanded.lineage)),
  );
  if (unrecorded.length > 0) {
    const initialized = await initialize(deps, readingSessions(unrecorded, first));
    if (initialized !== undefined) {
      return refuse(deps, input, initialized, unrecorded);
    }
  }
  const reading = unrecorded.length === 0 ? first : await read();

  const foreignHeads: string[] = [];
  for (const id of candidates) {
    const held = rollupOwnership(id, reading, expanded.lineage);
    if (held.status !== 'foreign') {
      continue;
    }
    if (input.memberIds.includes(id)) {
      return refuse(deps, input, 'legacy_family_foreign', [id]);
    }
    foreignHeads.push(id);
  }
  const owned = candidates.filter((id) => !foreignHeads.includes(id));
  const blocked = owned.find(
    (id) => rollupOwnership(id, reading, expanded.lineage).status !== 'owned',
  );
  if (blocked !== undefined) {
    const held = rollupOwnership(blocked, reading, expanded.lineage);
    return refuse(
      deps,
      input,
      held.status === 'unproved' ? held.reason : 'legacy_family_unproved',
      [blocked],
    );
  }
  return {
    status: 'proved',
    proof: {
      ownedIds: owned.sort(),
      foreignHeads: foreignHeads.sort(),
      dependencies: reading.dependencies,
    },
  };
}

/** One bounded producer pass. A session the writer cannot initialize refuses its window. */
async function initialize(
  deps: RollupFenceDeps,
  sessionIds: readonly string[],
): Promise<string | undefined> {
  const { db, publications } = deps;
  if (sessionIds.length === 0) {
    return 'legacy_family_unproved:no_session';
  }
  if (db === undefined || publications === undefined) {
    return 'legacy_family_producer_unavailable';
  }
  if (sessionIds.length > ROLLUP_FAMILY_INITIALIZE_LIMIT) {
    return 'legacy_family_initialize_bound';
  }
  for (const sessionId of sessionIds) {
    const ready = await ensureSessionFamily({ driver: deps.driver, db, publications }, sessionId);
    if (ready.status !== 'ready') {
      return `legacy_family_uninitialized:${ready.reason}`;
    }
  }
  return undefined;
}
