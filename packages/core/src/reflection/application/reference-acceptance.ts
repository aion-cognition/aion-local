import type { ConfirmationStatement, ReferenceStatements } from './reference-statements.js';
import { durableRoleScope, type DurableRole } from '../../evidence/domain/scopes.js';
import { writeClaimProvenanceInTransaction } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { presentNodeIds } from '../../infrastructure/graph/projection-presence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeStatedLinkVersions,
  listStatedLinks,
  prepareStatedLinkVersion,
  readStatedLinkValues,
  statedLinkId,
  type StatedLinkKind,
  type StatedLinkQualifier,
} from '../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  advanceOperationalRevision,
  readActiveGeneration,
} from '../../infrastructure/sqlite/processing-generations.js';
import { classifyReferenceTarget } from '../../infrastructure/sqlite/reference-targets.js';
import {
  acceptReferenceBatch,
  readReferenceDelivery,
} from '../../infrastructure/sqlite/source-identity.js';
import { recordEvidenceAcknowledgment } from '../../infrastructure/sqlite/source-lifecycle.js';
import { appendMemoryConfirmedEvent } from '../../infrastructure/sqlite/usage-events.js';
import { hashContent } from '../domain/content.js';

/**
 * Accepting what a caller states about other memories, shared by every writer that accepts one.
 *
 * Intake accepts the references that arrive with a push, and the reference operation accepts the
 * ones stated later; both leave the same records, so both call this. A reference is a statement
 * about identity, so the durable half never depends on either endpoint being projected: an edge
 * is the current picture of this chain and not the other way round.
 */
export const STATED_REFERENCE_EFFECT = 'stated_references';

/** The canonical hash of an accepted reference set, so a batch repeating it adds no version. */
export function referenceSetHash(references: unknown): string {
  return hashContent(references ?? {});
}

/** The incidence role each statement kind is recorded under, from the signed scope registry. */
const ROLE_OF_KIND: Record<StatedLinkKind, DurableRole> = {
  corrects: 'stated_correction',
  derived_from: 'stated_derivation',
  confirms: 'stated_confirmation',
};

export type ReferenceTargetPlan = {
  readonly id: string;
  readonly kind: StatedLinkKind;
  readonly targetClass: StatedLinkQualifier;
  /** Present only on a confirmation, which carries a payload the other kinds do not. */
  readonly confirmation?: {
    readonly by: string;
    readonly evidence: string;
    /**
     * The clock this confirmation is recorded under, resolved while the guard was held.
     *
     * A caller may legitimately omit the moment it confirmed something; what it cannot do is
     * make the substrate invent one later. The resolved value is fixed in the plan, so a retry
     * or a recovery records the moment the first attempt accepted rather than its own.
     */
    readonly occurredAt: string;
    /** Set only when the caller stated a time, so a fallback is never mistaken for a claim. */
    readonly statedOccurredAt?: string;
  };
};

export type ReferenceAcceptance = {
  readonly sourceId: string;
  readonly targets: readonly ReferenceTargetPlan[];
  /** The caller's delivery identity. One delivery has one outcome. */
  readonly deliveryKey: string;
  readonly operationId: string;
  /** When the substrate accepted the statement, which is not when the statement was made. */
  readonly acceptedAt: string;
};

/** Every scope one acceptance moves: the statement's own end, and the end it points at. */
function affectedScopes(
  acceptance: ReferenceAcceptance,
): readonly { readonly endpointId: string; readonly relationClass: string }[] {
  const scopes = new Map<string, { endpointId: string; relationClass: string }>();
  for (const target of acceptance.targets) {
    const role = ROLE_OF_KIND[target.kind];
    for (const entry of [
      { endpointId: acceptance.sourceId, relationClass: durableRoleScope(role, 'out') },
      { endpointId: target.id, relationClass: durableRoleScope(role, 'in') },
    ]) {
      scopes.set(`${entry.endpointId}\n${entry.relationClass}`, entry);
    }
  }
  return [...scopes.values()];
}

/** The scope names a plan declares, so the coordinator records what this operation touches. */
export function referenceScopeNames(
  acceptance: Pick<ReferenceAcceptance, 'sourceId' | 'targets'>,
): readonly { readonly kind: 'source' | 'node'; readonly id: string; readonly scope: string }[] {
  return affectedScopes({ ...acceptance, deliveryKey: '', operationId: '', acceptedAt: '' }).map(
    (entry) => ({
      kind: entry.endpointId === acceptance.sourceId ? ('source' as const) : ('node' as const),
      id: entry.endpointId,
      scope: entry.relationClass,
    }),
  );
}

