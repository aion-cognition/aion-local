import { currentOnly } from './bitemporal.js';
import type { GraphTransaction } from './connection.js';
import { VALID_HORIZON_PROPERTY } from './read-modes.js';
import { supersedeSubjectFamilyInTransaction, type SubjectFamilyResult } from './subject-family.js';
import { FACT_NODE_LABELS } from './supersession-queries.js';
import type { GraphProperties } from './values.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
  KEYED_CLOSE_METHOD,
  KEYED_CLOSE_SIGNALS,
  readingHorizon,
  type TemporalClass,
} from '../../reflection/domain/claim-key.js';

/**
 * The subject-keyed half of supersession: a claim states one attribute of one entity, and the
 * claim that already stated that attribute of that entity is the claim it corrects. No model
 * is asked, because there is nothing here to judge.
 *
 * The key is two node properties rather than an edge to the subject. An edge would be prunable
 * on age, reopenable by the edge writer, and weighted for activation, and a key that any of
 * those reached would be silently broken with nothing to notice it.
 */

/** The two halves of the key declare themselves with the key itself; every reader still asks here. */
export { CLAIM_ASPECT_PROPERTY, CLAIM_SUBJECT_PROPERTY };

export const TEMPORAL_CLASS_PROPERTY = 'temporal_class';

/**
 * When a reading stops answering. Never `valid_until`: a future close is invisible to every
 * currency predicate in the tree, is made permanent by the `coalesce` on the close, and would
 * record the wrong world time under a lineage edge a later real correction writes. The read
 * side compares this to its own reference clock and annotates the row, which is why it declares
 * the property and every reader of it, this write included, still asks there.
 */
export { VALID_HORIZON_PROPERTY };

/**
 * What a keyed match does. `off` skips the lookup outright. `judge` records the key on the node
 * and leaves the pair to the two-pass judge, which is the unmeasured default. `close` is the
 * mechanical close this module performs.
 */
export type KeyedCloseMode = 'off' | 'judge' | 'close';

export type KeyedCloseOptions = {
  readonly mode: KeyedCloseMode;
  /**
   * Cosine against the closed claim a sibling from its observation must reach before the close
   * takes it too. Carried with the mode rather than defaulted here: a floor this module invented
   * would silently hold every sibling open.
   */
  readonly relatednessFloor: number;
};

export type ClaimKeyProperties = {
  readonly subjectEntityId?: string;
  readonly aspectNorm?: string;
  readonly temporalClass?: TemporalClass;
  /** How long a reading answers for. Read only when the class is `reading`. */
  readonly readingHorizonDays?: number;
  /** The world time of the experience the claim came from, which is what a horizon counts from. */
  readonly occurredAt: Date;
};

/**
 * The key's contribution to a claim's property block. A horizon is computed here, from the
 * episode's own clock and only for a reading, so no caller can date one to the write or hang
 * one on a standing fact. An undefined value is dropped before the write rather than stored.
 */
export function claimKeyProperties(input: ClaimKeyProperties): GraphProperties {
  const horizon =
    input.temporalClass === 'reading' && input.readingHorizonDays !== undefined
      ? readingHorizon(input.occurredAt, input.readingHorizonDays)
      : undefined;

  return {
    [CLAIM_SUBJECT_PROPERTY]: input.subjectEntityId,
    [CLAIM_ASPECT_PROPERTY]: input.aspectNorm,
    [TEMPORAL_CLASS_PROPERTY]: input.temporalClass,
    [VALID_HORIZON_PROPERTY]: horizon,
  };
}

/**
 * The open claims a new claim's key corrects.
 *
 * `currentOnly` runs here, inside the transaction that writes the close, so a claim another
 * writer closed between a read and a write is never closed a second time. That predicate is the
 * whole mechanism: a keyed lookup that reads currency in an earlier transaction closes claims
 * whose lineage already belongs to someone else.
 *
 * The new claim excludes itself by id, because node identity is folded from the episode, the
 * label and the text: a replayed episode MERGEs the same node, which would otherwise match its
 * own key and supersede itself.
 *
 * Same-episode siblings are excluded too. Two claims from one observation sharing a key is an
 * extraction defect rather than a correction, and one observation's siblings are not evidence
 * against each other.
 *
 * `Memory` anchors the seek because it is the label the composite index is declared on; the
 * fact-bearing labels are a post-filter over the rows it returns.
 */
const KEYED_CLAIM_MATES = [
  'MATCH (c:Memory)',
  `WHERE c.${CLAIM_SUBJECT_PROPERTY} = $subjectEntityId`,
  `  AND c.${CLAIM_ASPECT_PROPERTY} = $aspectNorm`,
  '  AND c.id <> $newId',
  '  AND any(label IN labels(c) WHERE label IN $labels)',
  `  AND ${currentOnly('c')}`,
  '  AND NOT EXISTS { MATCH (c)-[:EXTRACTED_FROM]->(:Episode { id: $episodeId }) }',
  'RETURN c.id AS id',
  'ORDER BY c.id',
].join('\n');

