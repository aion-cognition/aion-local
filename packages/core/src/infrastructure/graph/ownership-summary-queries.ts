import type { GraphTransaction } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { decimalSequence } from '../publication/json.js';

/**
 * The ownership summary as graph node properties, and the predicate a nomination reads it with.
 *
 * The summary is a projection of records SQLite owns, so the two stores cannot be written in one
 * transaction. The publication that changes incidence writes its SQLite intent first and these
 * properties inside the same operation's graph transaction, and the acknowledgment afterwards is
 * what makes the projection trustworthy. Between the graph commit and that acknowledgment the
 * properties are durable and unproved at the same time, which is exactly what the sequence and
 * the substrate identity below let a plain Cypher ordering detect.
 *
 * This is an ordering hint and never a checkpoint. A seed query takes no guard, recovers no
 * receipt and waits for nothing, and an unproved summary loses its discount rather than acting
 * on a value nobody has proved.
 */

export const OWNERSHIP_PROPERTIES = {
  /** Caller-independent: every session the records name for this node. */
  sessions: 'source_sessions',
  /** Some contribution had no session behind it, so no verdict may be derived. */
  unknownAttribution: 'has_unknown_attribution',
  /** Whether the scopes the summary was derived from had been counted. */
  census: 'ownership_census_established',
  /** Moves when the derived answer moves, so an unchanged answer rewrites nothing. */
  version: 'ownership_evidence_version',
  /** The publication that wrote this projection, in the ordered form below. */
  sequence: 'ownership_publication_sequence',
  /** The pair this summary belongs to. A watermark from another substrate certifies nothing. */
  substrate: 'ownership_substrate_id',
} as const;

/**
 * Publication sequences are decimal text and run past the safe-integer range, so a stored one is
 * padded to a fixed width. Cypher compares the padded strings the way the protocol orders the
 * numbers; comparing the bare text would put 10 behind 9.
 */
const SEQUENCE_WIDTH = 20;

export function orderedPublicationSequence(value: string): string {
  return decimalSequence(value).toString().padStart(SEQUENCE_WIDTH, '0');
}

export type OwnershipProjectionWrite = {
  readonly nodeId: string;
  readonly sessions: readonly string[];
  readonly unknownAttribution: boolean;
  readonly censusEstablished: boolean;
  readonly evidenceVersion: string;
  /** The publishing operation's sequence, as the coordinator hands it out. */
  readonly sequence: string;
  readonly substrateId: string;
};

const PROJECTION = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
  `WHERE n.${OWNERSHIP_PROPERTIES.version} IS NULL`,
  `   OR n.${OWNERSHIP_PROPERTIES.version} <> $version`,
  `   OR n.${OWNERSHIP_PROPERTIES.substrate} IS NULL`,
  `   OR n.${OWNERSHIP_PROPERTIES.substrate} <> $substrateId`,
  `SET n.${OWNERSHIP_PROPERTIES.sessions} = $sessions,`,
  `    n.${OWNERSHIP_PROPERTIES.unknownAttribution} = $unknownAttribution,`,
  `    n.${OWNERSHIP_PROPERTIES.census} = $census,`,
  `    n.${OWNERSHIP_PROPERTIES.version} = $version,`,
  `    n.${OWNERSHIP_PROPERTIES.sequence} = $sequence,`,
  `    n.${OWNERSHIP_PROPERTIES.substrate} = $substrateId`,
  'RETURN n.id AS id',
].join('\n');

/**
 * Writes one node's summary inside the publishing operation's graph transaction. Returns whether
 * it wrote: an operation that leaves the derived answer where it was moves no sequence, so an
 * eviction that changes no incidence leaves a trusted summary trusted.
 */
export async function projectOwnershipSummary(
  tx: GraphTransaction,
  input: OwnershipProjectionWrite,
): Promise<boolean> {
  const rows = await tx.run(
    PROJECTION,
    {
      id: input.nodeId,
      sessions: [...input.sessions],
      unknownAttribution: input.unknownAttribution,
      census: input.censusEstablished,
      version: input.evidenceVersion,
      sequence: orderedPublicationSequence(input.sequence),
      substrateId: input.substrateId,
    },
    (row) => row.id as string,
  );
  return rows.length === 1;
}

/** The parameters a caller binds beside the predicate below. */
const OWNERSHIP_PARAMETERS = {
  sessionId: '$ownSessionId',
  substrateId: '$ownSubstrateId',
  acknowledged: '$ownAcknowledgedSequence',
} as const;

/**
 * The Cypher boolean a pre-limit ordering discounts on: this session and nobody else, on a
 * summary this substrate published and has acknowledged.
 *
 * Everything else is unknown ownership and takes no discount. That covers a missing summary, one
 * written above the acknowledged bound, one carrying an unattributable contribution, one whose
 * scopes were never counted, and one a different restored substrate wrote. The failure this shape
 * avoids is the one nothing downstream can undo: an unproved own-only value discounting a shared
 * memory out of the limit before anything can certify it.
 */
export function ownOnlyDiscount(nodeVar: string): string {
  const { sessionId, substrateId, acknowledged } = OWNERSHIP_PARAMETERS;
  return [
    `(${nodeVar}.${OWNERSHIP_PROPERTIES.substrate} = ${substrateId}`,
    `AND ${nodeVar}.${OWNERSHIP_PROPERTIES.census} = true`,
    `AND ${nodeVar}.${OWNERSHIP_PROPERTIES.unknownAttribution} = false`,
    `AND ${nodeVar}.${OWNERSHIP_PROPERTIES.sequence} IS NOT NULL`,
    `AND ${nodeVar}.${OWNERSHIP_PROPERTIES.sequence} <= ${acknowledged}`,
    `AND ${nodeVar}.${OWNERSHIP_PROPERTIES.sessions} IS NOT NULL`,
    `AND ${sessionId} IN ${nodeVar}.${OWNERSHIP_PROPERTIES.sessions}`,
    `AND size([s IN ${nodeVar}.${OWNERSHIP_PROPERTIES.sessions} WHERE s <> ${sessionId}]) = 0)`,
  ].join('\n        ');
}