/** What a caller stated, in the one shape every writer that accepts references normalizes to. */
export type StatedReferenceInput = {
  readonly supersedes: readonly string[];
  readonly derivedFrom: readonly string[];
  readonly confirmations: readonly {
    readonly target: string;
    readonly by: string;
    readonly evidence: string;
    /** Absent when the caller stated none; the acceptance clock stands in for it. */
    readonly occurredAt?: string;
  }[];
};

/** Every id a statement names, in the order the versions are recorded. */
export function statedReferenceIds(input: StatedReferenceInput): readonly string[] {
  return [
    ...input.supersedes,
    ...input.derivedFrom,
    ...input.confirmations.map((entry) => entry.target),
  ];
}

/**
 * What each stated id turned out to be.
 *
 * The durable records answer first, so a target whose raw projection is gone stays a known
 * source rather than becoming an unknown identity. `retained` is what the graph currently holds,
 * and it decides only the ids the records do not account for.
 */
export function classifyStatedReferences(
  db: SqliteHandle,
  input: StatedReferenceInput,
  retained: ReadonlySet<string>,
  acceptedAt: string,
): ReferenceTargetPlan[] {
  const named: {
    id: string;
    kind: StatedLinkKind;
    confirmation?: ReferenceTargetPlan['confirmation'];
  }[] = [
    ...input.supersedes.map((id) => ({ id, kind: 'corrects' as const })),
    ...input.derivedFrom.map((id) => ({ id, kind: 'derived_from' as const })),
    ...input.confirmations.map((entry) => ({
      id: entry.target,
      kind: 'confirms' as const,
      confirmation: {
        by: entry.by,
        evidence: entry.evidence,
        occurredAt: entry.occurredAt ?? acceptedAt,
        ...(entry.occurredAt === undefined ? {} : { statedOccurredAt: entry.occurredAt }),
      },
    })),
  ];
  return named.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    targetClass: classifyReferenceTarget(db, entry.id, retained).targetClass,
    ...(entry.confirmation === undefined ? {} : { confirmation: entry.confirmation }),
  }));
}

/** The hash of the set a delivery accepts, over the exact statements it carries. */
export function acceptedTargetsHash(targets: readonly ReferenceTargetPlan[]): string {
  return referenceSetHash({
    supersedes: targets.filter((t) => t.kind === 'corrects').map((t) => t.id),
    derived_from: targets.filter((t) => t.kind === 'derived_from').map((t) => t.id),
    confirmations: targets
      .filter((t) => t.confirmation !== undefined)
      .map((t) => ({
        target: t.id,
        by: t.confirmation?.by ?? '',
        evidence: t.confirmation?.evidence ?? '',
      })),
  });
}

/**
 * The durable half, inside the caller's short prepare transaction.
 *
 * The batch, one link version per target, the scope advances the statements move, and the
 * obligation to settle them. Nothing here consults the graph: a statement about an endpoint the
 * graph no longer holds is exactly what these records exist to keep.
 *
 * Returns the accepted reference version.
 */
export function prepareReferenceAcceptance(
  db: SqliteHandle,
  acceptance: ReferenceAcceptance,
): number {
  const acceptedHash = acceptedTargetsHash(acceptance.targets);
  const batch = acceptReferenceBatch(db, {
    sourceId: acceptance.sourceId,
    acceptedHash,
    receivedAt: new Date(acceptance.acceptedAt),
    operationKey: acceptance.deliveryKey,
    introduced: acceptance.targets.map((target) => target.id),
  });
  for (const target of acceptance.targets) {
    const linkId = statedLinkId(target.kind, target.targetClass, acceptance.sourceId, target.id);
    prepareStatedLinkVersion(db, {
      linkId,
      kind: target.kind,
      qualifier: target.targetClass,
      fromId: acceptance.sourceId,
      toId: target.id,
      operationId: acceptance.operationId,
      operationKey: `${acceptance.deliveryKey}:${linkId}`,
      // Both clock roles: when the statement says it happened, and when this substrate took it.
      recordedValues: {
        targetClass: target.targetClass,
        ...(target.confirmation === undefined
          ? {}
          : {
              by: target.confirmation.by,
              evidence: target.confirmation.evidence,
              occurredAt: target.confirmation.occurredAt,
              ...(target.confirmation.statedOccurredAt === undefined
                ? {}
                : { statedOccurredAt: target.confirmation.statedOccurredAt }),
            }),
      },
      temporalProof: { acceptedAt: acceptance.acceptedAt },
      observedAt: new Date(acceptance.acceptedAt),
      referenceSourceId: acceptance.sourceId,
      referenceVersion: batch.referenceVersion,
    });
  }
  for (const scope of affectedScopes(acceptance)) {
    prepareScopeAdvance(db, {
      ...scope,
      operationId: acceptance.operationId,
      updatedAt: new Date(acceptance.acceptedAt),
    });
  }
  // A batch carrying no statement owes no settlement. Recording one anyway would make every
  // ordinary acceptance look like it had references outstanding, and a reader counting owed
  // work cannot tell a real obligation from a placeholder.
  if (acceptance.targets.length > 0) {
    recordEvidenceAcknowledgment(db, {
      sourceId: acceptance.sourceId,
      referenceVersion: batch.referenceVersion,
      effectKind: STATED_REFERENCE_EFFECT,
      state: 'owed',
    });
  }
  return batch.referenceVersion;
}

