import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * The durable half of a stated reference: the link, and the immutable version chain behind it.
 *
 * A reference is accepted here whether or not the graph holds either endpoint. That is the whole
 * point of the record: an endpoint's raw projection can be gone, or the target can be something
 * the substrate does not hold yet, and a caller's assertion has to survive both. The current
 * graph edge is a projection of this chain, never the other way round.
 *
 * `operation_id` binds a version to the publication that owns it, and `known_from` stays null
 * until that publication is acknowledged. A prepared version is therefore durable and outside
 * the committed view at the same time.
 */
export const STATED_LINK_KINDS = ['derived_from', 'corrects', 'confirms'] as const;
export type StatedLinkKind = (typeof STATED_LINK_KINDS)[number];

/**
 * What the target turned out to be. It disambiguates a pair of endpoints that two categories
 * could otherwise share, and it is closed: a write carrying anything else is refused rather
 * than stored as free text nobody can classify later.
 */
export const STATED_LINK_QUALIFIERS = ['source', 'part', 'retained_node', 'unresolved'] as const;
export type StatedLinkQualifier = (typeof STATED_LINK_QUALIFIERS)[number];

export type StatedLinkVersion = {
  readonly linkId: string;
  readonly kind: StatedLinkKind;
  readonly qualifier: StatedLinkQualifier;
  readonly fromId: string;
  readonly toId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly recordedValues: Record<string, unknown>;
  readonly temporalProof: Record<string, unknown>;
  readonly observedAt: Date;
  readonly referenceSourceId: string;
  readonly referenceVersion: number;
};

export function statedLinkId(
  kind: StatedLinkKind,
  qualifier: StatedLinkQualifier,
  fromId: string,
  toId: string,
): string {
  return createHash('sha256').update([kind, qualifier, fromId, toId].join('\n')).digest('hex');
}

/**
 * Records one accepted reference as a prepared version. The link row is upserted, so a second
 * statement about the same pair adds a version rather than a second link, and the version is
 * keyed on the delivery so a retried batch writes one row.
 *
 * Returns the version it took, or the one the delivery already produced.
 */
