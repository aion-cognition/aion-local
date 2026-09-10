import { z } from 'zod';

import { NARRATIVE_EXTRACTION_METHOD } from './narrative-write.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { NARRATIVE_SCOPES } from '../../evidence/domain/scopes.js';
import {
  supersedeInTransaction,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { closeNarrativeEdgesInTransaction } from '../../infrastructure/graph/narrative-edge-queries.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  presentNodeIds,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { JsonValue } from '../../infrastructure/publication/types.js';
import {
  listChunkMembers,
  markChunkPublished,
  readChunk,
  recordRevisionCitations,
  recordRevisionDependencies,
} from '../../infrastructure/sqlite/chunk-manifest.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  CHUNK_REVISION_FAMILY,
  prepareNarrativeRevision,
  publishNarrativeRevision,
  readPublishedHead,
  releaseNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * Publishing one revision of one sealed chunk, through the coordinator and nowhere else.
 *
 * Synthesis and grounding happen before this: they are provider work and they hold no lock. What
 * arrives here is the finished output plus the dependency set it was written under, and the whole
 * job of this operation is to decide, under the guard, whether that output still describes the
 * substrate — and if it does, to land the node, its edges, the closure of the head it replaces and
 * the durable records of what it rested on and cited, as one boundary.
 *
 * The recheck is deliberately narrow. Dependency tokens, residency generations and the ACTUAL
 * published head decide it. Enrichment and eviction readiness do not: a source whose downstream
 * processing has stalled is still a source whose text this narrative may read, and gating
 * publication on it would stop a session being written down because something else is behind.
 */

/** The narrative family this operation writes. Rollup overviews are a separate family. */
export const CHUNK_NARRATIVE_FAMILY = 'chunk';

export const NARRATIVE_PUBLISH_EFFECT = 'narrative_revision_published';

const CITATION_SCOPE = NARRATIVE_SCOPES[0];

const NARRATIVE_SIGNALS = ['compression'];
const NARRATIVE_PROVENANCE = [NARRATIVE_EXTRACTION_METHOD];

const Dependency = z.strictObject({
  kind: z.enum(['source', 'node', 'relation_scope']),
  id: z.string().min(1),
  scope: z.string().min(1),
  version: z.string().min(1),
});

const Citation = z.strictObject({
  targetId: z.string().min(1),
  targetKind: z.enum(['source', 'part', 'retained_node']),
});

const Range = z.strictObject({
  address: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const Gap = z.discriminatedUnion('reason', [
  z.strictObject({
    reason: z.literal('oversized_member'),
    sourceId: z.string().min(1),
    submitted: z.array(Range),
  }),
  z.strictObject({ reason: z.literal('suppressed_member'), sourceId: z.string().min(1) }),
]);

/**
 * What the caller observed about each member's storage before it synthesised.
 *
 * Both halves are fenced. A member that was resident when the input was read and is gone by the
 * time the guard is held is a different projection, and the edge this operation would write would
 * name a node that no longer exists.
 */
const Member = z.strictObject({
  sourceId: z.string().min(1),
  residency: z.enum(['resident', 'retiring', 'evicted']),
  projectionGeneration: z.number().int().nonnegative(),
});

const Payload = z.strictObject({
  chunkId: z.string().min(1),
  sessionId: z.string().min(1),
  revisionNo: z.number().int().positive(),
  nodeId: z.string().min(1),
  summary: z.string(),
  narrative: z.string().min(1),
  citations: z.array(Citation),
  sentenceCount: z.number().int().nonnegative(),
  coverage: z.number(),
  spanStart: z.string().optional(),
  spanEnd: z.string().optional(),
  occurredAt: z.string().min(1),
  members: z.array(Member).min(1),
  coverageGaps: z.array(Gap),
  dependencies: z.array(Dependency),
  /**
   * The coverage epoch the evidence was read under, carried from the start of assembly.
   *
   * Reading the registry again here would bind whatever epoch is in force when the output arrives,
   * which is the one thing the fence must not do: an activation during the model call changes what
   * the substrate says it covers, and relabelling an already-written answer with the newer epoch
   * makes the coordinator check a reading nobody took.
   */
  coverageEpoch: z.string().min(1),
  /** The head the caller read before it started. Null when the chunk had never published. */
  expectedHead: z.number().int().positive().nullable(),
});

const Data = Payload.extend({
  /** The node id of the head this publication closes, resolved under the guard. '' when first. */
  supersedes: z.string(),
  observedAt: z.string().min(1),
});

const Result = z.strictObject({
  nodeId: z.string().min(1),
  summarized: z.number().int().nonnegative(),
  supersededNodeId: z.string(),
  closedEdges: z.number().int().nonnegative(),
});

type NarrativeData = z.infer<typeof Data>;
type NarrativeResult = z.infer<typeof Result>;

function detail(value: JsonValue): JsonValue {
  return value;
}

/** The head's node id, read from the revision row rather than derived from the head number. */
function headNodeId(db: SqliteHandle, chunkId: string): string {
  const row = db
    .prepare(`SELECT node_id FROM chunk_revisions WHERE chunk_id = ? AND state = 'published'`)
    .get(chunkId) as { node_id: string } | undefined;
  return row?.node_id ?? '';
}

/**
 * Today's narrative property set plus the three the chunk family adds.
 *
 * `coverage_key` is the chunk id, which is what the identity of a frozen member set is here, and
 * `version` is the revision number, so a reader that knows only the session narrative shape still
 * reads a chunk revision correctly.
 */
function narrativeProperties(data: NarrativeData): GraphProperties {
  return {
    [MEMORY_PROPERTIES.summary]: data.summary,
    [MEMORY_PROPERTIES.text]: data.narrative,
    [MEMORY_PROPERTIES.sessionId]: data.sessionId,
    [MEMORY_PROPERTIES.extractionMethod]: NARRATIVE_EXTRACTION_METHOD,
    [NARRATIVE_PROPERTIES.citations]: data.citations.map((citation) => citation.targetId),
    [NARRATIVE_PROPERTIES.sentenceCount]: data.sentenceCount,
    [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    [NARRATIVE_PROPERTIES.scope]: CHUNK_NARRATIVE_FAMILY,
    [NARRATIVE_PROPERTIES.version]: data.revisionNo,
    [NARRATIVE_PROPERTIES.coverageKey]: data.chunkId,
    [NARRATIVE_PROPERTIES.coverageCount]: data.members.length,
    [NARRATIVE_PROPERTIES.coverage]: data.coverage,
    [NARRATIVE_PROPERTIES.chunkId]: data.chunkId,
    [NARRATIVE_PROPERTIES.family]: CHUNK_NARRATIVE_FAMILY,
    [NARRATIVE_PROPERTIES.revisionNo]: data.revisionNo,
    ...(data.spanStart === undefined ? {} : { [NARRATIVE_PROPERTIES.spanStart]: data.spanStart }),
    ...(data.spanEnd === undefined ? {} : { [NARRATIVE_PROPERTIES.spanEnd]: data.spanEnd }),
  };
}

/** The endpoints this revision's citations advance a citation-scope version on. */
function citationScopes(
  data: NarrativeData,
): readonly { endpointId: string; relationClass: string }[] {
  const endpoints = [...new Set(data.citations.map((citation) => citation.targetId))].sort();
  return endpoints.map((endpointId) => ({ endpointId, relationClass: CITATION_SCOPE }));
}

export const narrativePublication = new PublicationOperation({
  kind: 'narrative_publish',
  effectKinds: [NARRATIVE_PUBLISH_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  prepare(context, payload) {
    if (readCurrentCoverageContract(context.db) === undefined) {
      throw new Error('a narrative revision cannot publish before the coverage registry exists');
    }
    // Resolved here, under the guard, rather than carried from the caller's read: the head this
    // publication closes is the one standing when it lands, and closing a node the caller happened
    // to see is how two revisions end up both open.
    const data: NarrativeData = {
      ...payload,
      supersedes: headNodeId(context.db, payload.chunkId),
      observedAt: context.now.toISOString(),
    };
    return Promise.resolve({
      data,
      expected: {
        // The caller's own epoch, never a fresh read of the registry.
        coverageEpoch: payload.coverageEpoch,
        evidence: buildEvidenceRevision(payload.dependencies),
        sources: [],
        heads: [{ chunkId: payload.chunkId, publishedRevisionNo: payload.expectedHead }],
      },
      scopes: citationScopes(data).map((scope) => ({
        kind: 'relation_scope' as const,
        id: scope.endpointId,
        scope: scope.relationClass,
      })),
      effects: [
        {
          kind: NARRATIVE_PUBLISH_EFFECT,
          detail: detail({ chunkId: payload.chunkId, revisionNo: payload.revisionNo }),
        },
      ],
    });
  },
  async check(context, data, expected) {
    const chunk = readChunk(context.db, data.chunkId);
    if (chunk === undefined) {
      return Promise.resolve({ status: 'rejected', reason: 'chunk_not_sealed' } as const);
    }
    const frozen = [...listChunkMembers(context.db, data.chunkId)].sort();
    const claimed = [...data.members.map((member) => member.sourceId)].sort();
    if (frozen.join(' ') !== claimed.join(' ')) {
      return Promise.resolve({ status: 'rejected', reason: 'membership_changed' } as const);
    }
    const head = readPublishedHead(context.db, CHUNK_REVISION_FAMILY, data.chunkId) ?? null;
    if (head !== (expected.heads[0]?.publishedRevisionNo ?? null)) {
      return Promise.resolve({ status: 'deferred', reason: 'published_head_moved' } as const);
    }
    // Dependency equality, not "close enough": a changed correction between the synthesis and
    // this guard is new evidence, and publishing the old answer would certify a reading nobody
    // holds any more.
    const revision = verifyEvidenceRevision(context.db, expected.evidence);
    if (revision.status !== 'current') {
      return Promise.resolve({
        status: 'deferred' as const,
        reason: `evidence_${revision.status}`,
      });
    }
    for (const member of data.members) {
      const residency = readSourceResidency(context.db, member.sourceId);
      const state = residency?.state ?? 'resident';
      const generation = residency?.projectionGeneration ?? 0;
      if (state !== member.residency || generation !== member.projectionGeneration) {
        return { status: 'deferred', reason: 'residency_moved' } as const;
      }
    }
    // A member the records call resident with no node behind it is an inconsistency, and it is
    // named here so the attempt releases the guard rather than holding it while a repair that
    // nobody has started is waited for. The write still refuses if the projection goes between
    // this reading and the edge: what is never allowed is the silent skip.
    const expectedNodes = data.members
      .filter((member) => member.residency !== 'evicted')
      .map((member) => member.sourceId);
    const present = new Set(await presentNodeIds(context.graph, expectedNodes));
    if (expectedNodes.some((sourceId) => !present.has(sourceId))) {
      return { status: 'deferred', reason: 'member_projection_missing' } as const;
    }
    return { status: 'valid' } as const;
  },
  async applyGraph(context, data: NarrativeData): Promise<NarrativeResult> {
    const { now } = context;
    const occurredAt = new Date(data.occurredAt);
    await writeStampedDerivedNodeInTransaction(context.graph, {
      label: 'Narrative',
      id: data.nodeId,
      now,
      occurredAt,
      properties: narrativeProperties(data),
    });
    await upsertEdgeInTransaction(context.graph, {
      type: DERIVES_FROM_TYPE,
      sourceId: data.nodeId,
      targetId: data.sessionId,
      strength: 1,
      confidence: 1,
      signals: NARRATIVE_SIGNALS,
      provenance: NARRATIVE_PROVENANCE,
      count: 0,
      now,
    });

    let summarized = 0;
    for (const member of data.members) {
      // An evicted member keeps its durable membership and its citations and has no physical
      // edge to write. A member that should be resident and has no projection is an inconsistency
      // rather than the same skip: the upsert raises, the transaction rolls back, and nothing here
      // rebuilds a projection in order to publish.
      if (member.residency === 'evicted') {
        continue;
      }
      await upsertEdgeInTransaction(context.graph, {
        type: SUMMARIZED_BY_TYPE,
        sourceId: member.sourceId,
        targetId: data.nodeId,
        strength: 1,
        confidence: 1,
        signals: NARRATIVE_SIGNALS,
        provenance: NARRATIVE_PROVENANCE,
        count: 0,
        now,
      });
      summarized += 1;
    }

    if (data.supersedes === '' || data.supersedes === data.nodeId) {
      return { nodeId: data.nodeId, summarized, supersededNodeId: '', closedEdges: 0 };
    }
    // The actual prior head of THIS chunk, closed with its own summarization edges. Never the
    // open-session sweep the whole-session path uses: that closes every open narrative of a
    // session, which across a chunked session is every other chunk's head.
    await supersedeInTransaction(context.graph, {
      oldId: data.supersedes,
      newId: data.nodeId,
      now,
      validUntil: occurredAt,
      signals: NARRATIVE_SIGNALS,
      provenance: NARRATIVE_PROVENANCE,
    });
    const closed = await closeNarrativeEdgesInTransaction(context.graph, {
      narrativeIds: [data.supersedes],
      validUntil: occurredAt,
      txUntil: now,
    });
    return {
      nodeId: data.nodeId,
      summarized,
      supersededNodeId: data.supersedes,
      closedEdges: closed.length,
    };
  },
  prepareSqlite(context, data) {
    prepareNarrativeRevision(
      context.db,
      CHUNK_REVISION_FAMILY,
      data.chunkId,
      data.revisionNo,
      context.operationId,
    );
    for (const scope of citationScopes(data)) {
      prepareScopeAdvance(context.db, {
        ...scope,
        operationId: context.operationId,
        updatedAt: new Date(data.observedAt),
      });
    }
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    const evidence = buildEvidenceRevision(data.dependencies);
    publishNarrativeRevision(context.db, CHUNK_REVISION_FAMILY, {
      familyKey: data.chunkId,
      revisionNo: data.revisionNo,
      operationId: context.operationId,
      evidenceRevisionJson: JSON.stringify(evidence),
      knownFrom: context.knownFrom,
      observedAckAt: context.observedAckAt,
      publishedAt: new Date(context.knownFrom),
      // Null is not an empty array. Null says nobody established what the synthesis saw; an
      // empty array says the input was verified complete, and this operation always knows which.
      coverageGapsJson: JSON.stringify(data.coverageGaps),
    });
    recordRevisionDependencies(context.db, data.nodeId, evidence);
    recordRevisionCitations(context.db, data.nodeId, data.citations);
    markChunkPublished(context.db, data.chunkId);
    for (const scope of citationScopes(data)) {
      acknowledgeScopeAdvance(context.db, {
        ...scope,
        operationId: context.operationId,
        updatedAt: new Date(context.knownFrom),
      });
    }
    return undefined;
  },
  discardSqlite(context, data) {
    // The number stays spent and the row stays; what is released is the binding to this operation,
    // so the caller's own retry decision is what abandons or reuses the allocation.
    releaseNarrativeRevision(context.db, CHUNK_REVISION_FAMILY, data.chunkId, data.revisionNo);
    for (const scope of citationScopes(data)) {
      rejectScopeAdvance(context.db, {
        ...scope,
        operationId: context.operationId,
        updatedAt: new Date(data.observedAt),
      });
    }
    return undefined;
  },
});
