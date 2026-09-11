import { z } from 'zod';

import { LEGACY_HEAD_LIMIT } from './family-cutover.js';
import {
  acknowledgeFamilyAdvance,
  discardFamilyAdvance,
  FAMILY_SELECTION_SCOPE,
  prepareFamilyAdvance,
} from './family-fence.js';
import {
  acknowledgeLegacyCoverage,
  discardLegacyCoverage,
  legacyCoverageScopes,
  prepareLegacyCoverage,
  type LegacyCoverageWrite,
} from './legacy-coverage.js';
import { closeSupersededInTransaction, writeNarrativeInTransaction } from './narrative-write.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import {
  LEGACY_NARRATIVE_LIMITS,
  readLegacyCoverageEdges,
  readLegacyNarrativeInputs,
} from '../../infrastructure/graph/legacy-narrative-input.js';
import {
  readLegacyHeads,
  readNarrativeFamilyIdentities,
} from '../../infrastructure/graph/narrative-families.js';
import { presentNodeIds } from '../../infrastructure/graph/projection-presence.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import {
  acknowledgeLegacyNarrativeBirth,
  readLegacyNarrative,
  recordLegacyNarrative,
} from '../../infrastructure/sqlite/legacy-narratives.js';
import { legacyInputDigest } from '../domain/legacy-narrative-fence.js';
import { coverageKey } from '../domain/narrative.js';

const Fence = z.strictObject({
  familyVersion: z.number().int().positive(),
  familyDependency: z.strictObject({
    kind: z.literal('relation_scope'),
    id: z.string().min(1),
    scope: z.literal(FAMILY_SELECTION_SCOPE),
    version: z.string().min(1),
  }),
  heads: z.array(z.string().min(1)).max(LEGACY_HEAD_LIMIT),
  coverageEpoch: z.string().min(1),
  inputDigest: z.string().min(1),
  includeExtracted: z.boolean(),
});
const Payload = z.strictObject({
  mode: z.enum(['publish', 'repair']),
  sessionId: z.string().min(1),
  nodeId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1).max(LEGACY_NARRATIVE_LIMITS.episodes),
  coverageKey: z.string().min(1),
  version: z.number().int().nonnegative(),
  summary: z.string(),
  narrative: z.string(),
  citations: z.array(z.string()).max(LEGACY_NARRATIVE_LIMITS.episodes),
  kept: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  spanStart: z.string().nullable(),
  spanEnd: z.string().nullable(),
  occurredAt: z.string(),
  readAt: z.string(),
  fence: Fence,
});
const CoverageEdge = z.strictObject({
  sourceId: z.string(),
  narrativeId: z.string(),
  relationId: z.string(),
  sourceIsEpisode: z.boolean(),
  clocks: z.record(z.string(), z.string()),
});
const Data = Payload.extend({
  closes: z.array(z.string()),
  closedEdges: z.array(CoverageEdge),
  observedAt: z.string(),
});
const Result = z.strictObject({
  nodeId: z.string(),
  created: z.boolean(),
  closed: z.number().int().nonnegative(),
});

function coverage(data: z.infer<typeof Data>): LegacyCoverageWrite {
  return {
    sourceIds: data.sourceIds,
    nodeId: data.nodeId,
    create: data.mode === 'publish',
    closed: data.closedEdges,
    observedAt: data.observedAt,
    occurredAt: data.occurredAt,
  };
}

