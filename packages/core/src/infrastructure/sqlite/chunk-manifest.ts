import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * The chunk half of the narrative manifest: which sources sealed together, what the unsealed tail
 * still holds, and what a published revision rested on and cited.
 *
 * Membership freezes at the seal and never moves, which is why the chunk's identity is derived
 * from it rather than minted: a retry of the same seal computes the same id and writes nothing,
 * and a different member set is a different chunk by construction. `chunk_members` carries a
 * global `UNIQUE (source_id)`, so a source that is already sealed cannot be sealed again into a
 * second chunk; the insert fails and the whole seal rolls back rather than splitting one source's
 * evidence across two narratives.
 */

/** The partition rule the ids were derived under. A change to it is a new id space, not a patch. */
export const PARTITION_POLICY_VERSION = 1;

export const CHUNK_STATES = ['sealed', 'published'] as const;
export type ChunkState = (typeof CHUNK_STATES)[number];

/**
 * F13 D2's identity. The member set is sorted and deduplicated first, so the same seal computes
 * the same id however the remainder read returned it, and the separator is escaped rather than
 * written as a raw byte.
 */
export function chunkIdentity(
  sessionIdentity: string,
  sourceIds: readonly string[],
  partitionPolicyVersion: number = PARTITION_POLICY_VERSION,
): string {
  const members = [...new Set(sourceIds)].sort();
  return createHash('sha256')
    .update(['chunk', sessionIdentity, String(partitionPolicyVersion), ...members].join('\u0000'))
    .digest('hex');
}

/** How many earlier chunks one seal records an overlap against. A bound, not a survey. */
export const CHUNK_OVERLAP_LIMIT = 16;

export type SealedChunk = {
  readonly chunkId: string;
  readonly sessionId: string;
  readonly partitionPolicyVersion: number;
  readonly state: string;
  readonly sealedAt: string;
  readonly publishedRevisionNo: number | null;
  readonly memberCount: number;
  readonly createdAt: string;
  /** F13 D6: earlier chunks of this session whose world-time span holds this one's earliest member. */
  readonly overlaps: readonly string[] | undefined;
};

type ChunkRowData = {
  chunk_id: string;
  session_id: string;
  partition_policy_version: number;
  state: string;
  sealed_at: string;
  published_revision_no: number | null;
  member_count: number;
  created_at: string;
  overlaps_json: string | null;
};

const SELECT_CHUNK = `SELECT chunk_id, session_id, partition_policy_version, state, sealed_at,
    published_revision_no, member_count, created_at, overlaps_json
  FROM chunks`;

function toChunk(row: ChunkRowData): SealedChunk {
  return {
    chunkId: row.chunk_id,
    sessionId: row.session_id,
    partitionPolicyVersion: row.partition_policy_version,
    state: row.state,
    sealedAt: row.sealed_at,
    publishedRevisionNo: row.published_revision_no,
    memberCount: row.member_count,
    createdAt: row.created_at,
    overlaps: row.overlaps_json === null ? undefined : (JSON.parse(row.overlaps_json) as string[]),
  };
}

/**
 * Earlier chunks of this session whose members' world-time span holds `earliest`.
 *
 * The condition is F13 D6's: an arrival whose world time falls inside a sealed chunk's span does
 * not repartition it. Both bounds are compared against the same moment, so a chunk is named only
 * when the new membership genuinely starts inside it rather than merely before it ended.
 */
function overlappingChunks(
  db: SqliteHandle,
  sessionId: string,
  earliest: string,
  limit: number,
): readonly string[] {
  const rows = db
    .prepare(
      `SELECT c.chunk_id
         FROM chunks c
         JOIN chunk_members m ON m.chunk_id = c.chunk_id
         JOIN source_records r ON r.source_id = m.source_id
        WHERE c.session_id = ?
        GROUP BY c.chunk_id
       HAVING MIN(r.occurred_at) <= ? AND MAX(r.occurred_at) >= ?
        ORDER BY c.sealed_at, c.chunk_id
        LIMIT ?`,
    )
    .all(sessionId, earliest, earliest, limit) as { chunk_id: string }[];
  return rows.map((row) => row.chunk_id);
}