export type ReferenceProjection = {
  readonly projectedEdges: number;
  readonly unresolved: number;
};

/**
 * The edges an accepted set can currently carry, written inside the caller's graph transaction.
 *
 * Presence is read here rather than taken from the plan: a plan prepared before an interruption
 * can name an endpoint that has since stopped being projected, and an edge written against it
 * would fail the whole publication instead of settling the statement.
 *
 * Both ends or no edge. An absent source cannot carry lineage, and rebuilding one to make a
 * reference writable is what the residency rules forbid. A statement whose edge cannot be
 * written is not lost: it is already durable against the original identity, and the acceptance
 * records say so.
 */
export async function projectAcceptedReferences(
  tx: GraphTransaction,
  sourceId: string,
  targets: readonly ReferenceTargetPlan[],
  now: Date,
): Promise<ReferenceProjection> {
  const unresolved = targets.filter((target) => target.targetClass === 'unresolved').length;
  if (targets.length === 0) {
    return { projectedEdges: 0, unresolved };
  }
  const present = await presentNodeIds(tx, [sourceId, ...targets.map((target) => target.id)]);
  const held = present.has(sourceId)
    ? new Set(targets.filter((target) => present.has(target.id)).map((target) => target.id))
    : new Set<string>();
  if (held.size === 0 && !(unresolved > 0 && present.has(sourceId))) {
    return { projectedEdges: 0, unresolved };
  }
  const writable = targets.filter((target) => held.has(target.id));
  await writeClaimProvenanceInTransaction(tx, {
    episodeId: sourceId,
    derivedFrom: writable.filter((t) => t.kind === 'derived_from').map((t) => t.id),
    corrects: writable.filter((t) => t.kind === 'corrects').map((t) => t.id),
    confirmations: writable
      .filter((t) => t.confirmation !== undefined)
      .map((t) => ({
        target: t.id,
        by: t.confirmation?.by ?? '',
        evidence: t.confirmation?.evidence ?? '',
        at: new Date(t.confirmation?.occurredAt ?? now.toISOString()),
      })),
    unresolved,
    now,
  });
  return { projectedEdges: held.size, unresolved };
}

export type ReferenceSettlement = ReferenceAcceptance & {
  readonly knownFrom: string;
  readonly observedAckAt: string;
  readonly referenceVersion: number;
};

/**
 * The acknowledgment half, inside the caller's short acknowledgment transaction.
 *
 * The link versions join the committed view, the scopes publish the numbers they parked, the
 * source's readiness counter moves because it now owes a settled statement it did not owe
 * before, and every confirmation appends its event. An append that throws takes the whole
 * acknowledgment with it and leaves the work owed, which is the only honest outcome: a
 * settlement recorded over a signal nothing wrote is a signal no later pass looks for.
 */
export function acknowledgeReferenceAcceptance(
  db: SqliteHandle,
  settlement: ReferenceSettlement,
): void {
  const delivery = readReferenceDelivery(db, settlement.sourceId, settlement.deliveryKey);
  if (delivery?.referenceVersion !== settlement.referenceVersion) {
    throw new Error(`reference delivery ${settlement.deliveryKey} moved under its acknowledgment`);
  }
  acknowledgeStatedLinkVersions(
    db,
    settlement.operationId,
    settlement.knownFrom,
    settlement.observedAckAt,
  );
  for (const scope of affectedScopes(settlement)) {
    acknowledgeScopeAdvance(db, {
      ...scope,
      operationId: settlement.operationId,
      updatedAt: new Date(settlement.knownFrom),
    });
  }
  const generation = readActiveGeneration(db, settlement.sourceId);
  if (generation !== undefined) {
    advanceOperationalRevision(db, settlement.sourceId, generation.processingGeneration);
  }
  appendConfirmationEvents(db, settlement);
  if (settlement.targets.length > 0) {
    recordEvidenceAcknowledgment(db, {
      sourceId: settlement.sourceId,
      referenceVersion: settlement.referenceVersion,
      effectKind: STATED_REFERENCE_EFFECT,
      state: 'completed',
      completedAt: new Date(settlement.observedAckAt),
    });
  }
}