/** The temporary whole-session writer has no route around the family and publication fences. */
export const legacyNarrativePublication = new PublicationOperation({
  kind: 'legacy_narrative_publish',
  effectKinds: ['legacy_narrative_published'],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    const closes = payload.fence.heads.filter((id) => id !== payload.nodeId);
    const closedEdges = await readLegacyCoverageEdges(context.graph, closes);
    const data = {
      ...payload,
      closes,
      closedEdges: [...closedEdges],
      observedAt: context.now.toISOString(),
    };
    return {
      data,
      expected: {
        coverageEpoch: payload.fence.coverageEpoch,
        evidence: buildEvidenceRevision([payload.fence.familyDependency]),
        sources: [],
        heads: [],
      },
      scopes: [
        { kind: 'relation_scope', id: payload.sessionId, scope: FAMILY_SELECTION_SCOPE },
        ...legacyCoverageScopes(coverage(data)).map((entry) => ({
          kind: 'relation_scope' as const,
          id: entry.endpointId,
          scope: entry.relationClass,
        })),
      ],
      effects: [
        {
          kind: 'legacy_narrative_published',
          detail: { sessionId: payload.sessionId, narrativeId: payload.nodeId },
        },
      ],
    };
  },
  async check(context, data, expected) {
    const selected = readFamilySelection(context.db, data.sessionId);
    if (
      selected?.family !== 'legacy_session_overview' ||
      selected.version !== data.fence.familyVersion ||
      data.fence.familyDependency.id !== data.sessionId
    ) {
      return { status: 'deferred', reason: 'legacy_family_changed' };
    }
    if (verifyEvidenceRevision(context.db, expected.evidence).status !== 'current') {
      return { status: 'deferred', reason: 'legacy_family_revision_changed' };
    }
    const heads = await readLegacyHeads(context.graph, data.sessionId, LEGACY_HEAD_LIMIT + 1);
    if (JSON.stringify(heads) !== JSON.stringify([...data.fence.heads].sort())) {
      return { status: 'deferred', reason: 'legacy_head_changed' };
    }
    const identities = await readNarrativeFamilyIdentities(context.graph, heads);
    if (
      identities.some(
        (row) => row.sessionId !== data.sessionId || row.family !== 'legacy_session_overview',
      )
    ) {
      return { status: 'deferred', reason: 'legacy_head_unbound' };
    }
    if (
      data.closedEdges.length > LEGACY_NARRATIVE_LIMITS.closingEdges ||
      data.closedEdges.some((edge) => !edge.sourceIsEpisode)
    ) {
      return { status: 'deferred', reason: 'legacy_closure_unproved' };
    }
    if (
      data.mode === 'publish' &&
      ((await presentNodeIds(context.graph, [data.nodeId])).size > 0 ||
        readLegacyNarrative(context.db, data.nodeId) !== undefined)
    ) {
      return { status: 'deferred', reason: 'legacy_target_occupied' };
    }
    if (data.mode === 'repair' && (!heads.includes(data.nodeId) || data.closes.length === 0)) {
      return { status: 'deferred', reason: 'legacy_keeper_changed' };
    }
    const inputs = await readLegacyNarrativeInputs(
      context.graph,
      data.sessionId,
      new Date(data.readAt),
      data.fence.includeExtracted,
    );
    if (
      inputs === undefined ||
      legacyInputDigest(inputs.episodes, inputs.extracted) !== data.fence.inputDigest
    ) {
      return { status: 'deferred', reason: 'legacy_inputs_changed' };
    }
    if (
      new Set(data.sourceIds).size !== data.sourceIds.length ||
      JSON.stringify(inputs.episodes.map((row) => row.id).sort()) !==
        JSON.stringify([...data.sourceIds].sort()) ||
      data.coverageKey !== coverageKey(data.sourceIds)
    ) {
      return { status: 'deferred', reason: 'legacy_membership_changed' };
    }
    if ((await presentNodeIds(context.graph, data.sourceIds)).size !== data.sourceIds.length) {
      return { status: 'deferred', reason: 'legacy_source_projection_missing' };
    }
    const permitted = new Set([...data.sourceIds, ...inputs.extracted.map((row) => row.id)]);
    if (data.citations.some((id) => !permitted.has(id))) {
      return { status: 'rejected', reason: 'legacy_citation_outside_input' };
    }
    return { status: 'valid' };
  },
  async applyGraph(context, data) {
    const now = new Date(data.observedAt);
    const occurredAt = new Date(data.occurredAt);
    if (data.mode === 'publish') {
      await writeNarrativeInTransaction(context.graph, {
        operationId: context.operationId,
        narrativeId: data.nodeId,
        sessionId: data.sessionId,
        now,
        occurredAt,
        decision: {
          version: data.version,
          coverageKey: data.coverageKey,
          episodeIds: data.sourceIds,
        },
        output: {
          summary: data.summary,
          narrative: data.narrative,
          citations: data.citations,
          kept: data.kept,
        },
        source: { coverage: data.coverage },
        span: {
          ...(data.spanStart === null ? {} : { start: new Date(data.spanStart) }),
          ...(data.spanEnd === null ? {} : { end: new Date(data.spanEnd) }),
        },
      });
    }
    await closeSupersededInTransaction(
      context.graph,
      {
        action: 'skip',
        reason: 'checked legacy family',
        version: data.version,
        coverageKey: data.coverageKey,
        episodeIds: data.sourceIds,
        supersedes: data.closes,
      },
      data.nodeId,
      now,
      occurredAt,
    );
    return { nodeId: data.nodeId, created: data.mode === 'publish', closed: data.closes.length };
  },
  prepareSqlite(context, data) {
    prepareFamilyAdvance(
      context.db,
      data.sessionId,
      context.operationId,
      new Date(data.observedAt),
    );
    prepareLegacyCoverage(context.db, coverage(data), context.operationId);
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    if (data.mode === 'publish') {
      recordLegacyNarrative(context.db, {
        narrativeId: data.nodeId,
        sessionId: data.sessionId,
        verificationStatus: 'pinned',
        verificationJson: JSON.stringify({
          reason: 'legacy_coverage_not_inventoried',
          sourceIds: data.sourceIds,
          citations: data.citations,
        }),
        createdAt: new Date(context.knownFrom),
      });
      acknowledgeLegacyNarrativeBirth(
        context.db,
        data.nodeId,
        context.operationId,
        context.knownFrom,
      );
    }
    acknowledgeLegacyCoverage(
      context.db,
      coverage(data),
      context.operationId,
      context.knownFrom,
      context.observedAckAt,
    );
    acknowledgeFamilyAdvance(context.db, data.sessionId, context.operationId, context.knownFrom);
    return undefined;
  },
  discardSqlite(context, data) {
    discardLegacyCoverage(context.db, coverage(data), context.operationId);
    discardFamilyAdvance(context.db, data.sessionId, context.operationId);
    return undefined;
  },
});
