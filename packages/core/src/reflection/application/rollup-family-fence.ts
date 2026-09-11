import type { Driver } from 'neo4j-driver';

import { readNarrativeRepresentations } from '../../evidence/application/narrative-representation.js';
import { RequestBudget } from '../../evidence/domain/budget.js';
import { findRollupLineage } from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';
import type { RollupScope } from '../domain/rollup.js';

/**
 * Whether the legacy calendar pass may still stand over a window.
 *
 * The member read nominates on scope and currency, and a session that moved to chunks leaves its
 * old whole-session narrative exactly where it was: same clocks, same intervals, no supersession.
 * So nomination alone cannot tell a live legacy narrative from a retired one, and the pass that
 * publishes over those members and then absorbs them is the one that has to ask.
 *
 * It asks the representation adapter, which is the only reader that interprets the retirement
 * marker and the committed family preference. Nothing here reads either one: this file names
 * identities and reads the one answer back.
 *
 * A window is covered whole or refused, the same rule the rendered-input allowance follows. A
 * member whose family moved takes its window with it rather than being dropped from the member
 * list, because a summary that quietly left out part of its day would still store a coverage of 1
 * over the whole of it.
 */

/** Representation identities one window may prove the family of. */
export const ROLLUP_FAMILY_SCAN_LIMIT = 1024;

/** The families with a manifest of their own. A legacy calendar pass never absorbs one. */
const SIGNED_FAMILIES = ['chunk', 'overview'];

export type RollupFenceDeps = {
  readonly driver: Driver;
  readonly db?: SqliteHandle;
  readonly logger: Pick<Logger, 'warn'>;
};

export type RollupFenceInput = {
  readonly scope: RollupScope;
  readonly windowKey: string;
  readonly memberIds: readonly string[];
  readonly now: Date;
};

function refuse(
  deps: RollupFenceDeps,
  input: RollupFenceInput,
  reason: string,
  members: readonly string[],
): string {
  deps.logger.warn(
    { scope: input.scope, window: input.windowKey, reason, members },
    'narrative rollup refused: the window holds a representation this pass does not own',
  );
  return reason;
}

/**
 * The reason this window may not publish or absorb, or nothing when every member is still the
 * legacy pass's to carry.
 *
 * Called twice for a window that reaches a model: once before the synthesis, so a settled
 * refusal costs no provider call, and again immediately before the write, so a cutover that
 * lands while the model is working does not come back to a decision taken before it. The two
 * evaluations share one predicate; neither of them writes anything.
 */
export async function fenceRollupWindow(
  deps: RollupFenceDeps,
  input: RollupFenceInput,
): Promise<string | undefined> {
  const { db } = deps;
  if (db === undefined) {
    return refuse(deps, input, 'family_fence_unavailable', []);
  }
  if (input.memberIds.length === 0) {
    return undefined;
  }
  const coverage = checkPresentCoverage(db, input.now);
  if (coverage.status !== 'checked') {
    // A control record nobody can read leaves every family answer unqualified, which is a reason
    // for a sweep to stop rather than to publish over the question.
    return refuse(deps, input, 'coverage_unavailable', input.memberIds);
  }

  const lineage = await findRollupLineage(deps.driver, input.memberIds, ROLLUP_FAMILY_SCAN_LIMIT);
  const held = new Map(lineage.map((row) => [row.id, row] as const));
  const identities = new Set(input.memberIds);
  for (const member of input.memberIds) {
    const row = held.get(member);
    if (row === undefined || row.bounded) {
      return refuse(deps, input, 'legacy_family_scan_bound', [member]);
    }
    for (const ancestor of row.ancestors) {
      identities.add(ancestor);
    }
  }
  if (identities.size > ROLLUP_FAMILY_SCAN_LIMIT) {
    return refuse(deps, input, 'legacy_family_scan_bound', input.memberIds);
  }

  const reading = await readNarrativeRepresentations(
    { db, driver: deps.driver },
    [...identities],
    coverage.context,
    new RequestBudget(),
  );
  const retired: string[] = [];
  const foreign: string[] = [];
  for (const member of input.memberIds) {
    if (SIGNED_FAMILIES.includes(reading.values.get(member)?.family ?? '')) {
      foreign.push(member);
      continue;
    }
    // An unproved preference is the ordinary state of a session nobody has migrated, so it is not
    // a refusal. What refuses is a session the adapter says has chosen the other family, whether
    // it is this member's own session or one underneath a calendar summary it already absorbed.
    const line = [member, ...(held.get(member)?.ancestors ?? [])];
    if (line.some((id) => reading.values.get(id)?.selection === 'not_selected')) {
      retired.push(member);
    }
  }
  if (retired.length > 0) {
    return refuse(deps, input, 'legacy_family_changed', retired);
  }
  if (foreign.length > 0) {
    return refuse(deps, input, 'legacy_family_foreign', foreign);
  }
  return undefined;
}
