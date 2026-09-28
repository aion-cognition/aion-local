import { MAX_LINEAGE_HOPS } from '../../infrastructure/graph/claim-lineage-queries.js';

/**
 * One allowance per request, spent by every subread it makes.
 *
 * A fresh allowance per recursion level or per candidate is not a bound: a request that fans
 * out wide enough spends any per-step number an unbounded number of times. So the numbers below
 * are the request's whole budget, and an address that does not fit gets a named outcome rather
 * than disappearing from the answer.
 *
 * These are implementation constants, not operator knobs. Changing one takes a recorded bound,
 * never an unlimited fallback.
 */

export type EvidenceLimits = {
  /** Addresses one request may name. */
  readonly requestedIds: number;
  /** Relation rows one request may read across every traversal it makes. */
  readonly relationRows: number;
  /** Serialized metadata one request may return. */
  readonly metadataBytes: number;
  /** Raw content one request may decode, charged from the stored size before decoding. */
  readonly decodedRawBytes: number;
  /** Reads of the publication checkpoint: one to certify, one to recheck. */
  readonly checkpointAttempts: number;
  /** The ancestry bound, which is the walk's own and stays where the walk defines it. */
  readonly lineageHops: number;
};

export const EVIDENCE_LIMITS: EvidenceLimits = {
  requestedIds: 256,
  relationRows: 4096,
  metadataBytes: 256 * 1024,
  decodedRawBytes: 256 * 1024,
  checkpointAttempts: 2,
  lineageHops: MAX_LINEAGE_HOPS,
};

/** Which bound a charge ran into, kept apart in diagnostics though the transport says one word. */
export type BudgetLimitKind =
  | 'requested_ids'
  | 'relation_rows'
  | 'metadata_bytes'
  | 'decoded_raw_bytes'
  | 'checkpoint_attempts';

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** UTF-16 code units, which is what a rendered envelope is measured in. */
export function utf16CodeUnits(text: string): number {
  return text.length;
}

/**
 * The request's running allowance. A charge that does not fit spends nothing and returns the
 * bound it hit, so a caller records one outcome for the address it could not serve and the
 * remaining allowance still covers the addresses it can.
 */
export class RequestBudget {
  readonly #limits: EvidenceLimits;
  #ids = 0;
  #rows = 0;
  #metadataBytes = 0;
  #rawBytes = 0;
  #checkpoints = 0;

  constructor(limits: EvidenceLimits = EVIDENCE_LIMITS) {
    this.#limits = limits;
  }

  get limits(): EvidenceLimits {
    return this.#limits;
  }

  chargeIds(count: number): BudgetLimitKind | undefined {
    if (this.#ids + count > this.#limits.requestedIds) {
      return 'requested_ids';
    }
    this.#ids += count;
    return undefined;
  }

  chargeRelationRows(count: number): BudgetLimitKind | undefined {
    if (this.#rows + count > this.#limits.relationRows) {
      return 'relation_rows';
    }
    this.#rows += count;
    return undefined;
  }

  chargeMetadataBytes(bytes: number): BudgetLimitKind | undefined {
    if (this.#metadataBytes + bytes > this.#limits.metadataBytes) {
      return 'metadata_bytes';
    }
    this.#metadataBytes += bytes;
    return undefined;
  }

  chargeRawBytes(bytes: number): BudgetLimitKind | undefined {
    if (this.#rawBytes + bytes > this.#limits.decodedRawBytes) {
      return 'decoded_raw_bytes';
    }
    this.#rawBytes += bytes;
    return undefined;
  }

  takeCheckpointAttempt(): BudgetLimitKind | undefined {
    if (this.#checkpoints + 1 > this.#limits.checkpointAttempts) {
      return 'checkpoint_attempts';
    }
    this.#checkpoints += 1;
    return undefined;
  }

  /** What the request has spent, for a caller reporting why an answer stopped where it did. */
  spent(): Readonly<Record<BudgetLimitKind, number>> {
    return {
      requested_ids: this.#ids,
      relation_rows: this.#rows,
      metadata_bytes: this.#metadataBytes,
      decoded_raw_bytes: this.#rawBytes,
      checkpoint_attempts: this.#checkpoints,
    };
  }
}

/** The judgment routes that assemble evidence through this resolver. */
export const JUDGE_ROUTES = [
  'live_supersession',
  'proposal_resolution',
  'claim_dedup',
  'entity_merge',
] as const;

export type JudgeRoute = (typeof JUDGE_ROUTES)[number];

/**
 * What one route may render into a judge's input, in UTF-16 code units. Each pass subtracts its
 * own fixed prompt and output reserve from this, so the number here is the whole envelope rather
 * than the room left inside it.
 *
 * Sized to the hosted models the judges run on, about 33K tokens of a window of 200K (Haiku 4.5)
 * or more (GPT-6 Luna), and kept under the request's own 256 KiB decode budget above, which still
 * binds first on a source larger than that. It was 16,384, a round figure nothing measured: on the
 * live substrate it withheld every entity-merge pair whose required sources ran longer, one side
 * of one measured at 72,581 units before any prompt, so those judgments could never be asked.
 */
export const JUDGE_ROUTE_ALLOWANCE: Readonly<Record<JudgeRoute, number>> = {
  live_supersession: 131_072,
  proposal_resolution: 131_072,
  claim_dedup: 131_072,
  entity_merge: 131_072,
};

/**
 * Units held back for one judge's answer. The evidence may not spend them: an assembled input
 * that fills the envelope leaves the answer nowhere to go.
 */
export const JUDGE_OUTPUT_RESERVE = 512;

/**
 * What one side costs beyond the text itself: the labels, separators and escaping a message
 * carries. Counted so admission measures the message rather than the payload inside it.
 */
export const RENDERED_SIDE_OVERHEAD = 64;

/**
 * Whether the messages a route is about to send fit what it may spend.
 *
 * The object admitted is the object submitted: every message, system prompt included, counted as
 * it will be serialized. A reserve measured from a constant says what the prompt costs; it does
 * not say what the caller assembled around it, and only this count does.
 */
export function admitRenderedInput(
  route: JudgeRoute,
  messages: readonly { readonly content: string }[],
): { readonly status: 'admitted' } | { readonly status: 'over'; readonly units: number } {
  const units = messages.reduce(
    (total, message) => total + utf16CodeUnits(message.content) + RENDERED_SIDE_OVERHEAD,
    0,
  );
  return units <= JUDGE_ROUTE_ALLOWANCE[route] ? { status: 'admitted' } : { status: 'over', units };
}

export type RouteAllowance = {
  readonly route: JudgeRoute;
  /** The prompt and output units this route reserves before any evidence is rendered. */
  readonly reservedUnits: number;
};

/**
 * The units a route has left for evidence. A route reserving more than its whole allowance has
 * no capacity at all, which blocks its required evidence rather than rendering a clipped prompt.
 */
export function renderableUnits(allowance: RouteAllowance): number {
  return Math.max(0, JUDGE_ROUTE_ALLOWANCE[allowance.route] - allowance.reservedUnits);
}
