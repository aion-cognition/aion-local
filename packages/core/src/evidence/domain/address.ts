/**
 * How a caller names the evidence it wants.
 *
 * The same original graph id resolves whether its projection is still there or the source now
 * lives only in the archive, so a caller never has to know where the bytes sit. Parts that
 * never had graph ids of their own are named by tuple instead, which is what keeps two
 * observations of one source two addresses rather than one.
 */

export const SOURCE_PART_KINDS = ['turn', 'observation', 'tool_execution'] as const;

export type SourcePartKind = (typeof SOURCE_PART_KINDS)[number];

export type EvidenceAddress =
  | { readonly kind: 'id'; readonly id: string }
  | {
      readonly kind: 'part';
      readonly sourceId: string;
      readonly partKind: SourcePartKind;
      readonly ordinal: number;
    };

export function idAddress(id: string): EvidenceAddress {
  return { kind: 'id', id };
}

export function partAddress(
  sourceId: string,
  partKind: SourcePartKind,
  ordinal: number,
): EvidenceAddress {
  return { kind: 'part', sourceId, partKind, ordinal };
}

/**
 * The canonical request key, as a JSON tuple. Every requested address gets a result under this
 * key, so a caller that asked about something absent reads an outcome rather than an omission.
 */
export function evidenceRequestKey(address: EvidenceAddress): string {
  return address.kind === 'id'
    ? JSON.stringify(['id', address.id])
    : JSON.stringify(['part', address.sourceId, address.partKind, address.ordinal]);
}

function isPartKind(value: unknown): value is SourcePartKind {
  return SOURCE_PART_KINDS.includes(value as SourcePartKind);
}

/** The reverse, refused rather than guessed at: a key this substrate did not produce is an error. */
export function evidenceAddressFromKey(key: string): EvidenceAddress {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed)) {
    throw new Error(`evidence request key is not a tuple: ${key}`);
  }
  const [kind, first, second, third] = parsed as readonly unknown[];
  if (kind === 'id' && typeof first === 'string' && parsed.length === 2) {
    return idAddress(first);
  }
  if (
    kind === 'part' &&
    parsed.length === 4 &&
    typeof first === 'string' &&
    isPartKind(second) &&
    Number.isInteger(third)
  ) {
    return partAddress(first, second, third as number);
  }
  throw new Error(`evidence request key is not an address: ${key}`);
}

export function sameEvidenceAddress(left: EvidenceAddress, right: EvidenceAddress): boolean {
  return evidenceRequestKey(left) === evidenceRequestKey(right);
}

/** The source an address belongs to, which a part address carries and an id address does not. */
export function addressSourceId(address: EvidenceAddress): string | undefined {
  return address.kind === 'part' ? address.sourceId : undefined;
}
