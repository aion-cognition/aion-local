import { settleConfirmationSignals } from './confirmation-signals.js';
import type { ConfirmationStatement, ReferenceStatements } from './reference-statements.js';
import { bothEndpoints, type DurableRole } from '../../evidence/domain/scopes.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  heldDeliveryLinkVersions,
  releaseLinkVersions,
  type LinkVersionKey,
} from '../../infrastructure/sqlite/evidence-link-settlement.js';
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
import { hashContent, type ReflectionContent } from '../domain/content.js';

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
    // Both directions come off the role rather than being written in here. All three stated roles
    // put the node on the `in` side today, so the two agree; a role that did not would have made
    // this writer file the source's census under a counter nothing reads.
    for (const entry of bothEndpoints(ROLE_OF_KIND[target.kind], acceptance.sourceId, target.id)) {
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
    /**
     * The moment an EARLIER acceptance of this same statement already resolved.
     *
     * Only a writer replaying a statement the substrate has already accepted may supply this,
     * and what it is for is the edge: a repair that reused the ordinary fallback would date the
     * confirmation to itself while the durable record and the usage event kept the original
     * moment, so the graph and the stream would disagree about one confirmation. It is not a
     * caller's claim and never becomes one: the stated time stays absent when the caller stated
     * none.
     */
    readonly resolvedOccurredAt?: string;
  }[];
};

/** The stated block a push carried, in the shape every writer that accepts one normalizes to. */
export function statedInput(stated: ReflectionContent['provenance']): StatedReferenceInput {
  return {
    supersedes: stated?.supersedes ?? [],
    derivedFrom: stated?.derived_from ?? [],
    confirmations: (stated?.confirmations ?? []).map((entry) => ({
      target: entry.target,
      by: entry.by,
      evidence: entry.evidence,
      ...(entry.occurred_at === undefined ? {} : { occurredAt: entry.occurred_at }),
    })),
  };
}

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
        // The caller's claim first, then a moment an earlier acceptance already resolved, and
        // only then this acceptance's own clock. The stated time is set by the caller alone.
        occurredAt: entry.occurredAt ?? entry.resolvedOccurredAt ?? acceptedAt,
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

/**
 * Where each statement in one delivery is recorded: its link, and the key that delivery owns on it.
 *
 * Derived in one place because two halves depend on agreeing about it. The prepare writes under
 * these keys and the acknowledgment asks about exactly the same ones, so a settlement cannot
 * report an effect on a row it never addressed.
 */
function statedLinkKeys(
  acceptance: Pick<ReferenceAcceptance, 'sourceId' | 'targets' | 'deliveryKey'>,
): readonly LinkVersionKey[] {
  return acceptance.targets.map((target) => {
    const linkId = statedLinkId(target.kind, target.targetClass, acceptance.sourceId, target.id);
    return { linkId, operationKey: `${acceptance.deliveryKey}:${linkId}` };
  });
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
  const keys = statedLinkKeys(acceptance);
  // An address this delivery wrote before and no longer names. The link id is derived from what
  // the target turned out to be, and an earlier attempt asked the graph a moment when the answer
  // was different: the id it wrote under is one no later attempt will ever address again, so the
  // row is owed by a dead operation and unreachable by the re-adoption. It was never acknowledged
  // and never visible, so it is released rather than left pinning this source out of eviction.
  const named = new Set(keys.map((key) => key.operationKey));
  releaseLinkVersions(
    db,
    heldDeliveryLinkVersions(db, acceptance.sourceId, acceptance.deliveryKey).filter(
      (held) => !named.has(held.operationKey),
    ),
  );
  for (const [index, target] of acceptance.targets.entries()) {
    const key = keys[index];
    if (key === undefined) {
      throw new Error(`stated reference ${target.id} has no recorded link address`);
    }
    prepareStatedLinkVersion(db, {
      linkId: key.linkId,
      kind: target.kind,
      qualifier: target.targetClass,
      fromId: acceptance.sourceId,
      toId: target.id,
      operationId: acceptance.operationId,
      operationKey: key.operationKey,
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
 * before, and every confirmation whose target the substrate can name appends its event. An
 * append that throws takes the whole acknowledgment with it and leaves the work owed, which is
 * the only honest outcome: a settlement recorded over a signal nothing wrote is a signal no
 * later pass looks for.
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
  // Membership in the operation is not proof of effect, and the question is asked at DELIVERY
  // granularity because that is the identity the obligation is recorded under. The versions are
  // addressed by delivery and promoted by operation, so a row left behind under another operation
  // would stay outside the committed view while this acknowledgment recorded the obligation
  // settled. Asking only about the addresses this attempt named would miss a row an earlier
  // attempt wrote under a different classification of the same target.
  const owed = heldDeliveryLinkVersions(db, settlement.sourceId, settlement.deliveryKey);
  if (owed.length > 0) {
    throw new Error(
      `reference delivery ${settlement.deliveryKey} left ${String(owed.length)} stated link version(s) unsettled`,
    );
  }
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
  settleConfirmationSignals(db, settlement);
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
