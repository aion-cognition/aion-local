import type { Driver } from 'neo4j-driver';

import { readRelationScope } from './dependencies.js';
import { durableLineage, type DurableLineage } from './durable-lineage.js';
import {
  readNarrativeRepresentations,
  type NarrativeRepresentation,
} from './narrative-representation.js';
import { ownershipIncidence, readOwnership } from './ownership.js';
import {
  fetchClaimProvenance,
  type ItemProvenance,
} from '../../infrastructure/graph/claim-provenance-queries.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { CommittedIncidence } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { evidenceRequestKey, idAddress, type EvidenceAddress } from '../domain/address.js';
import { utf8Bytes, type RequestBudget } from '../domain/budget.js';
import { OWNERSHIP_SCOPES, type OwnershipSummary } from '../domain/ownership.js';
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
  /** The caller-independent summary the serving layer derives its own/other verdict from. */
  readonly ownership: OwnershipSummary;
  /**
   * The published revisions citing this item. An unproved citation census answers unavailable
   * rather than claiming no revision cites it.
   */
  readonly narrativeBinding: NarrativeBinding;
  /** Explicit inspection keeps the node; default serving follows this separate family choice. */
  readonly representation?: NarrativeRepresentation;
};

/**
 * The committed citation population, with unknown census kept separate from verified empty.
 */
export type NarrativeBinding =
  | { readonly status: 'cited'; readonly revisionIds: readonly string[] }
  | { readonly status: 'none' }
  | { readonly status: 'unavailable' };

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

const OWNERSHIP_ROLES = new Set<string>(OWNERSHIP_SCOPES.map((entry) => entry.role));

function issueOn(
  address: EvidenceAddress,
  field: EvidenceIssue['field'],
  reason: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  required: boolean,
): EvidenceIssue {
  return { address, field, reason, required };
}

/**
 * What the citation records say. An empty set is only "cited by nothing" where the citation
 * scope itself has been counted; otherwise nobody has looked, and a count of some other scope
 * answers a different question.
 */
function bindingOf(durable: DurableLineage): NarrativeBinding {
  const cited = durable.citedBy;
  if (cited.length > 0) {
    return { status: 'cited', revisionIds: cited };
  }
  return durable.citationsProved ? { status: 'none' } : { status: 'unavailable' };
}

/** A retained node the graph does not hold, read through the records that outlive its projection. */
function residencyWithoutProjection(db: SqliteHandle, id: string): EvidenceResidency {
  if (readSourceRecord(db, id) === undefined) {
    return 'unknown-mapping';
  }
  return readSourceResidency(db, id)?.state ?? 'resident';
}

type IncidenceRead =
  | { readonly status: 'read'; readonly rows: readonly CommittedIncidence[] }
  | { readonly status: 'unavailable' };

/**
 * The graph's reading and the records' reading, as one answer under the original identities.
 * The graph's own statement about a retained node is the newer one where it has one; the records
 * answer where the projection no longer can, and completeness is the conjunction of both.
 */
function mergeProvenance(
  found: ItemProvenance | undefined,
  durable: DurableLineage,
  maxRoots: number,
  proved: boolean,
): ItemProvenance {
  const confirmation = found?.confirmation ?? durable.confirmation;
  const correction = found?.claimedCorrection ?? durable.correction;
  const roots = [...new Set([...(found?.roots ?? []), ...durable.roots])].sort();
  const lineage = [...new Set([...(found?.lineage ?? []), ...durable.lineage])];
  const complete =
    (found?.complete ?? true) && proved && durable.complete && roots.length <= maxRoots;
  return {
    roots: roots.slice(0, maxRoots),
    lineage,
    complete,
    ...(found?.recordedRole === undefined ? {} : { recordedRole: found.recordedRole }),
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(correction === undefined ? {} : { claimedCorrection: correction }),
  };
}

