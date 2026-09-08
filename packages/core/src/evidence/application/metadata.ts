import type { Driver } from 'neo4j-driver';

import { readRelationScope } from './dependencies.js';
import {
  fetchClaimProvenance,
  type ItemProvenance,
} from '../../infrastructure/graph/claim-provenance-queries.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNodes,
  type CommittedIncidence,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { idAddress, evidenceRequestKey, type EvidenceAddress } from '../domain/address.js';
import type { RequestBudget } from '../domain/budget.js';
import {
  evidenceResult,
  type EvidenceIssue,
  type EvidenceResidency,
  type EvidenceResult,
} from '../domain/result.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '../domain/scopes.js';

/**
 * Serving metadata for a batch of candidates: where each one came from, which sessions carry it,
 * and whether the substrate can account for that attribution at all.
 *
 * A known incomplete lineage is not a failure. An item whose stated reference resolved to
 * nothing, or whose ancestry loops, reports itself incomplete and stays a faithful reading of a
 * state the substrate holds; a store that could not be read is the other thing entirely, and the
 * two never share a word. No raw payload is decoded here: metadata that read one archive row per
 * candidate would turn a serving read into a decode of the whole batch.
 */

export type ItemMetadata = {
  readonly provenance: ItemProvenance;
  /** Every session whose sources carry this item, from the durable incidence rather than a hop. */
  readonly owningSessions: readonly string[];
  readonly sources: readonly string[];
  /** True when the incidence behind the attribution has no census to prove it complete. */
  readonly unknownAttribution: boolean;
};

export type MetadataInput = {
  readonly ids: readonly string[];
  readonly context: CheckedReadContext;
  readonly budget: RequestBudget;
  /** The serving bound on named roots, which belongs to the caller assembling the pack. */
  readonly maxRoots: number;
};

export type MetadataReading = {
  readonly results: ReadonlyMap<string, EvidenceResult<ItemMetadata>>;
  readonly issues: readonly EvidenceIssue[];
  readonly dependencies: readonly EvidenceDependency[];
};

type MetadataDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
};

function issueOn(
  address: EvidenceAddress,
  field: EvidenceIssue['field'],
  reason: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  required: boolean,
): EvidenceIssue {
  return { address, field, reason, required };
}

/** A retained node the graph does not hold, read through the records that outlive its projection. */
function residencyWithoutProjection(db: SqliteHandle, id: string): EvidenceResidency {
  if (readSourceRecord(db, id) === undefined) {
    return 'unknown-mapping';
  }
  return readSourceResidency(db, id)?.state ?? 'resident';
}

function sessionsOf(db: SqliteHandle, incidence: readonly CommittedIncidence[]): readonly string[] {
  const sessions = new Set<string>();
  for (const row of incidence) {
    const record = readSourceRecord(db, row.sourceId);
    if (record !== undefined) {
      sessions.add(record.sessionId);
    }
  }
  return [...sessions];
}

export async function readItemMetadata(
  deps: MetadataDeps,
  input: MetadataInput,
): Promise<MetadataReading> {
  const unique = [...new Set(input.ids)];
  const accepted: string[] = [];
  const results = new Map<string, EvidenceResult<ItemMetadata>>();
  const issues: EvidenceIssue[] = [];
  const dependencies: EvidenceDependency[] = [];

  for (const id of unique) {
    if (input.budget.chargeIds(1) === undefined) {
      accepted.push(id);
      continue;
    }
    const address = idAddress(id);
    const issue = issueOn(address, 'ownership', 'budget_limit', false);
    issues.push(issue);
    results.set(
      evidenceRequestKey(address),
      evidenceResult({ address, residency: 'resident', issues: [issue] }),
    );
  }

  let provenance: ReadonlyMap<string, ItemProvenance>;
  try {
    provenance = await fetchClaimProvenance(deps.driver, {
      ids: accepted,
      maxRoots: input.maxRoots,
      mode: input.context.mode,
    });
  } catch {
    for (const id of accepted) {
      const address = idAddress(id);
      const issue = issueOn(address, 'interpretation_text', 'store_unavailable', true);
      issues.push(issue);
      results.set(
        evidenceRequestKey(address),
        evidenceResult({ address, residency: 'resident', issues: [issue] }),
      );
    }
    return { results, issues, dependencies };
  }

  const incidence = committedIncidenceForNodes(deps.db, accepted);
  const overRows = input.budget.chargeRelationRows(incidence.length) !== undefined;
  const byNode = new Map<string, CommittedIncidence[]>();
  for (const row of incidence) {
    byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  }

  for (const id of accepted) {
    const address = idAddress(id);
    const found = provenance.get(id);
    const rows = byNode.get(id) ?? [];
    const nodeIssues: EvidenceIssue[] = [];

    const scope = readRelationScope(deps.db, {
      kind: 'node',
      endpointId: id,
      scope: durableRoleScope('extraction', 'out'),
      empty: rows.length === 0,
    });
    if (scope.status === 'verified') {
      dependencies.push(scope.dependency);
    } else {
      nodeIssues.push(issueOn(address, 'ownership', 'unverified_scope', false));
    }
    const nodeState = readRelationScope(deps.db, {
      kind: 'node',
      endpointId: id,
      scope: GRAPH_NODE_SCOPE,
      empty: false,
    });
    if (nodeState.status === 'verified') {
      dependencies.push(nodeState.dependency);
    } else {
      nodeIssues.push(issueOn(address, 'interpretation_text', 'unverified_scope', false));
    }
    if (overRows) {
      nodeIssues.push(issueOn(address, 'ownership', 'budget_limit', false));
    }

    if (found === undefined) {
      const residency = residencyWithoutProjection(deps.db, id);
      nodeIssues.push(
        issueOn(
          address,
          'interpretation_text',
          residency === 'unknown-mapping' ? 'unresolved_mapping' : 'not_found',
          true,
        ),
      );
      issues.push(...nodeIssues);
      results.set(
        evidenceRequestKey(address),
        evidenceResult({ address, residency, issues: nodeIssues }),
      );
      continue;
    }

    issues.push(...nodeIssues);
    results.set(
      evidenceRequestKey(address),
      evidenceResult({
        address,
        residency: 'resident',
        issues: nodeIssues,
        value: {
          provenance: found,
          owningSessions: overRows ? [] : sessionsOf(deps.db, rows),
          sources: overRows ? [] : [...new Set(rows.map((row) => row.sourceId))],
          unknownAttribution: scope.status !== 'verified' || overRows,
        },
      }),
    );
  }

  return { results, issues, dependencies };
}