export function readChunk(db: SqliteHandle, chunkId: string): SealedChunk | undefined {
  const row = db.prepare(`${SELECT_CHUNK} WHERE chunk_id = ?`).get(chunkId) as
    ChunkRowData | undefined;
  return row === undefined ? undefined : toChunk(row);
}

export function listSessionChunks(db: SqliteHandle, sessionId: string): readonly SealedChunk[] {
  const rows = db
    .prepare(`${SELECT_CHUNK} WHERE session_id = ? ORDER BY sealed_at, chunk_id`)
    .all(sessionId) as ChunkRowData[];
  return rows.map(toChunk);
}

/** The frozen membership, in the ordinals the seal assigned. */
export function listChunkMembers(db: SqliteHandle, chunkId: string): readonly string[] {
  const rows = db
    .prepare('SELECT source_id FROM chunk_members WHERE chunk_id = ? ORDER BY member_ordinal')
    .all(chunkId) as { source_id: string }[];
  return rows.map((row) => row.source_id);
}

export function chunkOfSource(db: SqliteHandle, sourceId: string): string | undefined {
  const row = db.prepare('SELECT chunk_id FROM chunk_members WHERE source_id = ?').get(sourceId) as
    { chunk_id: string } | undefined;
  return row?.chunk_id;
}

/** The earliest world time in a membership, which is where an overlap is measured from. */
function earliestMemberWorldTime(
  db: SqliteHandle,
  sourceIds: readonly string[],
): string | undefined {
  const placeholders = new Array(sourceIds.length).fill('?').join(', ');
  const row = db
    .prepare(
      `SELECT MIN(occurred_at) AS earliest FROM source_records WHERE source_id IN (${placeholders})`,
    )
    .get(...sourceIds) as { earliest: string | null };
  return row.earliest ?? undefined;
}

export type ChunkSealInput = {
  readonly sessionId: string;
  /** In the order the seal admitted them, which is the order the ordinals record. */
  readonly sourceIds: readonly string[];
  readonly sealedAt: Date;
  readonly partitionPolicyVersion?: number;
};

export type ChunkSealOutcome = {
  readonly chunkId: string;
  /** False when this exact membership was already sealed, which a retry is. */
  readonly created: boolean;
};

/**
 * Writes the chunk row and its frozen membership in one immediate transaction.
 *
 * A repeat is a no-op rather than an error: the id is the membership, so the second call finds
 * the row it would have written. What it refuses is a chunk whose stored membership differs from
 * the one being sealed, which cannot happen through the id and is checked anyway, because a
 * silent disagreement here is a narrative published over a set nobody sealed.
 */
export function sealChunk(db: SqliteHandle, input: ChunkSealInput): ChunkSealOutcome {
  if (input.sourceIds.length === 0) {
    throw new Error('a chunk seals over at least one member');
  }
  const policy = input.partitionPolicyVersion ?? PARTITION_POLICY_VERSION;
  const chunkId = chunkIdentity(input.sessionId, input.sourceIds, policy);
  return db
    .transaction((): ChunkSealOutcome => {
      const existing = readChunk(db, chunkId);
      if (existing !== undefined) {
        const held = [...listChunkMembers(db, chunkId)].sort();
        const asked = [...new Set(input.sourceIds)].sort();
        if (held.join('\u0000') !== asked.join('\u0000')) {
          throw new Error(`chunk ${chunkId} is already sealed over a different member set`);
        }
        return { chunkId, created: false };
      }
      const sealedAt = input.sealedAt.toISOString();
      // Computed inside the seal's own transaction, over the chunks that were already sealed when
      // this membership froze. Membership stays append-only: nothing about them moves.
      const earliest = earliestMemberWorldTime(db, input.sourceIds);
      const overlaps =
        earliest === undefined
          ? []
          : overlappingChunks(db, input.sessionId, earliest, CHUNK_OVERLAP_LIMIT);
      db.prepare(
        `INSERT INTO chunks (chunk_id, session_id, partition_policy_version, state, sealed_at,
           member_count, created_at, overlaps_json)
         VALUES (?, ?, ?, 'sealed', ?, ?, ?, ?)`,
      ).run(
        chunkId,
        input.sessionId,
        policy,
        sealedAt,
        input.sourceIds.length,
        sealedAt,
        JSON.stringify(overlaps),
      );
      const member = db.prepare(
        'INSERT INTO chunk_members (chunk_id, source_id, member_ordinal) VALUES (?, ?, ?)',
      );
      input.sourceIds.forEach((sourceId, ordinal) => {
        member.run(chunkId, sourceId, ordinal);
      });
      return { chunkId, created: true };
    })
    .immediate();
}

