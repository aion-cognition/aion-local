import { z } from 'zod';

/**
 * The wire shapes of the intake operation: what a transport hands the coordinator, what the
 * guarded decision adds to it, and what the acknowledgment answers with.
 *
 * Strict throughout. A field the operation does not name is a field nobody decided, and accepting
 * one would let a caller carry state into a plan the coordinator replays later.
 */

const Readiness = z.strictObject({
  policyRevision: z.number().int().nonnegative(),
  stageNames: z.array(z.string().min(1)),
});

export const Payload = z.strictObject({
  identity: z.string().min(1),
  sessionId: z.string().min(1),
  /** The redacted content as the archive holds it. A string so the codec stays strict. */
  payloadJson: z.string().min(1),
  referencesJson: z.string().nullable(),
  lane: z.string().nullable(),
  originJson: z.string().nullable(),
  pipelineVersion: z.string().min(1),
  occurredAt: z.string().min(1),
  indexPolicy: z.string().min(1),
  readiness: Readiness.nullable(),
});

const ReferenceTarget = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['corrects', 'derived_from', 'confirms']),
  targetClass: z.enum(['source', 'part', 'retained_node', 'unresolved']),
  confirmation: z
    .strictObject({
      by: z.string().min(1),
      evidence: z.string().min(1),
      occurredAt: z.string().min(1),
      statedOccurredAt: z.string().min(1).optional(),
    })
    .optional(),
});

export const Data = Payload.extend({
  decision: z.enum(['new', 'reuse', 'pinned']),
  /**
   * When this substrate accepted the push, fixed while the guard was held. World time comes off
   * the experience; every acceptance and readiness clock comes from here, so a backdated
   * conversation cannot date its own archive row, ingest position or reference receipt.
   */
  acceptedAt: z.string().min(1),
  /** The statements this push carried, classified under the guard. Empty when it carried none. */
  referenceTargets: z.array(ReferenceTarget),
  /** Why a pinned decision refuses, so the intent says which rule stopped it. */
  pinnedReason: z.enum(['occurrence_ambiguous', 'occurrence_state_uncertain']).nullable(),
  sourceId: z.string(),
  turnIds: z.array(z.string().min(1)),
  contentHash: z.string().min(1),
  identityHash: z.string().min(1),
  /** Which occurrences the guarded read saw, so the check can tell that the answer moved. */
  candidateDigest: z.string().min(1),
  residency: z.enum(['resident', 'retiring', 'evicted', 'absent']),
  pinnedCandidates: z.array(z.string().min(1)),
});

export const Result = z.strictObject({
  sourceId: z.string(),
  created: z.boolean(),
  turnIds: z.array(z.string().min(1)),
});

export type IntakePayload = z.infer<typeof Payload>;
export type IntakeData = z.infer<typeof Data>;
