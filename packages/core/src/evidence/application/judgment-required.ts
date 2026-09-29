import { readRelationScope, type EvidenceDependencies } from './dependencies.js';
import type { JudgmentDeps, JudgmentPair, JudgmentSideRequest } from './judgment.js';
import { resolveSourceEvidence, type SourceEvidence } from './sources.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNode,
  countCommittedIncidenceForNode,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { idAddress, type EvidenceAddress } from '../domain/address.js';
import type { RequestBudget } from '../domain/budget.js';
import type { EvidenceIssue } from '../domain/result.js';
import {
  durableRoleScope,
  GRAPH_NODE_SCOPE,
  type DurableRole,
  type ScopeDirection,
} from '../domain/scopes.js';

/**
 * What one side of a pair is entitled to be judged on: the source occurrences its own family
 * reaches, the scopes consulted to find them, and the node state the statement belongs to.
 */

export type RequiredSources = {
  readonly status: 'named' | 'unverified';
  /** Why the set is unproved: nobody counted it, or this request cannot afford to read it. */
  readonly reason: 'required_scope_missing' | 'budget_limit';
  readonly sourceIds: readonly string[];
  readonly dependencies: readonly EvidenceDependency[];
};

/**
 * Which incidence carries a node's own sources, by the family it belongs to.
 *
 * A claim reaches its sources through the extraction that minted it. An entity reaches them
 * through the mentions and participations its writers actually record; demanding an extraction
 * role of an entity would make a resolver ask writers to invent a relation nobody owns.
 */
export const REQUIRED_ROLES = {
  claim_judgment: [{ role: 'extraction', direction: 'out' }],
  entity_judgment: [
    { role: 'mention', direction: 'in' },
    { role: 'participation', direction: 'in' },
  ],
} as const satisfies Record<
  JudgmentPair['use'],
  readonly { readonly role: DurableRole; readonly direction: ScopeDirection }[]
>;

/**
 * Every source occurrence the node's evidence comes from, with the scopes consulted to find
 * them.
 *
 * A folded claim reserves all of them: picking one edge would reserve the wrong witness whenever
 * the fold is what the judgment turns on. Every role in the family has to be counted, not one of
 * them: an entity whose mentions are proved and whose participations are not has a membership
 * nobody has established. The incoming correction scope counts the same way, because what a
 * correction says about the node decides whether the answer stands, and a scope nobody counted
 * cannot say that no correction arrived.
 */
function requiredSourcesOf(
  db: SqliteHandle,
  nodeId: string,
  use: JudgmentPair['use'],
  budget: RequestBudget,
): RequiredSources {
  const dependencies: EvidenceDependency[] = [];
  const sourceIds = new Set<string>();
  const consulted = [
    ...REQUIRED_ROLES[use],
    { role: 'stated_correction', direction: 'in' } as const,
  ];
  let proved = true;
  let overBudget = false;
  for (const { role, direction } of consulted) {
    // Charged from a count, before the rows are materialized: a bound that is applied to what a
    // read already returned has not bounded the read.
    if (budget.chargeRelationRows(countCommittedIncidenceForNode(db, nodeId, role)) !== undefined) {
      overBudget = true;
      break;
    }
    const rows = committedIncidenceForNode(db, nodeId, role);
    const scope = readRelationScope(db, {
      kind: 'node',
      endpointId: nodeId,
      scope: durableRoleScope(role, direction),
      empty: rows.length === 0,
    });
    if (scope.status === 'verified') {
      dependencies.push(scope.dependency);
    } else {
      proved = false;
    }
    if (role !== 'stated_correction') {
      for (const row of rows) {
        sourceIds.add(row.sourceId);
      }
    }
  }
  return {
    status: proved && !overBudget && sourceIds.size > 0 ? 'named' : 'unverified',
    reason: overBudget ? 'budget_limit' : 'required_scope_missing',
    sourceIds: [...sourceIds],
    dependencies,
  };
}

export type RequiredReading = {
  readonly sources: readonly SourceEvidence[];
  readonly issues: readonly EvidenceIssue[];
  readonly suppressed: readonly EvidenceAddress[];
};

/**
 * The node's own semantic state, which the statement a judge is shown belongs to.
 *
 * The caller supplies the words; what the graph holds under that identity is what makes them the
 * current reading of it. A revision naming only the incidence would let the statement be
 * corrected, closed or re-typed underneath an answer and still confirm as current, so the scope
 * is bound here and an uncounted one blocks rather than passing as agreement.
 */
export function readNodeState(
  deps: JudgmentDeps,
  nodeId: string,
  dependencies: EvidenceDependencies,
): EvidenceIssue | undefined {
  const scope = readRelationScope(deps.db, {
    kind: 'node',
    endpointId: nodeId,
    scope: GRAPH_NODE_SCOPE,
    empty: false,
  });
  if (scope.status === 'verified') {
    dependencies.add(scope.dependency);
    return undefined;
  }
  return {
    address: idAddress(nodeId),
    field: 'interpretation_text',
    reason: 'required_scope_missing',
    required: true,
  };
}

/** One side's required sources, read before anything optional is looked at. */
export function readRequired(
  deps: JudgmentDeps,
  request: JudgmentSideRequest,
  pair: JudgmentPair,
  context: CheckedReadContext,
  budget: RequestBudget,
  dependencies: EvidenceDependencies,
): RequiredReading {
  const address = idAddress(request.nodeId);
  // Read before the sources and reported after them: a proved suppression is still an
  // abstention, and an unproved node state must not turn one into an ordinary gap.
  const stateIssue = readNodeState(deps, request.nodeId, dependencies);
  const unproved = stateIssue === undefined ? [] : [stateIssue];
  const required = requiredSourcesOf(deps.db, request.nodeId, pair.use, budget);
  dependencies.addAll(required.dependencies);
  if (required.status === 'unverified') {
    return {
      sources: [],
      issues: [
        ...unproved,
        { address, field: 'source_content', reason: required.reason, required: true },
      ],
      suppressed: [],
    };
  }

  const sources: SourceEvidence[] = [];
  const issues: EvidenceIssue[] = [];
  const suppressed: EvidenceAddress[] = [];
  for (const sourceId of required.sourceIds) {
    if (budget.chargeIds(1) !== undefined) {
      issues.push({
        address: idAddress(sourceId),
        field: 'source_content',
        reason: 'budget_limit',
        required: true,
      });
      continue;
    }
    const resolution = resolveSourceEvidence(deps.db, idAddress(sourceId), {
      use: pair.use,
      context,
      budget,
      required: true,
    });
    dependencies.addAll(resolution.dependencies);
    for (const issue of resolution.issues) {
      if (issue.reason === 'suppressed_source') {
        suppressed.push(issue.address);
      } else if (issue.required) {
        issues.push(issue);
      }
    }
    if (resolution.value !== undefined) {
      sources.push(resolution.value);
    } else if (issues.length === 0 && suppressed.length === 0) {
      issues.push({
        address: idAddress(sourceId),
        field: 'source_content',
        reason: 'not_found',
        required: true,
      });
    }
  }
  return { sources, issues: [...unproved, ...issues], suppressed };
}
