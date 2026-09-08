import { z } from 'zod';

import { referenceSetHash } from './source-manifest.js';
import { writeClaimProvenanceInTransaction } from '../../infrastructure/graph/claim-provenance-queries.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { JsonValue, PublicationContext } from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeStatedLinkVersions,
  prepareStatedLinkVersion,
  statedLinkId,
  type StatedLinkKind,
} from '../../infrastructure/sqlite/evidence-links.js';
import { classifyReferenceTarget } from '../../infrastructure/sqlite/reference-targets.js';
import {
  acceptReferenceBatch,
  readReferenceDelivery,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { recordEvidenceAcknowledgment } from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * Stated references as a publication of their own.
 *
 * Acceptance and projection are separated here for the reason the whole cut exists: a reference
 * is a caller's assertion about identity, and identity outlives the raw projection. Every
 * accepted reference is recorded against the original source and target ids, including the ones
 * whose graph endpoint is absent, so a reference arriving a year after an eviction still lands.
 * Only the edges whose endpoints the graph actually holds are written, and skipping those
 * writes discharges nothing.
 */
export const REFERENCE_EFFECTS = {
  accepted: 'reference_batch',
  links: 'evidence_link_versions',
} as const;

const KIND_OF_FIELD: Record<'supersedes' | 'derived_from' | 'confirmations', StatedLinkKind> = {
  supersedes: 'corrects',
  derived_from: 'derived_from',
  confirmations: 'confirms',
};

const Confirmation = z.strictObject({
  target: z.string().min(1),
  by: z.string().min(1),
  evidence: z.string().min(1),
  occurredAt: z.string().min(1),
});

const Payload = z.strictObject({
  sourceId: z.string().min(1),
  supersedes: z.array(z.string().min(1)),
  derivedFrom: z.array(z.string().min(1)),
  confirmations: z.array(Confirmation),
  /** One delivery, one outcome: a retry under this key accepts no second version. */
  deliveryKey: z.string().min(1),
  observedAt: z.string().min(1),
});

const Target = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['corrects', 'derived_from', 'confirms']),
  targetClass: z.enum(['source', 'part', 'retained_node', 'unresolved']),
  /** True only when the graph holds the endpoint now, which is what an edge needs. */
  projected: z.boolean(),
});

const Data = Payload.extend({
  acceptedHash: z.string().min(1),
  targets: z.array(Target),
});

const Result = z.strictObject({
  referenceVersion: z.number().int().positive(),
  projectedEdges: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
});

type ReferenceData = z.infer<typeof Data>;

function statedIds(data: z.infer<typeof Payload>): readonly { id: string; kind: StatedLinkKind }[] {
  return [
    ...data.supersedes.map((id) => ({ id, kind: KIND_OF_FIELD.supersedes })),
    ...data.derivedFrom.map((id) => ({ id, kind: KIND_OF_FIELD.derived_from })),
    ...data.confirmations.map((entry) => ({
      id: entry.target,
      kind: KIND_OF_FIELD.confirmations,
    })),
  ];
}

/** Which of the named ids the graph holds right now. Absence is a projection fact, not identity. */
async function projectedIds(
  context: PublicationContext,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await context.graph.run(
    'UNWIND $ids AS id MATCH (n:AionNode { id: id }) RETURN n.id AS id',
    { ids: [...new Set(ids)] },
    (row) => row.id as string,
  );
  return new Set(rows);
}

/** Narrows an effect detail to the plan's own value type, which a union of shapes would widen. */
function json(value: JsonValue): JsonValue {
  return value;
}

function acceptedSet(data: z.infer<typeof Payload>): Record<string, unknown> {
  return {
    supersedes: data.supersedes,
    derived_from: data.derivedFrom,
    confirmations: data.confirmations,
  };
}

/**
 * The references this publication owes, recorded before anything is projected. Every target
 * gets a version, whatever it turned out to be: an unresolved id stays durably stated, and a
 * verified source with no projection is recorded against its original identity.
 */
function recordAcceptedReferences(
  db: SqliteHandle,
  data: ReferenceData,
  operationId: string,
  referenceVersion: number,
): void {
  for (const target of data.targets) {
    const linkId = statedLinkId(target.kind, target.targetClass, data.sourceId, target.id);
    prepareStatedLinkVersion(db, {
      linkId,
      kind: target.kind,
      qualifier: target.targetClass,
      fromId: data.sourceId,
      toId: target.id,
      operationId,
      operationKey: `${data.deliveryKey}:${linkId}`,
      recordedValues: { targetClass: target.targetClass, projected: target.projected },
      temporalProof: { observedAt: data.observedAt },
      observedAt: new Date(data.observedAt),
      referenceSourceId: data.sourceId,
      referenceVersion,
    });
  }
}

