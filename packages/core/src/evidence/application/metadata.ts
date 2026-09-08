import type { Driver } from 'neo4j-driver';

import { readRelationScope } from './dependencies.js';
import {
  fetchClaimProvenance,
  type ItemProvenance,
} from '../../infrastructure/graph/claim-provenance-queries.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNodes,
  committedIncidenceForNodesAt,
  type CommittedIncidence,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listStatedLinksTo,
  readStatedLinkValues,
} from '../../infrastructure/sqlite/evidence-links.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { evidenceRequestKey, idAddress, type EvidenceAddress } from '../domain/address.js';
import { utf8Bytes, type RequestBudget } from '../domain/budget.js';
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
 * The lineage is the union of what the graph still projects and what the records hold. A source
 * whose raw projection has left the graph is still the root its claim was extracted from, and an
 * answer that dropped it would report the eviction as a change in where the claim came from.
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
  /**
   * The published narrative revision this item is cited by, when the substrate can say. No
   * producer writes the citation records yet, so the honest answer is that the binding is
   * unavailable rather than that there is none.
   */
  readonly narrativeBinding: 'unavailable';
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

type DurableLineage = {
  readonly roots: readonly string[];
  readonly correction?: ItemProvenance['claimedCorrection'];
  readonly confirmation?: ItemProvenance['confirmation'];
};