function readIncidence(
  db: SqliteHandle,
  ids: readonly string[],
  context: CheckedReadContext,
): IncidenceRead {
  try {
    return { status: 'read', rows: ownershipIncidence(db, ids, context) };
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
  const representations = await readNarrativeRepresentations(
    deps,
    accepted,
    input.context,
    input.budget,
  );
  dependencies.push(...representations.dependencies);

  for (const id of accepted) {
    const address = idAddress(id);
    if (representations.values.get(id)?.knownAtVantage === false) {
      record(address, [issueOn(address, 'narrative_revision', 'not_found', true)], 'resident');
      continue;
    }
    try {
      readOne(
        deps,
        input,
        id,
        byNode.get(id) ?? [],
        overRows || overWalk,
        provenance,
        {
          record,
          results,
          issues,
          dependencies,
        },
        representations.values.get(id),
        representations.issues.filter(
          (issue) => issue.address.kind === 'id' && issue.address.id === id,
        ),
      );
    } catch {
      // Every store this read consults can be unavailable, and each one answers the same way:
      // a named result for the address that could not be read, never a rejected batch.
      record(address, [issueOn(address, 'ownership', 'store_unavailable', true)], 'resident');
    }
  }

  return { results, issues, dependencies };
}

/**
 * The ownership derivation with its consulted scopes and its unplaced axes folded into the
 * answer. The state chains behind an attribution decide the verdict, so a revision that omitted
 * them would go on standing after a forget changed the set.
 */
function readInto(
  db: SqliteHandle,
  id: string,
  rows: readonly CommittedIncidence[],
  context: CheckedReadContext,
  censusEstablished: boolean,
  sink: {
    readonly address: EvidenceAddress;
    readonly issues: EvidenceIssue[];
    readonly dependencies: EvidenceDependency[];
  },
): OwnershipSummary {
  const reading = readOwnership(db, id, rows, context, { censusEstablished });
  sink.dependencies.push(...reading.dependencies);
  // A census proves how many relations there are, never what their missing dates were. A row the
  // recorded proof could not place is withheld and named here, so nothing reports the remainder
  // as the whole set for the moment asked about.
  for (const axis of new Set(reading.unplaced)) {
    sink.issues.push({
      address: sink.address,
      field: axis === 'world' ? 'link_interval' : 'reference_history',
      reason: 'unsupported_history',
      historyReason: 'not_recorded',
      required: false,
    });
  }
  return reading.summary;
}

type MetadataSink = {
  readonly record: (
    address: EvidenceAddress,
    found: readonly EvidenceIssue[],
    residency: EvidenceResidency,
  ) => void;
  readonly results: Map<string, EvidenceResult<ItemMetadata>>;
  readonly issues: EvidenceIssue[];
  readonly dependencies: EvidenceDependency[];
};

/** One candidate's metadata, or the reason its stores could not answer for it. */
function readOne(
  deps: MetadataDeps,
  input: MetadataInput,
  id: string,
  incidenceOf: readonly CommittedIncidence[],
  overRows: boolean,
  provenance: ReadonlyMap<string, ItemProvenance>,
  sink: MetadataSink,
  representation?: NarrativeRepresentation,
  representationIssues: readonly EvidenceIssue[] = [],
): void {
  const { record, results, issues, dependencies } = sink;
  {
    const address = idAddress(id);
    // Witness lineage and ownership are different questions. A claim's roots are the sources it
    // was extracted from; the sessions that carry it are every source that holds it under any of
    // the roles its writers record. Promoting a mentioning source to a root would invent an
    // independent origin, and filtering ownership to extraction loses the entity's owners.
    const rows = incidenceOf.filter((row) => row.role === 'extraction');
    const owners = incidenceOf.filter((row) => OWNERSHIP_ROLES.has(row.role));
    const nodeIssues: EvidenceIssue[] = [...representationIssues];

    let attributionProved = true;
    for (const { role, direction } of OWNERSHIP_SCOPES) {
      const scope = readRelationScope(deps.db, {
        kind: 'node',
        endpointId: id,
        scope: durableRoleScope(role, direction),
        empty: incidenceOf.every((row) => row.role !== role),
      });
      if (scope.status === 'verified') {
        dependencies.push(scope.dependency);
      } else {
        attributionProved = false;
      }
    }
    const scope = readRelationScope(deps.db, {
      kind: 'node',
      endpointId: id,
      scope: durableRoleScope('extraction', 'out'),
      empty: rows.length === 0,
    });
    if (!attributionProved) {
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

    if (isTimeTravel(input.context.mode)) {
      nodeIssues.push({
        address,
        field: 'ownership',
        reason: 'unsupported_history',
        historyReason: 'not_recorded',
        required: false,
      });
    }

    const durable = durableLineage(deps.db, id, rows, input.context.mode.knownAt, input.budget);
    // Every scope the walk consulted travels with the answer, so a writer fencing on this
    // revision fences on the parents and citations the roots were derived through.
    dependencies.push(...durable.dependencies);
    // The citation records answer for themselves. Until a producer writes them the honest answer
    // is that the binding is unavailable, and it becomes an answer the moment they exist.
    const binding = bindingOf(durable);
    if (binding.status === 'unavailable') {
      nodeIssues.push(issueOn(address, 'narrative_revision', 'unverified_scope', false));
    }
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
      return;
    }

    // One derivation for the stored projection and for this answer, so what a nomination reads
    // off a node and what a serving read decides cannot disagree about whose memory it is.
    //
    // A population the allowance already rejected is not derived at all. Reading each owner's
    // records and then discarding the answer spends the substrate on a set nobody may use.
    const ownership: OwnershipSummary = overRows
      ? { sessions: [], unknownAttribution: true, censusEstablished: attributionProved }
      : readInto(deps.db, id, incidenceOf, input.context, attributionProved, {
          address,
          issues: nodeIssues,
          dependencies,
        });
    const value: ItemMetadata = {
      provenance: mergeProvenance(found, durable, input.maxRoots, scope.status === 'verified'),
      owningSessions: ownership.sessions,
      sources: overRows ? [] : [...new Set(owners.map((row) => row.sourceId))],
      unknownAttribution: ownership.unknownAttribution || !attributionProved,
      ownership,
      narrativeBinding: binding,
      ...(representation === undefined ? {} : { representation }),
    };
    if (input.budget.chargeMetadataBytes(utf8Bytes(JSON.stringify(value))) !== undefined) {
      nodeIssues.push(issueOn(address, 'ownership', 'budget_limit', true));
      record(address, nodeIssues, 'resident');
      return;
    }
    issues.push(...nodeIssues);
    results.set(
      evidenceRequestKey(address),
      evidenceResult({ address, residency: 'resident', issues: nodeIssues, value }),
    );
  }
}