/** The stated references operation, registered on the coordinator beside intake. */
export const statedReferencesPublication = new PublicationOperation({
  kind: 'stated_references',
  effectKinds: [REFERENCE_EFFECTS.accepted, REFERENCE_EFFECTS.links],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('references cannot publish before the coverage registry exists');
    }
    const named = statedIds(payload);
    const projected = await projectedIds(
      context,
      named.map((entry) => entry.id),
    );
    const targets = named.map((entry) => {
      const classified = classifyReferenceTarget(context.db, entry.id, projected);
      return {
        id: entry.id,
        kind: entry.kind,
        targetClass: classified.targetClass,
        projected: projected.has(entry.id),
      };
    });
    const source = readSourceRecord(context.db, payload.sourceId);
    return {
      data: { ...payload, acceptedHash: referenceSetHash(acceptedSet(payload)), targets },
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([
          {
            kind: 'source',
            id: payload.sourceId,
            scope: 'sqlite:source_records',
            version: source?.verificationStatus ?? 'absent',
          },
        ]),
        sources: [],
        heads: [],
      },
      scopes: [{ kind: 'source', id: payload.sourceId, scope: 'sqlite:source_references' }],
      effects: [
        { kind: REFERENCE_EFFECTS.accepted, detail: json({ sourceId: payload.sourceId }) },
        { kind: REFERENCE_EFFECTS.links, detail: json({ count: targets.length }) },
      ],
    };
  },
  check(context, data) {
    // The source has to be a source. Its projection may be gone, and that is not a reason to
    // refuse the caller's statement about it.
    if (readSourceRecord(context.db, data.sourceId) === undefined) {
      return Promise.resolve({ status: 'rejected', reason: 'source_unknown' } as const);
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  async applyGraph(context: PublicationContext, data: ReferenceData) {
    const held = new Set(data.targets.filter((t) => t.projected).map((t) => t.id));
    const unresolved = data.targets.filter((t) => t.targetClass === 'unresolved').length;
    const projectedEdges = held.size;
    if (held.size > 0 || unresolved > 0) {
      await writeClaimProvenanceInTransaction(context.graph, {
        episodeId: data.sourceId,
        derivedFrom: data.derivedFrom.filter((id) => held.has(id)),
        corrects: data.supersedes.filter((id) => held.has(id)),
        confirmations: data.confirmations
          .filter((entry) => held.has(entry.target))
          .map((entry) => ({
            target: entry.target,
            by: entry.by,
            evidence: entry.evidence,
            at: new Date(entry.occurredAt),
          })),
        unresolved,
        now: context.now,
      });
    }
    const accepted = readReferenceDelivery(context.db, data.sourceId, data.deliveryKey);
    if (accepted === undefined) {
      throw new Error(
        `reference delivery ${data.deliveryKey} was projected before it was accepted`,
      );
    }
    return { referenceVersion: accepted.referenceVersion, projectedEdges, unresolved };
  },
  prepareSqlite(context, data) {
    const batch = acceptReferenceBatch(context.db, {
      sourceId: data.sourceId,
      acceptedHash: data.acceptedHash,
      receivedAt: new Date(data.observedAt),
      operationKey: data.deliveryKey,
      introduced: data.targets.map((target) => target.id),
    });
    recordAcceptedReferences(context.db, data, context.operationId, batch.referenceVersion);
    recordEvidenceAcknowledgment(context.db, {
      sourceId: data.sourceId,
      referenceVersion: batch.referenceVersion,
      effectKind: 'stated_references',
      state: 'owed',
    });
    return undefined;
  },
  acknowledgeSqlite(context, data, result) {
    acknowledgeStatedLinkVersions(
      context.db,
      context.operationId,
      context.knownFrom,
      context.observedAckAt,
    );
    // The comparison the completion boundary turns on: the settlement is bound to the version
    // that was actually accepted, so a reference landing mid-retry is caught by the next pass
    // rather than discharged by this one.
    const latest = readReferenceDelivery(context.db, data.sourceId, data.deliveryKey);
    if (latest?.referenceVersion !== result.referenceVersion) {
      throw new Error(`reference delivery ${data.deliveryKey} moved under its acknowledgment`);
    }
    recordEvidenceAcknowledgment(context.db, {
      sourceId: data.sourceId,
      referenceVersion: result.referenceVersion,
      effectKind: 'stated_references',
      state: 'completed',
      completedAt: new Date(context.observedAckAt),
    });
    return undefined;
  },
  discardSqlite() {
    // The accepted batch and its prepared versions stay: a rejected attempt never clears what a
    // caller stated, and the obligation to settle it moves to whoever publishes next.
    return undefined;
  },
});
