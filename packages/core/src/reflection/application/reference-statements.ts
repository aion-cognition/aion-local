import type { ReflectionProvenance } from '@aion/protocol';

/**
 * The shape every writer that attaches stated references speaks, with a confirmation's two clock
 * roles kept apart.
 *
 * The block a caller sends carries one optional moment and it means "I say this happened then".
 * The acceptance records keep that apart from the moment they resolved the confirmation under,
 * which is the moment the edge was written with and therefore the moment a writer recreating that
 * edge has to write again. Replay fills this from the records; a caller's own block converts
 * through `referenceStatementsOf`, which has only the claim to give it.
 */
export type ConfirmationStatement = {
  readonly target: string;
  readonly by: string;
  readonly evidence: string;
  /** The moment the confirmation was recorded under, absent when no record holds one. */
  readonly occurredAt?: string;
  /** The caller's own claim about when, absent when it made none. */
  readonly statedOccurredAt?: string;
};

export type ReferenceStatements = {
  readonly supersedes: readonly string[];
  readonly derivedFrom: readonly string[];
  readonly confirmations: readonly ConfirmationStatement[];
};

/** A caller's own block in that shape. The only moment it holds is the one it claims. */
export function referenceStatementsOf(provenance: ReflectionProvenance): ReferenceStatements {
  return {
    supersedes: provenance.supersedes ?? [],
    derivedFrom: provenance.derived_from ?? [],
    confirmations: (provenance.confirmations ?? []).map((entry) => ({
      target: entry.target,
      by: entry.by,
      evidence: entry.evidence,
      ...(entry.occurred_at === undefined ? {} : { statedOccurredAt: entry.occurred_at }),
    })),
  };
}

/**
 * The moment an attached edge carries: what the records resolved, then what the caller claimed,
 * and only then the writing clock.
 *
 * A recorded moment outranks a claim because it is the moment the edge already had, and a rebuild
 * whose edge comes back under the clock the rebuild ran on has reproduced something else.
 */
export function confirmationMoment(statement: ConfirmationStatement, now: Date): Date {
  const moment = statement.occurredAt ?? statement.statedOccurredAt;
  return moment === undefined ? now : new Date(moment);
}
