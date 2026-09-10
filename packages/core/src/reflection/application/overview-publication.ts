import { z } from 'zod';

import {
  supersedeInTransaction,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { closeNarrativeEdgesInTransaction } from '../../infrastructure/graph/narrative-edge-queries.js';
import {
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { ROLLUP_WINDOW_PROPERTY } from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { abandonStaleAllocations } from '../../infrastructure/sqlite/narrative-allocations.js';
import {
  recordRevisionCitations,
  recordRevisionDependencies,
} from '../../infrastructure/sqlite/narrative-citations.js';
import {
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  prepareNarrativeRevision,
  publishNarrativeRevision,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { overviewWindowOf } from '../../infrastructure/sqlite/overview-membership.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * A calendar overview's own publication.
 *
 * The rollup this replaces wrote through the ordinary stamped-node adapters, derived its identity
 * from a coverage key over whatever the graph happened to return, and took its members out of
 * default recall by superseding them. Three separate mistakes: the write was outside the guard, the
 * identity was not the manifest's, and absorption collapsed two different relations into one.
 *
 * What an overview IS here: a revision of a `scope:window` family, allocated and headed by the
 * same helper the chunk family uses, publishing through the same coordinator, CITING its members
 * and closing nothing but its own prior head. A member stays independently current — a day is not
 * replaced by the week that mentions it — and the citation is what a lineage walk crosses, so a
 * week reaches a chunk's sources through the day that cited them without any new step kind.
 *
 * The membership fence is the whole point of the window. An overview asserts it covered the window
 * COMPLETE, so what it is checked against under the guard is the set of member heads it cited: a
 * member that has republished, or one that has arrived since, is a different window and defers this
 * publication rather than being papered over.
 */

export const OVERVIEW_PUBLISH_EFFECT = 'overview_revision_published';

/** What the node's `narrative_family` says, so a reader can tell the three families apart. */
export const OVERVIEW_NARRATIVE_FAMILY = 'overview';

const OVERVIEW_SIGNALS = ['compression'];
const OVERVIEW_PROVENANCE = ['narrative_overview'];

/** The extraction method the node records, kept distinct from the legacy rollup's. */
export const OVERVIEW_EXTRACTION_METHOD = 'narrative_overview';

/**
 * The relation class an overview's dependency on one member is filed under.
 *
 * Its own name because it is its own question: not what a source said, but which revision of a
 * family this window was written over. A member that republishes moves the version this records.
 */
export const OVERVIEW_MEMBER_SCOPE = 'narrative:overview_member';

const Member = z.strictObject({
  /** The member's own family key: a chunk id, or a child overview's `scope:window`. */
  familyKey: z.string().min(1),
  /** The published revision node this overview cites. */
  nodeId: z.string().min(1),
  revisionNo: z.number().int().positive(),
});

const Payload = z.strictObject({
  familyKey: z.string().min(1),
  scope: z.string().min(1),
  windowKey: z.string().min(1),
  revisionNo: z.number().int().positive(),
  nodeId: z.string().min(1),
  summary: z.string(),
  narrative: z.string(),
  citations: z.array(z.string().min(1)),
  sentenceCount: z.number().int().nonnegative(),
  members: z.array(Member),
  spanStart: z.string().min(1),
  spanEnd: z.string().min(1),
  occurredAt: z.string().min(1),
  coverageEpoch: z.string().min(1),
  expectedHead: z.number().int().positive().nullable(),
});

const Data = Payload.extend({
  /** The prior head this publication closes, resolved under the guard. Empty for the first. */
  supersedes: z.string(),
});

const Result = z.strictObject({
  nodeId: z.string().min(1),
  cited: z.number().int().nonnegative(),
  supersededNodeId: z.string(),
  closedEdges: z.number().int().nonnegative(),
});

type OverviewData = z.infer<typeof Data>;

/** The operation identity prefix a revision of this family publishes under. */
export function overviewOperationPrefix(familyKey: string): string {
  return `overview-publish:${familyKey}:`;
}

function headNodeId(db: SqliteHandle, familyKey: string): string {
  return readPublishedRevision(db, OVERVIEW_REVISION_FAMILY, familyKey)?.nodeId ?? '';
}

function overviewProperties(data: OverviewData): GraphProperties {
  return {
    [MEMORY_PROPERTIES.summary]: data.summary,
    [MEMORY_PROPERTIES.text]: data.narrative,
    [MEMORY_PROPERTIES.extractionMethod]: OVERVIEW_EXTRACTION_METHOD,
    [NARRATIVE_PROPERTIES.citations]: [...data.citations],
    [NARRATIVE_PROPERTIES.sentenceCount]: data.sentenceCount,
    [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    [NARRATIVE_PROPERTIES.scope]: data.scope,
    [ROLLUP_WINDOW_PROPERTY]: data.windowKey,
    [NARRATIVE_PROPERTIES.version]: data.revisionNo,
    [NARRATIVE_PROPERTIES.coverageKey]: data.familyKey,
    [NARRATIVE_PROPERTIES.coverageCount]: data.members.length,
    // A window is published whole or refused, so what publishes covered all of it.
    [NARRATIVE_PROPERTIES.coverage]: 1,
    [NARRATIVE_PROPERTIES.family]: OVERVIEW_NARRATIVE_FAMILY,
    [NARRATIVE_PROPERTIES.revisionNo]: data.revisionNo,
    [NARRATIVE_PROPERTIES.spanStart]: new Date(data.spanStart),
    [NARRATIVE_PROPERTIES.spanEnd]: new Date(data.spanEnd),
  };
}

/**
 * The window's membership as the records hold it NOW, compared against what the caller cited.
 *
 * Not a count: a member that republished between the render and the guard has a different head
 * node, and an overview that went ahead would cite a revision the family has replaced while
 * claiming to cover the window whole.
 */
function membershipMoved(db: SqliteHandle, data: OverviewData): boolean {
  return data.members.some((member) => {
    // A member key that names a window is a child overview; anything else is a chunk. The two
    // families keep their own tables, and which one a key belongs to is readable from the key.
    const family =
      overviewWindowOf(member.familyKey) === undefined
        ? CHUNK_REVISION_FAMILY
        : OVERVIEW_REVISION_FAMILY;
    const head = readPublishedRevision(db, family, member.familyKey);
    return head?.nodeId !== member.nodeId;
  });
}

export const overviewPublication = new PublicationOperation({
  kind: 'overview_publish',
  effectKinds: [OVERVIEW_PUBLISH_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  prepare(context, payload) {
    if (readCurrentCoverageContract(context.db) === undefined) {
      throw new Error('an overview cannot publish before the coverage registry exists');
    }
    // Resolved under the guard rather than carried from the caller's read: the head this closes is
    // the one standing when it lands, and closing a node the caller happened to see is how two
    // revisions of one window end up both open.
    const data: OverviewData = {
      ...payload,
      supersedes: headNodeId(context.db, payload.familyKey),
    };
    return Promise.resolve({
      data,
      expected: {
        coverageEpoch: payload.coverageEpoch,
        // What the overview rests on, at the tokens the records report. Where nothing has counted
        // a member's citation scope the token is absent, which the verifier reads as unverifiable
        // rather than as fresh — missing dependencies do not look fresh.
        evidence: buildEvidenceRevision(
          payload.members.map((member) => ({
            kind: 'node' as const,
            id: member.nodeId,
            scope: OVERVIEW_MEMBER_SCOPE,
            version: String(member.revisionNo),
          })),
        ),
        sources: [],
        heads: [{ chunkId: payload.familyKey, publishedRevisionNo: payload.expectedHead }],
      },
      scopes: [],
      effects: [
        {
          kind: OVERVIEW_PUBLISH_EFFECT,
          detail: { familyKey: payload.familyKey, revisionNo: payload.revisionNo },
        },
      ],
    });
  },
  check(context, data, expected) {
    const head = readPublishedRevision(context.db, OVERVIEW_REVISION_FAMILY, data.familyKey);
    if ((head?.revisionNo ?? null) !== (expected.heads[0]?.publishedRevisionNo ?? null)) {
      return Promise.resolve({ status: 'deferred', reason: 'head_moved' } as const);
    }
    if (data.members.length === 0) {
      return Promise.resolve({ status: 'rejected', reason: 'empty_window' } as const);
    }
    if (membershipMoved(context.db, data)) {
      return Promise.resolve({ status: 'deferred', reason: 'window_membership_moved' } as const);
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  async applyGraph(context, data: OverviewData): Promise<z.infer<typeof Result>> {
    const { now } = context;
    const occurredAt = new Date(data.occurredAt);
    await writeStampedDerivedNodeInTransaction(context.graph, {
      label: 'Narrative',
      id: data.nodeId,
      now,
      occurredAt,
      properties: overviewProperties(data),
    });
    for (const member of data.members) {
      // The traversal edge, and only that. The member is NOT superseded: what a member is to an
      // overview is a citation, and what a prior version is to it is correction lineage. Closing
      // members made a window's arrival rewrite the standing of every memory inside it.
      await upsertEdgeInTransaction(context.graph, {
        type: SUMMARIZED_BY_TYPE,
        sourceId: member.nodeId,
        targetId: data.nodeId,
        strength: 1,
        confidence: 1,
        signals: OVERVIEW_SIGNALS,
        provenance: OVERVIEW_PROVENANCE,
        count: 0,
        now,
      });
    }
    if (data.supersedes === '' || data.supersedes === data.nodeId) {
      return {
        nodeId: data.nodeId,
        cited: data.members.length,
        supersededNodeId: '',
        closedEdges: 0,
      };
    }
    await supersedeInTransaction(context.graph, {
      oldId: data.supersedes,
      newId: data.nodeId,
      now,
      validUntil: occurredAt,
      signals: OVERVIEW_SIGNALS,
      provenance: OVERVIEW_PROVENANCE,
    });
    const closed = await closeNarrativeEdgesInTransaction(context.graph, {
      narrativeIds: [data.supersedes],
      validUntil: occurredAt,
      txUntil: now,
    });
    return {
      nodeId: data.nodeId,
      cited: data.members.length,
      supersededNodeId: data.supersedes,
      closedEdges: closed.length,
    };
  },
  prepareSqlite(context, data) {
    prepareNarrativeRevision(
      context.db,
      OVERVIEW_REVISION_FAMILY,
      data.familyKey,
      data.revisionNo,
      context.operationId,
    );
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    publishNarrativeRevision(context.db, OVERVIEW_REVISION_FAMILY, {
      familyKey: data.familyKey,
      revisionNo: data.revisionNo,
      operationId: context.operationId,
      evidenceRevisionJson: JSON.stringify(
        buildEvidenceRevision(
          data.members.map((member) => ({
            kind: 'node' as const,
            id: member.nodeId,
            scope: OVERVIEW_MEMBER_SCOPE,
            version: String(member.revisionNo),
          })),
        ),
      ),
      knownFrom: context.knownFrom,
      observedAckAt: context.observedAckAt,
      publishedAt: new Date(context.knownFrom),
      coverageGapsJson: '[]',
    });
    // The members, as the retained nodes this revision rests on. A lineage walk crossing one
    // reaches its own citations, which is how a week reaches a chunk's sources through the day.
    recordRevisionCitations(
      context.db,
      data.nodeId,
      data.members.map((member) => ({ targetId: member.nodeId, targetKind: 'retained_node' })),
    );
    recordRevisionDependencies(
      context.db,
      data.nodeId,
      buildEvidenceRevision(
        data.members.map((member) => ({
          kind: 'node' as const,
          id: member.nodeId,
          scope: OVERVIEW_MEMBER_SCOPE,
          version: String(member.revisionNo),
        })),
      ),
    );
    abandonStaleAllocations(
      context.db,
      OVERVIEW_REVISION_FAMILY,
      data.familyKey,
      data.revisionNo,
      new Date(context.knownFrom),
    );
    return undefined;
  },
  discardSqlite() {
    return undefined;
  },
});