/**
 * One event per confirmation, keyed on the statement rather than the attempt, so a retry or a
 * raw rebuild of the same source adds nothing. The canonical payload is the one the first
 * accepted version recorded: a later delivery restating the same pair does not rewrite who
 * confirmed it or what they cited.
 */
function appendConfirmationEvents(db: SqliteHandle, settlement: ReferenceSettlement): void {
  for (const target of settlement.targets) {
    if (target.confirmation === undefined) {
      continue;
    }
    const linkId = statedLinkId(target.kind, target.targetClass, settlement.sourceId, target.id);
    const canonical = readStatedLinkValues(db, linkId) ?? target.confirmation;
    const by = typeof canonical.by === 'string' ? canonical.by : target.confirmation.by;
    const evidence =
      typeof canonical.evidence === 'string' ? canonical.evidence : target.confirmation.evidence;
    const statedAt =
      typeof canonical.occurredAt === 'string'
        ? canonical.occurredAt
        : target.confirmation.occurredAt;
    appendMemoryConfirmedEvent(db, {
      key: confirmationEventKey(settlement.sourceId, target.id, by, evidence),
      episodeId: settlement.sourceId,
      memories: [target.id],
      confirmedBy: by,
      evidence,
      occurredAt: new Date(statedAt),
      recordedAt: new Date(settlement.observedAckAt),
    });
  }
}

/**
 * The same digest rule the settle path uses, over what makes one confirmation the same statement
 * as another. Keeping the two in step is what stops a converted writer from doubling the stream.
 */
export function confirmationEventKey(
  episodeId: string,
  target: string,
  by: string,
  evidence: string,
): string {
  return `feedback:memory_confirmed:${hashContent({ episodeId, target, by, evidence })}`;
}

/** Releases the scope numbers a rejected attempt parked. The accepted batch and versions stay. */
export function discardReferenceAcceptance(
  db: SqliteHandle,
  acceptance: ReferenceAcceptance,
): void {
  for (const scope of affectedScopes(acceptance)) {
    rejectScopeAdvance(db, {
      ...scope,
      operationId: acceptance.operationId,
      updatedAt: new Date(acceptance.acceptedAt),
    });
  }
}

/**
 * What THIS occurrence has stated, from the versions its own acceptances recorded.
 *
 * A replacement shares its forgotten predecessor's raw bytes, so the canonical archive row
 * carries the predecessor's statements. Re-stating those from the replacement would assert,
 * under a different occurrence, something nobody said about it. The durable records are keyed
 * on the source, so they answer this without the raw row being involved at all.
 *
 * Only committed versions are returned: a statement still awaiting its acknowledgment has not
 * been accepted yet, and replaying it would publish a decision its publication may still refuse.
 *
 * A confirmation comes back with the clock it was accepted under, because that is the moment its
 * edge was written with and a writer restoring that edge is reproducing a record rather than
 * making one.
 */
export function acceptedReferencesOf(
  db: SqliteHandle,
  sourceId: string,
): ReferenceStatements | undefined {
  const links = listStatedLinks(db, sourceId).filter((link) => link.knownFrom !== null);
  if (links.length === 0) {
    return undefined;
  }
  const supersedes = new Set<string>();
  const derivedFrom = new Set<string>();
  const confirmations = new Map<string, ConfirmationStatement>();
  for (const link of links) {
    if (link.kind === 'corrects') {
      supersedes.add(link.toId);
    } else if (link.kind === 'derived_from') {
      derivedFrom.add(link.toId);
    } else if (!confirmations.has(link.toId)) {
      const values = readStatedLinkValues(db, link.linkId) ?? {};
      confirmations.set(link.toId, {
        target: link.toId,
        by: typeof values.by === 'string' ? values.by : '',
        evidence: typeof values.evidence === 'string' ? values.evidence : '',
        // Both clocks, and they are not the same fact. The resolved one is the moment this
        // acceptance recorded, so a writer restoring the edge writes the moment it already had.
        // The stated one is present only when the caller gave a time, so a receipt is never
        // handed back as though somebody had claimed it.
        ...(typeof values.occurredAt === 'string' ? { occurredAt: values.occurredAt } : {}),
        ...(typeof values.statedOccurredAt === 'string'
          ? { statedOccurredAt: values.statedOccurredAt }
          : {}),
      });
    }
  }
  return {
    supersedes: [...supersedes],
    derivedFrom: [...derivedFrom],
    confirmations: [...confirmations.values()],
  };
}