export type RemainderMember = {
  readonly sourceId: string;
  readonly captureOrderValue: string;
  readonly occurredAt: string;
  readonly createdAt: string;
};

/** A source seals into a chunk only on a proved identity, so the state is named rather than typed. */
const VERIFIED = 'verified';

/**
 * The ordering bases a LIVE cursor is written under.
 *
 * A `pinned` basis is the migration's placeholder for a source whose position nobody could
 * establish, and reading it as a live cursor value would order the legacy population into the
 * chunk a live tail is sealing. The two populations stay apart here rather than in the caller.
 */
const LIVE_CAPTURE_BASES = "('archive_acceptance', 'graph_tx_from')";

/**
 * Eligibility for live membership: the identity is proved and the position is a live one.
 *
 * The verification test is a literal comparison on a NOT NULL column and the basis test names its
 * accepted values, so neither can silently drop a row into a NULL comparison. Initial verification
 * is what this decides. Evidence that becomes unreadable AFTER membership froze is a different
 * question with a different answer: that chunk stays sealed and its publication blocks.
 */
const LIVE_MEMBER = `r.verification_status = '${VERIFIED}'
         AND r.capture_order_basis IN ${LIVE_CAPTURE_BASES}`;

/**
 * The complement, written out rather than as `NOT (...)`.
 *
 * `basis IN (…)` is NULL for a NULL basis, and `NOT NULL` is NULL too, so a negated predicate
 * would drop a NULL-basis row out of BOTH populations — which is precisely the silent loss these
 * two reads exist to make impossible. `verification_status` is NOT NULL, so its test is safe.
 */
const HELD_MEMBER = `(r.verification_status <> '${VERIFIED}'
         OR r.capture_order_basis IS NULL
         OR r.capture_order_basis NOT IN ${LIVE_CAPTURE_BASES})`;

const UNSEALED = 'NOT EXISTS (SELECT 1 FROM chunk_members m WHERE m.source_id = r.source_id)';

/**
 * The session's unsealed tail, derived rather than stored: the sources this session accepted, up
 * to the remainder watermark, that no chunk has taken and that are eligible to be taken.
 *
 * The watermark bound is what keeps the tail to acknowledged acceptances. A source whose
 * acceptance has not been acknowledged is not part of any session yet, and sealing it would freeze
 * a membership around a publication that may still be discarded. The eligibility bound is what
 * keeps the initial verification question out of the seal: a source the migration pinned has no
 * proved identity, so it waits outside every chunk instead of freezing into one.
 */
export function readRemainderMembers(
  db: SqliteHandle,
  sessionId: string,
  limit: number,
): readonly RemainderMember[] {
  const rows = db
    .prepare(
      `SELECT r.source_id, r.capture_order_value, r.occurred_at, r.created_at
       FROM source_records r
       JOIN session_remainders s ON s.session_id = r.session_id
       WHERE r.session_id = ?
         AND ${LIVE_MEMBER}
         AND r.capture_order_value IS NOT NULL
         AND r.capture_order_value <= s.watermark
         AND ${UNSEALED}
       ORDER BY r.capture_order_value, r.source_id
       LIMIT ?`,
    )
    .all(sessionId, limit) as {
    source_id: string;
    capture_order_value: string;
    occurred_at: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    captureOrderValue: row.capture_order_value,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  }));
}