export type KeyedCloseInput = {
  /** The claim just written, which is the successor every close records. */
  readonly newId: string;
  /** Its source episode, whose own claims the lookup excludes. */
  readonly episodeId: string;
  readonly subjectEntityId: string;
  readonly aspectNorm: string;
  readonly relatednessFloor: number;
  readonly now: Date;
  /** When the correcting experience happened, which is when the closed claims stopped being true. */
  readonly validUntil: Date;
};

export type KeyedCloseResult = {
  /** Every node the close took: the key-mates and the siblings that closed with them. */
  readonly closedIds: readonly string[];
  /** One per key-mate, carrying the siblings it took, the ones it held, and the glosses it retired. */
  readonly families: readonly SubjectFamilyResult[];
};

/**
 * Closes every open claim that shares the new claim's key, in the caller's transaction.
 *
 * It closes through the subject-family path rather than a bare supersede, so a keyed close
 * takes the same scope a judged one does: the claim, the siblings from its observation that
 * are about the same thing, and the entity descriptions that restate what it said. A mechanical
 * close that left a frozen gloss stating the old value would answer with the sentence the
 * correction just retired.
 */
export async function closeKeyedClaimsInTransaction(
  tx: GraphTransaction,
  input: KeyedCloseInput,
): Promise<KeyedCloseResult> {
  const mates = await tx.run(
    KEYED_CLAIM_MATES,
    {
      subjectEntityId: input.subjectEntityId,
      aspectNorm: input.aspectNorm,
      newId: input.newId,
      episodeId: input.episodeId,
      labels: [...FACT_NODE_LABELS],
    },
    (row) => row.id as string,
  );

  const families: SubjectFamilyResult[] = [];
  for (const mate of mates) {
    families.push(
      await supersedeSubjectFamilyInTransaction(tx, {
        claimId: mate,
        newId: input.newId,
        relatednessFloor: input.relatednessFloor,
        now: input.now,
        validUntil: input.validUntil,
        signals: KEYED_CLOSE_SIGNALS,
        provenance: [KEYED_CLOSE_METHOD],
      }),
    );
  }

  return { closedIds: families.flatMap((family) => family.closedIds), families };
}

/**
 * Moves every claim keyed on an absorbed identity onto the canonical, and names what it moved.
 *
 * A merge that left the key behind would leave it pointing at a node the graph no longer
 * answers for, so the claim stops matching its own successors and falls to the judge. That is
 * the safe direction rather than a wrong close, which is why this is a quality repair and not
 * a correctness gate, but a key nothing can match is still a key that does no work.
 */
const FORWARD_CLAIM_SUBJECTS = [
  'UNWIND $mergedIds AS mergedId',
  'MATCH (c:Memory)',
  `WHERE c.${CLAIM_SUBJECT_PROPERTY} = mergedId`,
  `SET c.${CLAIM_SUBJECT_PROPERTY} = $canonicalId`,
  'RETURN mergedId AS merged_id, c.id AS id',
  'ORDER BY merged_id, id',
].join('\n');

export type ForwardedClaimSubject = {
  readonly mergedId: string;
  readonly claimId: string;
};

export async function forwardClaimSubjectsInTransaction(
  tx: GraphTransaction,
  input: { readonly mergedIds: readonly string[]; readonly canonicalId: string },
): Promise<ForwardedClaimSubject[]> {
  if (input.mergedIds.length === 0) {
    return [];
  }
  return tx.run(
    FORWARD_CLAIM_SUBJECTS,
    { mergedIds: [...input.mergedIds], canonicalId: input.canonicalId },
    (row) => ({ mergedId: row.merged_id as string, claimId: row.id as string }),
  );
}

/**
 * Puts the recorded claims back on the identity a split restores. The subject is the new node
 * rather than the absorbed one, matching the edges: an unmerge only ever adds, and the closed
 * duplicate stays closed.
 *
 * A claim whose key has since moved on to some other canonical belongs to that merge's trail,
 * so the write is guarded on the key still reading the canonical it is being taken off.
 */
const RESTORE_CLAIM_SUBJECTS = [
  'UNWIND $claimIds AS claimId',
  'MATCH (c:Memory { id: claimId })',
  `WHERE c.${CLAIM_SUBJECT_PROPERTY} = $canonicalId`,
  `SET c.${CLAIM_SUBJECT_PROPERTY} = $subjectEntityId`,
  'RETURN c.id AS id',
].join('\n');

export type RestoreClaimSubjectsInput = {
  readonly claimIds: readonly string[];
  /** The identity the merge forwarded onto, which is the only key this may take a claim off. */
  readonly canonicalId: string;
  readonly subjectEntityId: string;
};

export async function restoreClaimSubjectsInTransaction(
  tx: GraphTransaction,
  input: RestoreClaimSubjectsInput,
): Promise<string[]> {
  if (input.claimIds.length === 0) {
    return [];
  }
  return tx.run(
    RESTORE_CLAIM_SUBJECTS,
    {
      claimIds: [...input.claimIds],
      canonicalId: input.canonicalId,
      subjectEntityId: input.subjectEntityId,
    },
    (row) => row.id as string,
  );
}
