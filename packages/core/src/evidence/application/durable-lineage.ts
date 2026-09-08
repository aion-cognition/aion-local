import { readRelationScope } from './dependencies.js';
import { walkLineage } from './lineage-walk.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { CommittedIncidence } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  countStatedLinksTo,
  listStatedLinksTo,
  readStatedLinkValues,
} from '../../infrastructure/sqlite/evidence-links.js';
import { readCitationsOf } from '../../infrastructure/sqlite/narrative-revisions.js';
import type { RequestBudget } from '../domain/budget.js';
import { NARRATIVE_SCOPES } from '../domain/scopes.js';

/**
 * What the records alone say about where a node came from and what has been stated about it.
 *
 * This is the half that survives eviction, and it is a walk rather than a lookup. The sources a
 * node was extracted from are where the chain starts, not where it ends: an intermediate capture
 * that derived from something else is not a terminal root merely because incidence names it. A
 * branch ends where a source states no parent and a census proves that emptiness; a branch that
 * loops, runs past the hop bound, or rests on an uncounted scope ends the walk short and says so.
 */

export type StatedCorrection = { readonly by: string; readonly at: Date };
export type StatedConfirmation = StatedCorrection & { readonly evidence: string };

export type DurableLineage = {
  readonly roots: readonly string[];
  readonly lineage: readonly string[];
  /** False when a branch looped, hit the bound, or rested on a scope nobody counted. */
  readonly complete: boolean;
  readonly correction?: StatedCorrection;
  readonly confirmation?: StatedConfirmation;
  /** The published revisions citing this node at the vantage asked for. */
  readonly citedBy: readonly string[];
  /** Whether the citation scope has been counted, which is what makes an empty set an answer. */
  readonly citationsProved: boolean;
  /** Every scope this reading consulted, for the revision a writer fences on. */
  readonly dependencies: readonly EvidenceDependency[];
};

const CITATION_SCOPE = NARRATIVE_SCOPES[0];

function visibleAt(knownFrom: string | null, at: Date | undefined): boolean {
  return knownFrom !== null && (at === undefined || Date.parse(knownFrom) <= at.getTime());
}

function stamp(value: unknown, fallback: string | null): Date | undefined {
  const text = typeof value === 'string' ? value : (fallback ?? undefined);
  if (text === undefined) {
    return undefined;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The citation set at this vantage, and whether anyone has counted the scope that holds it.
 *
 * The proof is the citation scope's own. Borrowing the extraction census would answer "nothing
 * cites this" from a count of something else entirely.
 */
function citationsOf(
  db: SqliteHandle,
  nodeId: string,
  at: Date | undefined,
  dependencies: EvidenceDependency[],
): { readonly ids: readonly string[]; readonly proved: boolean } {
  const cited = readCitationsOf(db, nodeId, at);
  const scope = readRelationScope(db, {
    kind: 'node',
    endpointId: nodeId,
    scope: CITATION_SCOPE,
    empty: cited.length === 0,
  });
  if (scope.status === 'verified') {
    dependencies.push(scope.dependency);
  }
  return {
    ids: cited.map((citation) => citation.narrativeNodeId),
    proved: scope.status === 'verified',
  };
}

export function durableLineage(
  db: SqliteHandle,
  nodeId: string,
  rows: readonly CommittedIncidence[],
  at: Date | undefined,
  budget?: RequestBudget,
): DurableLineage {
  const walk = walkLineage(
    db,
    rows.map((row) => row.sourceId),
    at,
    budget,
  );
  const dependencies = [...walk.dependencies];
  // What has been stated about this node is charged the same way its ancestry is.
  const declared = countStatedLinksTo(db, nodeId);
  const affordable = budget?.chargeRelationRows(declared) === undefined;
  const stated = affordable
    ? listStatedLinksTo(db, nodeId).filter((link) => visibleAt(link.knownFrom, at))
    : [];
  const latest = (kind: string): (typeof stated)[number] | undefined =>
    [...stated].reverse().find((link) => link.kind === kind);
  const corrects = latest('corrects');
  const confirms = latest('confirms');
  const correctedAt = corrects === undefined ? undefined : stamp(undefined, corrects.knownFrom);
  const values = confirms === undefined ? undefined : readStatedLinkValues(db, confirms.linkId);
  // The writer records the moment the confirmation was made as `occurredAt`. Publication time is
  // when the substrate learned of it, which is a different claim about a different clock.
  const confirmedAt =
    confirms === undefined ? undefined : stamp(values?.occurredAt, confirms.knownFrom);
  const by = typeof values?.by === 'string' ? values.by : undefined;
  const evidence = typeof values?.evidence === 'string' ? values.evidence : undefined;
  const citations = citationsOf(db, nodeId, at, dependencies);
  return {
    roots: walk.roots,
    lineage: walk.lineage,
    complete: walk.complete && affordable,
    citedBy: citations.ids,
    citationsProved: citations.proved,
    dependencies,
    ...(corrects?.fromId === undefined || correctedAt === undefined
      ? {}
      : { correction: { by: corrects.fromId, at: correctedAt } }),
    ...(confirms === undefined || by === undefined || confirmedAt === undefined
      ? {}
      : { confirmation: { by, at: confirmedAt, evidence: evidence ?? '' } }),
  };
}
