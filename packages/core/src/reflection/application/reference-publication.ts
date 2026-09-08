import { z } from 'zod';

import {
  acceptedTargetsHash,
  acknowledgeReferenceAcceptance,
  discardReferenceAcceptance,
  classifyStatedReferences,
  prepareReferenceAcceptance,
  projectAcceptedReferences,
  referenceScopeNames,
  statedReferenceIds,
  type ReferenceAcceptance,
} from './reference-acceptance.js';
import { presentNodeIds } from '../../infrastructure/graph/projection-presence.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { JsonValue, PublicationContext } from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import {
  readReferenceDelivery,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';

/**
 * Stated references as a publication of their own.
 *
 * Acceptance and projection are separated here for the reason the whole cut exists: a reference
 * is a caller's assertion about identity, and identity outlives the raw projection. Every
 * accepted reference is recorded against the original source and target ids, including the ones
 * whose graph endpoint is absent, so a reference arriving a year after an eviction still lands.
 * An edge is written only when BOTH ends are projected, and skipping it discharges nothing.
 */
export const REFERENCE_EFFECTS = {
  accepted: 'reference_batch',
  links: 'evidence_link_versions',
} as const;

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
  confirmation: Confirmation.omit({ target: true }).optional(),
});

const Data = Payload.extend({
  acceptedHash: z.string().min(1),
  /** The substrate's own acceptance clock, fixed at prepare so a replay keeps it. */
  acceptedAt: z.string().min(1),
  targets: z.array(Target),
});

const Result = z.strictObject({
  referenceVersion: z.number().int().positive(),
  projectedEdges: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
});

type ReferenceData = z.infer<typeof Data>;

/** Narrows an effect detail to the plan's own value type, which a union of shapes would widen. */
function json(value: JsonValue): JsonValue {
  return value;
}

function acceptanceOf(data: ReferenceData, operationId: string): ReferenceAcceptance {
  return {
    sourceId: data.sourceId,
    targets: data.targets,
    deliveryKey: data.deliveryKey,
    operationId,
    acceptedAt: data.acceptedAt,
  };
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
    // A retained interpretation is only knowable from the graph, so presence is asked once here
    // and used to classify the ids the durable records do not account for.
    const retained = await presentNodeIds(context.graph, statedReferenceIds(payload));
    const targets = classifyStatedReferences(context.db, payload, retained);
    const source = readSourceRecord(context.db, payload.sourceId);
    const data: ReferenceData = {
      ...payload,
      acceptedHash: acceptedTargetsHash(targets),
      acceptedAt: context.now.toISOString(),
      targets,
    };
    return {
      data,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([
          {
            kind: 'source',
            id: payload.sourceId,
            scope: 'source.references',
            version: source?.verificationStatus ?? 'absent',
          },
        ]),
        sources: [],
        heads: [],
      },
      scopes: referenceScopeNames({ sourceId: payload.sourceId, targets }),
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
    const projected = await projectAcceptedReferences(
      context.graph,
      data.sourceId,
      data.targets,
      context.now,
    );
    const accepted = readReferenceDelivery(context.db, data.sourceId, data.deliveryKey);
    if (accepted === undefined) {
      throw new Error(
        `reference delivery ${data.deliveryKey} was projected before it was accepted`,
      );
    }
    return { referenceVersion: accepted.referenceVersion, ...projected };
  },
  prepareSqlite(context, data) {
    prepareReferenceAcceptance(context.db, acceptanceOf(data, context.operationId));
    return undefined;
  },
  acknowledgeSqlite(context, data, result) {
    acknowledgeReferenceAcceptance(context.db, {
      ...acceptanceOf(data, context.operationId),
      knownFrom: context.knownFrom,
      observedAckAt: context.observedAckAt,
      referenceVersion: result.referenceVersion,
    });
    return undefined;
  },
  discardSqlite(context, data) {
    // The accepted batch and its prepared versions stay: a rejected attempt never clears what a
    // caller stated. Only the scope numbers it parked are released, so the published tokens a
    // reader already holds stay current.
    discardReferenceAcceptance(context.db, acceptanceOf(data, context.operationId));
    return undefined;
  },
});
