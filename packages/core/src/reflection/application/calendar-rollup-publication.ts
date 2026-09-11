import { z } from 'zod';

import {
  acknowledgeLegacyCoverage,
  discardLegacyCoverage,
  legacyCoverageScopes,
  prepareLegacyCoverage,
  type LegacyCoverageWrite,
} from './legacy-coverage.js';
import { rollupOwnership } from './rollup-ownership.js';
import { rollupProperties } from './rollup-write.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import {
  revalidateNarrativeRepresentations,
  type NarrativeRepresentation,
} from '../../evidence/application/narrative-representation.js';
import {
  supersedeInTransaction,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import {
  LEGACY_NARRATIVE_LIMITS,
  readLegacyCoverageEdges,
} from '../../infrastructure/graph/legacy-narrative-input.js';
import { closeNarrativeEdgesInTransaction } from '../../infrastructure/graph/narrative-edge-queries.js';
import { readNarrativeFamilyIdentities } from '../../infrastructure/graph/narrative-families.js';
import { SUMMARIZED_BY_TYPE } from '../../infrastructure/graph/narrative-queries.js';
import {
  readOpenNarratives,
  readRollupLineage,
  readWindowMembers,
  readWindowRollups,
} from '../../infrastructure/graph/narrative-rollup-queries.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationContext } from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';
import { ROLLUP_SCOPES } from '../domain/rollup.js';

/**
 * The legacy calendar summary's own publication.
 *
 * What this replaces wrote the node, its member edges and every supersession through the ordinary
 * graph adapters, outside any guard, after a family reading it had already released. The family
 * could move between the reading and the write, and a day that cut over in that gap was published
 * over and absorbed anyway. Two readings do not fix that: what fixes it is the write being inside
 * the same guarded operation as the recheck.
 *
 * So the pass now decides and generates as it always did, and then asks the coordinator to land
 * the result. The guard is held for the recheck and the graph effects only, never across the
 * synthesis. Under it the handler re-derives the identities from the graph, rereads the policy
 * through the adapter's own revalidation, and runs the SAME ownership predicate the pass ran. A
 * cutover acknowledged in between moves the family-selection scope this publication depends on,
 * so the precondition fails and nothing is written.
 *
 * It is its own kind rather than a variant of the overview publication: that family owns a
 * manifest, a revision number and a membership fence, and this one is the temporary graph-only
 * writer the cutover exists to retire.
 */

export const CALENDAR_ROLLUP_EFFECT = 'calendar_rollup_published';

const ROLLUP_SIGNALS = ['compression'];
const ROLLUP_PROVENANCE = ['narrative_rollup'];

/** Identities one publication proves, matched to what one policy reread may name. */
export const CALENDAR_ROLLUP_PROOF_LIMIT = 256;

const Dependency = z.strictObject({
  kind: z.literal('relation_scope'),
  id: z.string().min(1),
  scope: z.string().min(1),
  version: z.string().min(1),
});

const Payload = z.strictObject({
  /** `publish` writes the summary and absorbs; `repair` only finishes a closure left half-done. */
  mode: z.enum(['publish', 'repair']),
  scope: z.enum(ROLLUP_SCOPES),
  windowKey: z.string().min(1),
  nodeId: z.string().min(1),
  version: z.number().int().nonnegative(),
  coverageKey: z.string().min(1),
  /** What the window covers. Written as citations and member edges in `publish` mode. */
  memberIds: z.array(z.string().min(1)).max(CALENDAR_ROLLUP_PROOF_LIMIT),
  /** The complete supersession set: prior versions of this window, and what it absorbs. */
  closes: z.array(z.string().min(1)).max(CALENDAR_ROLLUP_PROOF_LIMIT),
  summary: z.string(),
  narrative: z.string(),
  citations: z.array(z.string()),
  sentenceCount: z.number().int().nonnegative(),
  spanStart: z.string().nullable(),
  spanEnd: z.string().nullable(),
  occurredAt: z.string().min(1),
  /** The calendar bounds of the window, so the guard can ask what it holds now. */
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  memberScope: z.string().min(1),
  /** Every owned version the window carried when the decision was taken. */
  expectedHeads: z.array(z.string().min(1)).max(CALENDAR_ROLLUP_PROOF_LIMIT),
  /** Which closure targets were standing then, so a peer that closed one is not overwritten. */
  openCloses: z.array(z.string().min(1)).max(CALENDAR_ROLLUP_PROOF_LIMIT),
  coverageEpoch: z.string().min(1),
  /** Every identity the pass proved owned, and the selection scopes that proof rests on. */
  ownedIds: z.array(z.string().min(1)).max(CALENDAR_ROLLUP_PROOF_LIMIT),
  dependencies: z.array(Dependency).max(CALENDAR_ROLLUP_PROOF_LIMIT),
});

const CoverageEdge = z.strictObject({
  sourceId: z.string().min(1),
  narrativeId: z.string().min(1),
  relationId: z.string().min(1),
  sourceIsEpisode: z.boolean(),
  clocks: z.record(z.string(), z.string()),
});

const Data = Payload.extend({
  observedAt: z.string().min(1),
  /** Raw-source coverage this close retires, read under the guard with its own clocks. */
  closedCoverage: z.array(CoverageEdge).max(LEGACY_NARRATIVE_LIMITS.closingEdges),
  /** Narrative-to-narrative membership the same close ends. Not source incidence. */
  closedMembership: z.array(CoverageEdge).max(LEGACY_NARRATIVE_LIMITS.closingEdges),
  /** The closure population ran past what one publication may record. */
  closureBounded: z.boolean(),
});
const Result = z.strictObject({
  nodeId: z.string().min(1),
  created: z.boolean(),
  absorbed: z.number().int().nonnegative(),
  retiredCoverage: z.number().int().nonnegative(),
});

type CalendarData = z.infer<typeof Data>;

/** What this publication would write over, absorb or close, which is what it has to own. */
function population(data: CalendarData): readonly string[] {
  return [...new Set([...data.memberIds, ...data.closes])].filter((id) => id !== data.nodeId);
}

/** The raw-source coverage this close retires, kept apart from narrative membership. */
function coverage(data: CalendarData): LegacyCoverageWrite {
  return {
    sourceIds: [],
    nodeId: data.nodeId,
    create: false,
    closed: data.closedCoverage,
    observedAt: data.observedAt,
    occurredAt: data.occurredAt,
  };
}

function edgeKey(edges: readonly z.infer<typeof CoverageEdge>[]): string {
  return JSON.stringify([...edges].sort((a, b) => a.relationId.localeCompare(b.relationId)));
}

function sortedKey(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
}

/**
 * The same ownership question, asked again inside the guard against a fresh reading, over the
 * window as it stands now rather than over the list the caller happened to bring.
 *
 * Identities come from the graph transaction this publication holds, and the policy comes from
 * the adapter's own bounded revalidation, which reads SQLite and nothing else. Neither half is
 * carried in the intent: an answer serialized before the synthesis is exactly the stale reading
 * this conversion exists to stop trusting.
 *
 * Re-proving the caller's ids is necessary and not sufficient. A peer that published this window
 * while this attempt was generating leaves every id here still owned, and the summary about to be
 * written still claims a window it no longer covers. So the window's membership and its owned
 * versions are compared as SETS against what the decision was taken over, and a difference defers.
 */
async function guardHolds(
  context: PublicationContext,
  data: CalendarData,
): Promise<string | undefined> {
  if (data.closureBounded) {
    return 'legacy_closure_bound';
  }
  const asked = population(data);
  if (asked.some((id) => !data.ownedIds.includes(id))) {
    return 'calendar_population_unproved';
  }
  const heads = await readWindowRollups(context.graph, data.scope, data.windowKey);
  const candidates = [...new Set([...asked, ...heads.map((head) => head.id)])];
  if (candidates.length === 0) {
    return undefined;
  }
  const vantage = checkPresentCoverage(context.db, context.now);
  if (vantage.status !== 'checked') {
    return 'coverage_unavailable';
  }
  const rows = await readRollupLineage(context.graph, candidates, CALENDAR_ROLLUP_PROOF_LIMIT);
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
  if (identities.size > CALENDAR_ROLLUP_PROOF_LIMIT) {
    return 'legacy_family_scan_bound';
  }
  const known = await readNarrativeFamilyIdentities(context.graph, [...identities]);
  if (known.length !== identities.size) {
    return 'legacy_identity_missing';
  }
  // Seeded with the immutable identity alone. Every one of them is reread below, and the reread
  // replaces the seed, so no value here is ever the answer this check reads.
  const seeded = new Map<string, NarrativeRepresentation>(
    known.map((identity) => [
      identity.nodeId,
      {
        family: identity.family,
        sessions: [],
        selection: 'unknown' as const,
        publication: 'unknown' as const,
        identity,
      },
    ]),
  );
  const reading = revalidateNarrativeRepresentations(context.db, seeded, vantage.context);
  if (known.some((identity) => !reading.rereadIds.has(identity.nodeId))) {
    return 'legacy_family_unread';
  }
  for (const id of asked) {
    const held = rollupOwnership(id, reading, lineage);
    if (held.status !== 'owned') {
      return held.status === 'foreign' ? 'legacy_family_foreign' : held.reason;
    }
  }
  const owned: string[] = [];
  for (const head of heads) {
    const held = rollupOwnership(head.id, reading, lineage);
    if (held.status === 'foreign') {
      // Another family's node standing in the same window. It was never a version here, so it
      // cannot move this family's version set either.
      continue;
    }
    if (held.status !== 'owned') {
      return 'window_head_unproved';
    }
    owned.push(head.id);
  }
  if (sortedKey(owned) !== sortedKey(data.expectedHeads)) {
    return 'window_head_moved';
  }
  const members = await readWindowMembers(context.graph, {
    scope: data.memberScope,
    rollupScope: data.scope,
    start: new Date(data.windowStart),
    end: new Date(data.windowEnd),
    limit: CALENDAR_ROLLUP_PROOF_LIMIT + 1,
  });
  if (members.length > CALENDAR_ROLLUP_PROOF_LIMIT) {
    return 'window_membership_bound';
  }
  if (sortedKey(members) !== sortedKey(data.memberIds)) {
    return 'window_membership_moved';
  }
  const open = await readOpenNarratives(context.graph, data.closes);
  if (sortedKey(open) !== sortedKey(data.openCloses)) {
    return 'closure_population_moved';
  }
  const closing = await readLegacyCoverageEdges(context.graph, data.closes);
  if (
    edgeKey(closing.filter((edge) => edge.sourceIsEpisode)) !== edgeKey(data.closedCoverage) ||
    edgeKey(closing.filter((edge) => !edge.sourceIsEpisode)) !== edgeKey(data.closedMembership)
  ) {
    return 'legacy_closure_changed';
  }
  return undefined;
}

export const calendarRollupPublication = new PublicationOperation({
  kind: 'calendar_rollup_publish',
  effectKinds: [CALENDAR_ROLLUP_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    if (readCurrentCoverageContract(context.db) === undefined) {
      throw new Error('a calendar summary cannot publish before the coverage registry exists');
    }
    // The edges this close ends, with the relationship identities and clocks they already carry,
    // read under the guard rather than reconstructed. An episode-sourced edge is raw-source
    // coverage and owns a durable record; narrative membership is neither and stays apart.
    const edges = await readLegacyCoverageEdges(context.graph, payload.closes);
    const bound = LEGACY_NARRATIVE_LIMITS.closingEdges;
    const data: CalendarData = {
      ...payload,
      observedAt: context.now.toISOString(),
      closedCoverage: edges.filter((edge) => edge.sourceIsEpisode).slice(0, bound),
      closedMembership: edges.filter((edge) => !edge.sourceIsEpisode).slice(0, bound),
      closureBounded: edges.length > bound,
    };
    return {
      data,
      expected: {
        coverageEpoch: payload.coverageEpoch,
        // The family selections the pass read. A cutover advances one of these, so an
        // acknowledgment in the gap leaves this revision stale and nothing is written.
        evidence: buildEvidenceRevision([...payload.dependencies]),
        sources: [],
        heads: [],
      },
      scopes: legacyCoverageScopes(coverage(data)).map((entry) => ({
        kind: 'relation_scope' as const,
        id: entry.endpointId,
        scope: entry.relationClass,
      })),
      effects: [
        {
          kind: CALENDAR_ROLLUP_EFFECT,
          detail: { scope: payload.scope, windowKey: payload.windowKey, mode: payload.mode },
        },
      ],
    };
  },
  async check(context, data, expected) {
    if (verifyEvidenceRevision(context.db, expected.evidence).status !== 'current') {
      return { status: 'deferred', reason: 'legacy_family_revision_changed' };
    }
    const refusal = await guardHolds(context, data);
    return refusal === undefined ? { status: 'valid' } : { status: 'deferred', reason: refusal };
  },
  async applyGraph(context, data) {
    const now = new Date(data.observedAt);
    const occurredAt = new Date(data.occurredAt);
    if (data.mode === 'publish') {
      await writeStampedDerivedNodeInTransaction(context.graph, {
        label: 'Narrative',
        id: data.nodeId,
        now,
        occurredAt,
        properties: rollupProperties({
          scope: data.scope,
          windowKey: data.windowKey,
          version: data.version,
          coverageKey: data.coverageKey,
          memberIds: data.memberIds,
          summary: data.summary,
          narrative: data.narrative,
          citations: data.citations,
          sentenceCount: data.sentenceCount,
          ...(data.spanStart === null ? {} : { spanStart: new Date(data.spanStart) }),
          ...(data.spanEnd === null ? {} : { spanEnd: new Date(data.spanEnd) }),
        }),
      });
      for (const memberId of data.memberIds) {
        await upsertEdgeInTransaction(context.graph, {
          type: SUMMARIZED_BY_TYPE,
          sourceId: memberId,
          targetId: data.nodeId,
          strength: 1,
          confidence: 1,
          signals: ROLLUP_SIGNALS,
          provenance: ROLLUP_PROVENANCE,
          count: 0,
          now,
        });
      }
    }
    const absorbed = data.closes.filter((id) => id !== data.nodeId);
    for (const oldId of absorbed) {
      await supersedeInTransaction(context.graph, {
        oldId,
        newId: data.nodeId,
        now,
        validUntil: occurredAt,
        signals: ROLLUP_SIGNALS,
        provenance: ROLLUP_PROVENANCE,
      });
    }
    if (absorbed.length > 0) {
      await closeNarrativeEdgesInTransaction(context.graph, {
        narrativeIds: absorbed,
        validUntil: occurredAt,
        txUntil: now,
      });
    }
    return {
      nodeId: data.nodeId,
      created: data.mode === 'publish',
      absorbed: absorbed.length,
      retiredCoverage: data.closedCoverage.length,
    };
  },
  prepareSqlite(context, data) {
    // Prepared, not committed: these versions become visible with the acknowledgment, so an
    // interrupted attempt leaves the durable record exactly where it was.
    prepareLegacyCoverage(context.db, coverage(data), context.operationId);
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    acknowledgeLegacyCoverage(
      context.db,
      coverage(data),
      context.operationId,
      context.knownFrom,
      context.observedAckAt,
    );
    return undefined;
  },
  discardSqlite(context, data) {
    discardLegacyCoverage(context.db, coverage(data), context.operationId);
    return undefined;
  },
});
