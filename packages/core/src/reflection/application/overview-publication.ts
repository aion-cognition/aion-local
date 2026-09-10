import { z } from 'zod';

import { windowMembers } from './overview-windows.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { NARRATIVE_SCOPES, durableRoleScope } from '../../evidence/domain/scopes.js';
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
import {
  buildEvidenceRevision,
  type EvidenceDependency,
  type EvidenceRevision,
} from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  abandonStaleAllocations,
  listAllocatedRevisions,
} from '../../infrastructure/sqlite/narrative-allocations.js';
import {
  readCitationsFrom,
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
import type { RollupScope } from '../domain/rollup.js';

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
  /**
   * What that prior head cited, read under the guard beside it. A target this revision drops loses
   * an incoming citation the moment the old head closes, so its population moved and its token has
   * to move with it — the new citations alone name only the targets that GAINED one.
   */
  priorCitations: z.array(z.string().min(1)),
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

/** A member key that names a window is a child overview; anything else is a chunk. */
function familyOf(familyKey: string) {
  return overviewWindowOf(familyKey) === undefined
    ? CHUNK_REVISION_FAMILY
    : OVERVIEW_REVISION_FAMILY;
}

const CITATION_SCOPE = NARRATIVE_SCOPES[0];

/** The node's own outbound populations, which a durable walk asks about before crossing it. */
const NODE_OWN_SCOPES = [CITATION_SCOPE, durableRoleScope('extraction', 'out')];

/**
 * What this overview actually rests on: everything its children rest on, and the children.
 *
 * A token naming the member's revision number is not a dependency — nothing produces that scope,
 * so it verifies `unverifiable` for ever and the fence it looks like is not one. The dependencies
 * an overview reads are the ones its members were published on, and the signed invalidation is
 * recursive: a correction under a chunk makes that chunk's set stale, and this set holds that
 * chunk's set, so the overview goes stale with it.
 *
 * A member's own citation population is deliberately NOT in here, though it is the obvious
 * candidate: this publication ADVANCES that population by citing the member, so a token taken
 * before the write is stale the moment the write lands. What a member republishing changes is the
 * window's membership, and the membership fence is what answers for that.
 *
 * A member whose own set cannot be read contributes nothing here and is refused by the check; a
 * publication is never built on a reading nobody took.
 */
export function memberEvidence(
  db: SqliteHandle,
  members: readonly { readonly familyKey: string; readonly nodeId: string }[],
): EvidenceRevision {
  const dependencies: EvidenceDependency[] = [];
  for (const member of members) {
    const head = readPublishedRevision(db, familyOf(member.familyKey), member.familyKey);
    const stored = parseEvidence(head?.evidenceRevisionJson ?? null);
    if (stored !== undefined) {
      dependencies.push(...stored.dependencies);
    }
  }
  return buildEvidenceRevision(dependencies);
}

export function parseEvidence(json: string | null): EvidenceRevision | undefined {
  if (json === null) {
    return undefined;
  }
  try {
    return JSON.parse(json) as EvidenceRevision;
  } catch {
    return undefined;
  }
}

/**
 * Every citation population this publication changes.
 *
 * The targets it cites move, and the node's own outbound populations move — a durable lineage walk
 * asks about the second before it will cross this overview to what it rests on, and an author that
 * declared none left the walk stopping here with no roots and `complete: false`.
 *
 * The targets the CLOSED head cited move too, and for the same reason: closing that head withdraws
 * its citations, so a target this revision no longer names goes from cited to uncited and any
 * judgment fenced on that reading is out of date. Declaring only the new targets left a removed
 * one carrying an unchanged token over a population that had emptied. The census distinction is
 * unaffected: a cited or uncited target's population MOVED, and whether anyone has counted it
 * stays that target's own question — only this node's own scopes are established here.
 */
function citationScopes(data: OverviewData): readonly { endpointId: string; scope: string }[] {
  const targets = new Set([...data.citations, ...data.priorCitations]);
  targets.delete(data.nodeId);
  return [
    ...[...targets].sort().map((endpointId) => ({ endpointId, scope: CITATION_SCOPE })),
    ...NODE_OWN_SCOPES.map((scope) => ({ endpointId: data.nodeId, scope })),
  ];
}

/**
 * Whether the number this output was written against is still this operation's to publish.
 *
 * The handler used to look at neither. A slower actor returning after a newer one published and
 * ABANDONED its row would write its output against a revision the manifest had already closed, and
 * the acknowledgment that then failed left the shared slot occupied. Ordinary concurrency, ordinary
 * unexpired claims, and nothing about it needs an expired lease.
 */
function allocationHeld(db: SqliteHandle, data: OverviewData, operationId: string): boolean {
  const row = listAllocatedRevisions(db, OVERVIEW_REVISION_FAMILY, data.familyKey).find(
    (held) => held.revisionNo === data.revisionNo,
  );
  return row !== undefined && (row.operationId === null || row.operationId === operationId);
}

/**
 * The window's membership as the records hold it NOW, compared as a SET against what was cited.
 *
 * Not each cited member in turn: a chunk that arrives in a closed window while it is being written
 * changes nothing about the members already chosen, and a check that walked only the chosen list
 * published a subset of the window while storing a coverage of 1 over the whole of it.
 */
function membershipMoved(db: SqliteHandle, data: OverviewData): boolean {
  const whole = windowMembers(db, data.scope as RollupScope, {
    key: data.windowKey,
    start: new Date(data.spanStart),
  });
  if (whole === undefined) {
    return true;
  }
  const now = whole.map((member) => `${member.familyKey}\u0000${member.nodeId}`).sort();
  const cited = data.members.map((member) => `${member.familyKey}\u0000${member.nodeId}`).sort();
  return now.join('|') !== cited.join('|');
}

/** Whether every member still stands on evidence that verifies. */
function childEvidenceHolds(db: SqliteHandle, data: OverviewData): boolean {
  return data.members.every((member) => {
    const head = readPublishedRevision(db, familyOf(member.familyKey), member.familyKey);
    const stored = parseEvidence(head?.evidenceRevisionJson ?? null);
    return stored !== undefined && verifyEvidenceRevision(db, stored).status === 'current';
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
    const supersedes = headNodeId(context.db, payload.familyKey);
    const data: OverviewData = {
      ...payload,
      supersedes,
      priorCitations:
        supersedes === ''
          ? []
          : readCitationsFrom(context.db, supersedes).map((citation) => citation.targetId),
    };
    return Promise.resolve({
      data,
      expected: {
        coverageEpoch: payload.coverageEpoch,
        // What the overview rests on, read from the records rather than named after them.
        evidence: memberEvidence(context.db, payload.members),
        sources: [],
        heads: [{ chunkId: payload.familyKey, publishedRevisionNo: payload.expectedHead }],
      },
      scopes: citationScopes(data).map((entry) => ({
        kind: 'relation_scope' as const,
        id: entry.endpointId,
        scope: entry.scope,
      })),
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
    if (!allocationHeld(context.db, data, context.operationId)) {
      return Promise.resolve({ status: 'rejected', reason: 'allocation_not_current' } as const);
    }
    if (membershipMoved(context.db, data)) {
      return Promise.resolve({ status: 'deferred', reason: 'window_membership_moved' } as const);
    }
    if (!childEvidenceHolds(context.db, data)) {
      return Promise.resolve({ status: 'deferred', reason: 'member_evidence_stale' } as const);
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
    // A preparation that changed no row is a revision this operation does not hold: bind nothing,
    // and say so rather than carrying on to write an output against somebody else's number.
    if (
      !prepareNarrativeRevision(
        context.db,
        OVERVIEW_REVISION_FAMILY,
        data.familyKey,
        data.revisionNo,
        context.operationId,
      )
    ) {
      throw new Error(
        `overview_revisions ${data.familyKey}/${String(data.revisionNo)} is not allocated to this operation`,
      );
    }
    for (const entry of citationScopes(data)) {
      prepareScopeAdvance(context.db, {
        endpointId: entry.endpointId,
        relationClass: entry.scope,
        operationId: context.operationId,
        updatedAt: new Date(data.occurredAt),
      });
    }
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    publishNarrativeRevision(context.db, OVERVIEW_REVISION_FAMILY, {
      familyKey: data.familyKey,
      revisionNo: data.revisionNo,
      operationId: context.operationId,
      evidenceRevisionJson: JSON.stringify(memberEvidence(context.db, data.members)),
      knownFrom: context.knownFrom,
      observedAckAt: context.observedAckAt,
      publishedAt: new Date(context.knownFrom),
      coverageGapsJson: '[]',
    });
    // What the grounded output SUPPORTS, which is not the same population as what the window
    // covers. Coverage membership is the window's set and lives on the node and in the dependency
    // set; a citation is a sentence resting on one retained node, and a durable citation row that
    // named every member said the prose stood on things it never mentioned.
    recordRevisionCitations(
      context.db,
      data.nodeId,
      data.citations.map((targetId) => ({ targetId, targetKind: 'retained_node' })),
    );
    recordRevisionDependencies(context.db, data.nodeId, memberEvidence(context.db, data.members));
    for (const entry of citationScopes(data)) {
      acknowledgeScopeAdvance(context.db, {
        endpointId: entry.endpointId,
        relationClass: entry.scope,
        operationId: context.operationId,
        updatedAt: new Date(context.knownFrom),
        // The overview's own outbound populations are counted by this write and by nothing else,
        // so this is where their census is established. A cited target's population MOVED; whether
        // anyone has counted it is that target's own question.
        ...(entry.endpointId === data.nodeId ? { censusStatus: 'established' as const } : {}),
      });
    }
    abandonStaleAllocations(
      context.db,
      OVERVIEW_REVISION_FAMILY,
      data.familyKey,
      data.revisionNo,
      new Date(context.knownFrom),
    );
    return undefined;
  },
  discardSqlite(context, data) {
    for (const entry of citationScopes(data)) {
      rejectScopeAdvance(context.db, {
        endpointId: entry.endpointId,
        relationClass: entry.scope,
        operationId: context.operationId,
        updatedAt: new Date(data.occurredAt),
      });
    }
    return undefined;
  },
});
