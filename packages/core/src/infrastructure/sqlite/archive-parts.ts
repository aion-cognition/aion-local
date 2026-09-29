import type { SqliteHandle } from './database.js';

/**
 * Reads of one archived payload a part at a time.
 *
 * A payload is one JSON text with no stored offsets for its parts, so the only way to read less
 * than all of it is to let SQLite walk the JSON and hand back the one element asked for. Nothing
 * here decodes a whole payload into memory: the proof read never selects the payload, the locate
 * returns part coordinates and sizes, and the part read returns one element's JSON text. SQLite
 * still parses each payload it is asked about. That work stays inside the acceptance bound on a
 * request's size, and the caller bounds how many payloads it asks about.
 */

export type ArchivePartKind = 'turn' | 'tool_execution' | 'observation';

/** The array each part kind lives in, closed so a path is never built from caller text. */
const PART_ARRAYS: Readonly<Record<ArchivePartKind, string>> = {
  turn: '$.turns',
  tool_execution: '$.tool_executions',
  observation: '$.observations',
};

/** The identity columns of one archive row, which is everything its proof needs. */
export type ArchivedIdentity = {
  readonly id: string;
  readonly identity: string;
  readonly contentHash: string;
  readonly schemaVersion: number;
};

export function readArchivedIdentity(
  db: SqliteHandle,
  archiveId: string,
): ArchivedIdentity | undefined {
  const row = db
    .prepare(
      'SELECT id, identity, content_hash, schema_version FROM experience_archive WHERE id = ?',
    )
    .get(archiveId) as
    { id: string; identity: string; content_hash: string; schema_version: number } | undefined;
  return row === undefined
    ? undefined
    : {
        id: row.id,
        identity: row.identity,
        contentHash: row.content_hash,
        schemaVersion: row.schema_version,
      };
}

export type LocatedPart = {
  readonly partKind: ArchivePartKind;
  readonly ordinal: number;
  /** The UTF-8 length of the part's own JSON text, which is what reading it decodes. */
  readonly storedBytes: number;
};

export type PartLocation = {
  /** The first part within the size bound that spells a name from both sets. */
  readonly together?: LocatedPart;
  /** Per name set, the first part within the size bound that spells one of its names. */
  readonly first: readonly [LocatedPart | undefined, LocatedPart | undefined];
  /** The first part within the size bound, whatever it says. */
  readonly opening?: LocatedPart;
  /** Per name set, the parts that spell one of its names and are over the size bound. */
  readonly oversized: readonly [number, number];
};

/**
 * Each part's kind, position in render order, size and literal text, per row.
 *
 * A turn is searched on its text, a tool execution on its tool, input and output, an observation
 * on itself: the fields the rendered part shows. `json_quote` sizes each element as the JSON text
 * a part read returns, strings included.
 */
const ARCHIVE_PARTS = (['turn', 'tool_execution', 'observation'] as const)
  .map((kind, rank) => {
    const body = {
      turn: "coalesce(p.value ->> '$.text', '')",
      tool_execution:
        "coalesce(p.value ->> '$.tool', '') || char(10) || coalesce(p.value ->> '$.input', '')" +
        " || char(10) || coalesce(p.value ->> '$.output', '')",
      observation: 'CAST(p.value AS TEXT)',
    }[kind];
    return `SELECT '${kind}' AS kind, ${String(rank)} AS rank, p.key AS ordinal,
        length(CAST(json_quote(p.value) AS BLOB)) AS bytes, ${body} AS body
      FROM experience_archive a, json_each(a.payload_json, '${PART_ARRAYS[kind]}') p
      WHERE a.id = @archiveId`;
  })
  .join('\nUNION ALL\n');

/**
 * Whether the body spells a name in the set. SQLite's `lower` folds ASCII only, so the caller
 * supplies the case variants that reach the rest.
 */
function spells(set: '@left' | '@right'): string {
  return `EXISTS (SELECT 1 FROM json_each(${set}) n
    WHERE instr(body, n.value) > 0 OR instr(lower(body), lower(n.value)) > 0)`;
}

function firstWhere(condition: string): string {
  return `(SELECT json_object('kind', kind, 'ordinal', ordinal, 'bytes', bytes) FROM marked
    WHERE ${condition} ORDER BY rank, ordinal LIMIT 1)`;
}

const LOCATE = `WITH parts AS MATERIALIZED (${ARCHIVE_PARTS}),
  marked AS MATERIALIZED (
    SELECT kind, rank, ordinal, bytes, ${spells('@left')} AS left_hit,
      ${spells('@right')} AS right_hit
    FROM parts
  )
  SELECT
    ${firstWhere('left_hit AND right_hit AND bytes <= @cap')} AS together,
    ${firstWhere('left_hit AND bytes <= @cap')} AS first_left,
    ${firstWhere('right_hit AND bytes <= @cap')} AS first_right,
    ${firstWhere('bytes <= @cap')} AS opening,
    (SELECT count(*) FROM marked WHERE left_hit AND bytes > @cap) AS oversized_left,
    (SELECT count(*) FROM marked WHERE right_hit AND bytes > @cap) AS oversized_right`;

type LocateRow = {
  together: string | null;
  first_left: string | null;
  first_right: string | null;
  opening: string | null;
  oversized_left: number;
  oversized_right: number;
};

function located(json: string | null): LocatedPart | undefined {
  if (json === null) {
    return undefined;
  }
  const part = JSON.parse(json) as { kind: ArchivePartKind; ordinal: number; bytes: number };
  return { partKind: part.kind, ordinal: part.ordinal, storedBytes: part.bytes };
}

/**
 * Where two sets of names appear in one archived payload, without handing the payload back.
 * Throws on a payload that is not JSON, which a caller treats as an unresolved mapping.
 */
export function locateArchiveParts(
  db: SqliteHandle,
  archiveId: string,
  names: readonly [readonly string[], readonly string[]],
  partBytes: number,
): PartLocation {
  const row = db.prepare(LOCATE).get({
    archiveId,
    left: JSON.stringify(names[0]),
    right: JSON.stringify(names[1]),
    cap: partBytes,
  }) as LocateRow;
  const together = located(row.together);
  const opening = located(row.opening);
  return {
    ...(together === undefined ? {} : { together }),
    first: [located(row.first_left), located(row.first_right)],
    ...(opening === undefined ? {} : { opening }),
    oversized: [row.oversized_left, row.oversized_right],
  };
}

/** One part's JSON text as the archive holds it, or nothing when the payload has no such part. */
export function readArchivePart(
  db: SqliteHandle,
  archiveId: string,
  part: { readonly partKind: ArchivePartKind; readonly ordinal: number },
): string | undefined {
  if (!Number.isInteger(part.ordinal) || part.ordinal < 0) {
    return undefined;
  }
  const path = `${PART_ARRAYS[part.partKind]}[${String(part.ordinal)}]`;
  const row = db
    .prepare('SELECT payload_json -> ? AS part FROM experience_archive WHERE id = ?')
    .get(path, archiveId) as { part: string | null } | undefined;
  return row?.part ?? undefined;
}