export function prepareStatedLinkVersion(db: SqliteHandle, input: StatedLinkVersion): number {
  if (!STATED_LINK_KINDS.includes(input.kind)) {
    throw new Error(`stated link ${input.linkId} carries an unclassified kind`);
  }
  if (!STATED_LINK_QUALIFIERS.includes(input.qualifier)) {
    throw new Error(`stated link ${input.linkId} carries an unclassified qualifier`);
  }
  return db
    .transaction((): number => {
      db.prepare(
        `INSERT INTO evidence_links
           (link_id, kind, qualifier, from_id, to_id, record_source, created_at)
         VALUES (?, ?, ?, ?, ?, 'stated_reference', ?)
         ON CONFLICT (link_id) DO NOTHING`,
      ).run(
        input.linkId,
        input.kind,
        input.qualifier,
        input.fromId,
        input.toId,
        input.observedAt.toISOString(),
      );
      const held = db
        .prepare(
          'SELECT version FROM evidence_link_versions WHERE link_id = ? AND operation_key = ?',
        )
        .get(input.linkId, input.operationKey) as { version: number } | undefined;
      if (held !== undefined) {
        return held.version;
      }
      const high = db
        .prepare(
          'SELECT COALESCE(MAX(version), 0) AS n FROM evidence_link_versions WHERE link_id = ?',
        )
        .get(input.linkId) as { n: number };
      const version = high.n + 1;
      db.prepare(
        `INSERT INTO evidence_link_versions
           (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
            observed_at, operation_key, operation_id, reference_source_id, reference_version)
         VALUES (?, ?, ?, 'stated', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.linkId,
        version,
        version === 1 ? null : version - 1,
        JSON.stringify(input.recordedValues),
        JSON.stringify(input.temporalProof),
        input.observedAt.toISOString(),
        input.operationKey,
        input.operationId,
        input.referenceSourceId,
        input.referenceVersion,
      );
      return version;
    })
    .immediate();
}

/**
 * Promotes every version one publication prepared into the committed view. A version outside
 * that operation is untouched, so an acknowledgment can never bless a write it did not make.
 */
export function acknowledgeStatedLinkVersions(
  db: SqliteHandle,
  operationId: string,
  knownFrom: string,
  observedAckAt: string,
): number {
  return db
    .prepare(
      `UPDATE evidence_link_versions SET known_from = ?, observed_ack_at = ?
       WHERE operation_id = ? AND known_from IS NULL`,
    )
    .run(knownFrom, observedAckAt, operationId).changes;
}

export type StatedLinkRow = {
  readonly linkId: string;
  readonly kind: string;
  readonly qualifier: string;
  readonly toId: string;
  /** The side that stated it. Present on a read taken from the target's side. */
  readonly fromId?: string;
  readonly version: number;
  readonly knownFrom: string | null;
  readonly referenceVersion: number | null;
};

/** Every stated reference recorded against one source, in the order it was accepted. */
export function listStatedLinks(db: SqliteHandle, fromId: string): readonly StatedLinkRow[] {
  const rows = db
    .prepare(
      `SELECT l.link_id, l.kind, l.qualifier, l.to_id, v.version, v.known_from, v.reference_version
       FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.from_id = ?
       ORDER BY v.reference_version, l.kind, l.to_id, v.version`,
    )
    .all(fromId) as {
    link_id: string;
    kind: string;
    qualifier: string;
    to_id: string;
    version: number;
    known_from: string | null;
    reference_version: number | null;
  }[];
  return rows.map((row) => ({
    linkId: row.link_id,
    kind: row.kind,
    qualifier: row.qualifier,
    toId: row.to_id,
    version: row.version,
    knownFrom: row.known_from,
    referenceVersion: row.reference_version,
  }));
}

/**
 * How many stated references of one kind a source recorded, without materializing them. A reader
 * with an allowance charges what a read will cost before it pays it, and only a count can say.
 */
export function countStatedLinksOfKind(db: SqliteHandle, fromId: string, kind: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.from_id = ? AND l.kind = ?`,
    )
    .get(fromId, kind) as { n: number };
  return row.n;
}

/** The same rows, of one kind and no more of them than the caller charged for. */
export function listStatedLinksOfKind(
  db: SqliteHandle,
  fromId: string,
  kind: string,
  limit: number,
): readonly StatedLinkRow[] {
  const rows = db
    .prepare(
      `SELECT l.link_id, l.kind, l.qualifier, l.to_id, v.version, v.known_from, v.reference_version
       FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.from_id = ? AND l.kind = ?
       ORDER BY v.reference_version, l.to_id, v.version
       LIMIT ?`,
    )
    .all(fromId, kind, limit) as {
    link_id: string;
    kind: string;
    qualifier: string;
    to_id: string;
    version: number;
    known_from: string | null;
    reference_version: number | null;
  }[];
  return rows.map((row) => ({
    linkId: row.link_id,
    kind: row.kind,
    qualifier: row.qualifier,
    toId: row.to_id,
    version: row.version,
    knownFrom: row.known_from,
    referenceVersion: row.reference_version,
  }));
}

/** How many stated references name one target, charged before the rows behind them are read. */
export function countStatedLinksTo(db: SqliteHandle, toId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.to_id = ?`,
    )
    .get(toId) as { n: number };
  return row.n;
}

/**
 * Every stated reference recorded AT one target, which is how a correction or a confirmation is
 * found from the side it was made about. The edge in the graph is a projection of these rows, so
 * this answers after that projection is gone.
 */
export function listStatedLinksTo(db: SqliteHandle, toId: string): readonly StatedLinkRow[] {
  const rows = db
    .prepare(
      `SELECT l.link_id, l.kind, l.qualifier, l.to_id, l.from_id, v.version, v.known_from,
              v.reference_version
       FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.to_id = ?
       ORDER BY v.known_from, l.kind, l.from_id, v.version`,
    )
    .all(toId) as {
    link_id: string;
    kind: string;
    qualifier: string;
    to_id: string;
    from_id: string;
    version: number;
    known_from: string | null;
    reference_version: number | null;
  }[];
  return rows.map((row) => ({
    linkId: row.link_id,
    kind: row.kind,
    qualifier: row.qualifier,
    toId: row.to_id,
    fromId: row.from_id,
    version: row.version,
    knownFrom: row.known_from,
    referenceVersion: row.reference_version,
  }));
}

/**
 * The values the FIRST accepted version of a link recorded. A later delivery restating the same
 * pair adds a version and does not rewrite what the original statement said, so this is the
 * canonical payload a confirmation is rendered and replayed from.
 */
export function readStatedLinkValues(
  db: SqliteHandle,
  linkId: string,
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT recorded_values_json FROM evidence_link_versions
       WHERE link_id = ? ORDER BY version LIMIT 1`,
    )
    .get(linkId) as { recorded_values_json: string } | undefined;
  return row === undefined
    ? undefined
    : (JSON.parse(row.recorded_values_json) as Record<string, unknown>);
}