/**
 * ELIGIBLE unsealed sources of this session that carry no capture position.
 *
 * The remainder read above orders on `capture_order_value` and a NULL never satisfies its bound,
 * so such a source would silently never be sealed and never be narrated. It is named here instead
 * and the caller refuses rather than quietly leaving it out — but only for a source that was
 * otherwise going to be a member. A pin the migration left behind is not a live member and is not
 * a reason to stop the verified tail beside it; it is reported by `heldSessionSources`.
 */
export function unorderedSessionSources(db: SqliteHandle, sessionId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT r.source_id FROM source_records r
       WHERE r.session_id = ? AND ${LIVE_MEMBER} AND r.capture_order_value IS NULL
         AND ${UNSEALED}
       ORDER BY r.source_id`,
    )
    .all(sessionId) as { source_id: string }[];
  return rows.map((row) => row.source_id);
}

export type HeldSource = {
  readonly sourceId: string;
  readonly verificationStatus: string;
  readonly verificationReason: string | null;
  readonly captureOrderBasis: string | null;
};

/**
 * Unsealed sources this session holds OUT of live membership, with what holds them.
 *
 * Excluding them silently is the loss this read exists to prevent: a pinned identity or a legacy
 * ordering value means the source waits for the migration that owns it, and a caller that reports
 * the count can tell a session with nothing left to seal from one whose tail nobody can take.
 */
export function heldSessionSources(db: SqliteHandle, sessionId: string): readonly HeldSource[] {
  const rows = db
    .prepare(
      `SELECT r.source_id, r.verification_status, r.verification_reason, r.capture_order_basis
       FROM source_records r
       WHERE r.session_id = ?
         AND ${HELD_MEMBER}
         AND ${UNSEALED}
       ORDER BY r.source_id`,
    )
    .all(sessionId) as {
    source_id: string;
    verification_status: string;
    verification_reason: string | null;
    capture_order_basis: string | null;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    verificationStatus: row.verification_status,
    verificationReason: row.verification_reason,
    captureOrderBasis: row.capture_order_basis,
  }));
}

export type NarrativeRevisionBinding = {
  readonly family: 'chunk' | 'overview';
  readonly familyKey: string;
  readonly revisionNo: number;
  readonly state: string;
  /** Frozen members behind it. Zero for an overview, whose membership is its window. */
  readonly members: number;
};

/**
 * What the manifest says one narrative node id IS.
 *
 * A repair sweep looking at a disconnected graph node needs this to tell a narrative the records
 * still hold up from one they say nothing about. `undefined` is the second answer and it is not
 * evidence of anything: an id the manifest does not bind is an id these tables were never asked
 * about, which is where a legacy whole-session narrative sits until its family is cut over.
 */
export function narrativeRevisionBinding(
  db: SqliteHandle,
  nodeId: string,
): NarrativeRevisionBinding | undefined {
  const chunk = db
    .prepare(
      `SELECT r.chunk_id AS family_key, r.revision_no, r.state,
              (SELECT COUNT(*) FROM chunk_members m WHERE m.chunk_id = r.chunk_id) AS members
         FROM chunk_revisions r WHERE r.node_id = ?`,
    )
    .get(nodeId) as
    { family_key: string; revision_no: number; state: string; members: number } | undefined;
  if (chunk !== undefined) {
    return {
      family: 'chunk',
      familyKey: chunk.family_key,
      revisionNo: chunk.revision_no,
      state: chunk.state,
      members: chunk.members,
    };
  }
  const overview = db
    .prepare('SELECT family_key, revision_no, state FROM overview_revisions WHERE node_id = ?')
    .get(nodeId) as { family_key: string; revision_no: number; state: string } | undefined;
  return overview === undefined
    ? undefined
    : {
        family: 'overview',
        familyKey: overview.family_key,
        revisionNo: overview.revision_no,
        state: overview.state,
        members: 0,
      };
}

/** Moves the chunk row's own state once its first revision publishes. */
export function markChunkPublished(db: SqliteHandle, chunkId: string): void {
  db.prepare("UPDATE chunks SET state = 'published' WHERE chunk_id = ?").run(chunkId);
}