function stamp(value: unknown, fallback: string | null): Date | undefined {
  const text = typeof value === 'string' ? value : (fallback ?? undefined);
  if (text === undefined) {
    return undefined;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * What the records alone say about where a node came from and what has been stated about it.
 *
 * This is the half that survives eviction: the extraction incidence names the original sources,
 * and the stated-reference chain names the correction or confirmation somebody made, both under
 * the ids they always had.
 */
function durableLineage(
  db: SqliteHandle,
  nodeId: string,
  rows: readonly CommittedIncidence[],
  at: Date | undefined,
): DurableLineage {
  const visible = listStatedLinksTo(db, nodeId).filter(
    (link) =>
      link.knownFrom !== null && (at === undefined || Date.parse(link.knownFrom) <= at.getTime()),
  );
  const latest = (kind: string): (typeof visible)[number] | undefined =>
    [...visible].reverse().find((link) => link.kind === kind);
  const corrects = latest('corrects');
  const confirms = latest('confirms');
  const correctedAt = corrects === undefined ? undefined : stamp(undefined, corrects.knownFrom);
  const values = confirms === undefined ? undefined : readStatedLinkValues(db, confirms.linkId);
  const confirmedAt = confirms === undefined ? undefined : stamp(values?.at, confirms.knownFrom);
  const by = typeof values?.by === 'string' ? values.by : undefined;
  const evidence = typeof values?.evidence === 'string' ? values.evidence : undefined;
  return {
    roots: [...new Set(rows.map((row) => row.sourceId))],
    ...(corrects?.fromId === undefined || correctedAt === undefined
      ? {}
      : { correction: { by: corrects.fromId, at: correctedAt } }),
    ...(confirms === undefined || by === undefined || confirmedAt === undefined
      ? {}
      : { confirmation: { by, at: confirmedAt, evidence: evidence ?? '' } }),
  };
}

/** The graph's reading and the records' reading, as one answer under the original identities. */
function mergeProvenance(
  found: ItemProvenance | undefined,
  durable: DurableLineage,
  maxRoots: number,
  proved: boolean,
): ItemProvenance {
  // The graph's own reading wins where it has one: it is the newer statement about a retained
  // node. The records answer where the projection no longer can.
  const confirmation = found?.confirmation ?? durable.confirmation;
  const correction = found?.claimedCorrection ?? durable.correction;
  const roots = [...new Set([...(found?.roots ?? []), ...durable.roots])].sort();
  const lineage = [...new Set([...(found?.lineage ?? []), ...durable.roots])];
  const complete = (found?.complete ?? true) && proved && roots.length <= maxRoots;
  return {
    roots: roots.slice(0, maxRoots),
    lineage,
    complete,
    ...(found?.recordedRole === undefined ? {} : { recordedRole: found.recordedRole }),
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(correction === undefined ? {} : { claimedCorrection: correction }),
  };
}

type IncidenceRead =
  | { readonly status: 'read'; readonly rows: readonly CommittedIncidence[] }
  | { readonly status: 'unavailable' };

function readIncidence(
  db: SqliteHandle,
  ids: readonly string[],
  context: CheckedReadContext,
): IncidenceRead {
  try {
    const { knownAt } = context.mode;
    return {
      status: 'read',
      rows:
        knownAt === undefined
          ? committedIncidenceForNodes(db, ids)
          : committedIncidenceForNodesAt(db, ids, knownAt),
    };
  } catch {
    return { status: 'unavailable' };
  }
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

  function record(
    address: EvidenceAddress,
    found: readonly EvidenceIssue[],
    residency: EvidenceResidency,
  ): void {
    issues.push(...found);
    results.set(evidenceRequestKey(address), evidenceResult({ address, residency, issues: found }));
  }

  for (const id of unique) {
    if (input.budget.chargeIds(1) === undefined) {
      accepted.push(id);
      continue;
    }
    record(idAddress(id), [issueOn(idAddress(id), 'ownership', 'budget_limit', false)], 'resident');
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
      record(
        idAddress(id),
        [issueOn(idAddress(id), 'interpretation_text', 'store_unavailable', true)],
        'resident',
      );
    }
    return { results, issues, dependencies };
  }

  // The ancestry the walk returned counts against the same allowance the incidence does: a
  // traversal bounded only by its own hop limit can still hand back more rows than a request
  // said it would carry.
  const walked = [...provenance.values()].reduce(
    (total, item) => total + item.roots.length + (item.lineage?.length ?? 0),
    0,
  );
  const overWalk = input.budget.chargeRelationRows(walked) !== undefined;
  const incidence = readIncidence(deps.db, accepted, input.context);
  if (incidence.status === 'unavailable') {
    for (const id of accepted) {
      record(
        idAddress(id),
        [issueOn(idAddress(id), 'ownership', 'store_unavailable', true)],
        'resident',
      );
    }
    return { results, issues, dependencies };
  }
  const overRows = input.budget.chargeRelationRows(incidence.rows.length) !== undefined;
  const byNode = new Map<string, CommittedIncidence[]>();
  for (const row of incidence.rows) {
    byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  }

  for (const id of accepted) {
    const address = idAddress(id);
    const rows = (byNode.get(id) ?? []).filter((row) => row.role === 'extraction');
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
    if (overRows || overWalk) {
      nodeIssues.push(issueOn(address, 'ownership', 'budget_limit', false));
    }
    // Nothing writes the citation records yet, so the binding is named unavailable rather than
    // reported as an item no narrative cites.
    nodeIssues.push(issueOn(address, 'narrative_revision', 'unverified_scope', false));
    if (isTimeTravel(input.context.mode)) {
      nodeIssues.push({
        address,
        field: 'ownership',
        reason: 'unsupported_history',
        historyReason: 'not_recorded',
        required: false,
      });
    }

    const durable = durableLineage(deps.db, id, rows, input.context.mode.knownAt);
    const found = provenance.get(id);
    if (found === undefined && durable.roots.length === 0) {
      const residency = residencyWithoutProjection(deps.db, id);
      nodeIssues.push(
        issueOn(
          address,
          'interpretation_text',
          residency === 'unknown-mapping' ? 'unresolved_mapping' : 'not_found',
          true,
        ),
      );
      record(address, nodeIssues, residency);
      continue;
    }

    const value: ItemMetadata = {
      provenance: mergeProvenance(found, durable, input.maxRoots, scope.status === 'verified'),
      owningSessions: overRows ? [] : sessionsOf(deps.db, rows),
      sources: overRows ? [] : durable.roots,
      unknownAttribution: scope.status !== 'verified' || overRows,
      narrativeBinding: 'unavailable',
    };
    if (input.budget.chargeMetadataBytes(utf8Bytes(JSON.stringify(value))) !== undefined) {
      nodeIssues.push(issueOn(address, 'ownership', 'budget_limit', true));
      record(address, nodeIssues, 'resident');
      continue;
    }
    issues.push(...nodeIssues);
    results.set(
      evidenceRequestKey(address),
      evidenceResult({ address, residency: 'resident', issues: nodeIssues, value }),
    );
  }

  return { results, issues, dependencies };
}
