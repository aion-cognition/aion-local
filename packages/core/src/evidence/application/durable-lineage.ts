import { readRelationScope } from './dependencies.js';
import { MAX_LINEAGE_HOPS } from '../../infrastructure/graph/claim-lineage-queries.js';
import type { CommittedIncidence } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listStatedLinks,
  listStatedLinksTo,
  readStatedLinkValues,
} from '../../infrastructure/sqlite/evidence-links.js';
import { readCitationsOf } from '../../infrastructure/sqlite/narrative-revisions.js';
import { durableRoleScope } from '../domain/scopes.js';

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
  /** The published revisions citing this node, or nothing when the records cannot say. */
  readonly citedBy?: readonly string[];
};

/** The kind a derivation is recorded under, and the endpoints it may name. */
const DERIVATION = 'derived_from';

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

type Walk = {
  readonly roots: readonly string[];
  readonly lineage: readonly string[];
  readonly complete: boolean;
};

/** The bounded parent walk over the stated-derivation records, from one node's own sources. */
function walkParents(db: SqliteHandle, sourceIds: readonly string[], at: Date | undefined): Walk {
  const roots = new Set<string>();
  const lineage = new Set<string>(sourceIds);
  let complete = true;
  let frontier = [...new Set(sourceIds)];
  const seen = new Set<string>(frontier);

  for (let hop = 0; hop <= MAX_LINEAGE_HOPS && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const sourceId of frontier) {
      const parents = listStatedLinks(db, sourceId)
        .filter((link) => link.kind === DERIVATION && visibleAt(link.knownFrom, at))
        .map((link) => link.toId);
      const scope = readRelationScope(db, {
        kind: 'source',
        endpointId: sourceId,
        scope: durableRoleScope('stated_derivation', 'out'),
        empty: parents.length === 0,
      });
      if (scope.status !== 'verified') {
        // Nobody counted what this source states it came from, so its silence is not an end.
        complete = false;
        continue;
      }
      if (parents.length === 0) {
        roots.add(sourceId);
        continue;
      }
      for (const parent of parents) {
        lineage.add(parent);
        if (seen.has(parent)) {
          // A branch back onto its own path never ends, so it names no root and the answer is
          // reported short.
          complete = false;
          continue;
        }
        seen.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
    if (frontier.length > 0 && hop === MAX_LINEAGE_HOPS) {
      complete = false;
    }
  }
  return { roots: [...roots].sort(), lineage: [...lineage], complete };
}

export function durableLineage(
  db: SqliteHandle,
  nodeId: string,
  rows: readonly CommittedIncidence[],
  at: Date | undefined,
): DurableLineage {
  const walk = walkParents(
    db,
    rows.map((row) => row.sourceId),
    at,
  );
  const stated = listStatedLinksTo(db, nodeId).filter((link) => visibleAt(link.knownFrom, at));
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
  const citations = readCitationsOf(db, nodeId).map((citation) => citation.narrativeNodeId);
  return {
    roots: walk.roots,
    lineage: walk.lineage,
    complete: walk.complete,
    citedBy: citations,
    ...(corrects?.fromId === undefined || correctedAt === undefined
      ? {}
      : { correction: { by: corrects.fromId, at: correctedAt } }),
    ...(confirms === undefined || by === undefined || confirmedAt === undefined
      ? {}
      : { confirmation: { by, at: confirmedAt, evidence: evidence ?? '' } }),
  };
}
