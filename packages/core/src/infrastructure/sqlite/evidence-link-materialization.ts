import type { SqliteHandle } from './database.js';

/**
 * The two writers that record a link version nobody stated: the relationship a node's own writer
 * recorded when it made it, and the retirement a merge or a coverage close appends.
 *
 * Split from `evidence-links.ts` at the 500-line cap, and along the seam the file's own docstring
 * already draws: that module is the stated-reference chain, and these two write the same table for
 * a different reason. Nothing about the version chain is decided here that was not decided there.
 *
 * The identity rule is the one difference that matters, and it is why neither of these is re-adopted
 * the way a stated version is: both key the version on the OPERATION that wrote it, so a retry
 * takes a new key rather than finding the old row. A discarded attempt's version is released by its
 * own writer, never inherited.
 */

export type MaterializedLinkVersion = {
  readonly linkId: string;
  /** The classification the record carries. An incidence row's role must equal it. */
  readonly kind: string;
  readonly qualifier: string;
  readonly fromId: string;
  readonly toId: string;
  /** The relationship identity the graph minted, preserved so a rebuild produces this link. */
  readonly originalRelId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly recordedValues: Record<string, unknown>;
  readonly temporalProof: Record<string, unknown>;
  readonly observedAt: Date;
  /** Which writer recorded this link, stored on the row. */
  readonly recordSource?: 'derived_node' | 'narrative_coverage';
};

export type MaterializedLinkOutcome = {
  readonly version: number;
  /**
   * False when a committed version of this link already stands. A baseline never writes over a
   * newer acknowledged statement: the backfill is the oldest thing anybody has to say about the
   * pair, and appending it would make it the newest.
   */
  readonly recorded: boolean;
};

/**
 * Records one legacy relationship as a prepared version of its link.
 *
 * The link row is upserted on its identity, so the same edge enumerated by a restarted pass
 * lands on the same row; the version is keyed on the operation, so a replayed publication
 * writes one. A link that already carries a committed version is left exactly as it is and
 * reported as such, which is how the pass preserves what a later writer acknowledged.
 */
export function prepareMaterializedLinkVersion(
  db: SqliteHandle,
  input: MaterializedLinkVersion,
): MaterializedLinkOutcome {
  return db
    .transaction((): MaterializedLinkOutcome => {
      db.prepare(
        `INSERT INTO evidence_links
           (link_id, kind, qualifier, from_id, to_id, original_rel_id, record_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (link_id) DO UPDATE SET
           original_rel_id = COALESCE(evidence_links.original_rel_id, excluded.original_rel_id)`,
      ).run(
        input.linkId,
        input.kind,
        input.qualifier,
        input.fromId,
        input.toId,
        input.originalRelId,
        input.recordSource ?? 'derived_node',
        input.observedAt.toISOString(),
      );
      const held = db
        .prepare(
          'SELECT version FROM evidence_link_versions WHERE link_id = ? AND operation_key = ?',
        )
        .get(input.linkId, input.operationKey) as { version: number } | undefined;
      if (held !== undefined) {
        return { version: held.version, recorded: true };
      }
      const committed = db
        .prepare(
          `SELECT MAX(version) AS n FROM evidence_link_versions
           WHERE link_id = ? AND known_from IS NOT NULL`,
        )
        .get(input.linkId) as { n: number | null };
      if (committed.n !== null) {
        return { version: committed.n, recorded: false };
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
            observed_at, operation_key, operation_id)
         VALUES (?, ?, ?, 'materialized', ?, ?, ?, ?, ?)`,
      ).run(
        input.linkId,
        version,
        version === 1 ? null : version - 1,
        JSON.stringify(input.recordedValues),
        JSON.stringify(input.temporalProof),
        input.observedAt.toISOString(),
        input.operationKey,
        input.operationId,
      );
      return { version, recorded: true };
    })
    .immediate();
}

/**
 * Appends a version that retires a link, rather than editing the row that projects it.
 *
 * A merge absorbs a claim, and the absorbed claim's mentions stop standing. Setting `closed` on
 * the current projection alone says so only about now: a question about last week walks the
 * version chain, finds the newest acknowledged version still open, and answers that the mention
 * stands. The retirement is therefore a version of its own, and it is the newest one.
 */
export function prepareRetirementVersion(
  db: SqliteHandle,
  input: {
    readonly linkId: string;
    readonly operationId: string;
    readonly operationKey: string;
    readonly recordedValues: Record<string, unknown>;
    readonly temporalProof: Record<string, unknown>;
    readonly observedAt: Date;
  },
): number | undefined {
  return db
    .transaction((): number | undefined => {
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
      if (high.n === 0) {
        // Nothing to retire. A link with no version was never stated, and inventing a closing
        // version for it would record that something stopped which never started.
        return undefined;
      }
      const version = high.n + 1;
      db.prepare(
        `INSERT INTO evidence_link_versions
           (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
            observed_at, operation_key, operation_id)
         VALUES (?, ?, ?, 'retired', ?, ?, ?, ?, ?)`,
      ).run(
        input.linkId,
        version,
        high.n,
        JSON.stringify(input.recordedValues),
        JSON.stringify(input.temporalProof),
        input.observedAt.toISOString(),
        input.operationKey,
        input.operationId,
      );
      return version;
    })
    .immediate();
}
