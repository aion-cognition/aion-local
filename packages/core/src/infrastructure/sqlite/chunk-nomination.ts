import { DUE_INITIAL_CHUNK } from './chunk-publication-read.js';
import type { SqliteHandle } from './database.js';

// The blocked-attempt reading moved out at this file's ceiling and is re-exported here, because
// what a refusal recorded is asked of nomination by every caller that asks what is due.
export {
  blockedAttempts,
  reconsiderableBlockedAttempts,
  suppressionCleared,
  type BlockedAttempt,
} from './chunk-blocks.js';

/**
 * What durable state says a seal run has to do, and what it is not allowed to count.
 *
 * Every read here is over the manifest and the source records alone. None of them asks the
 * resolver, the graph or a provider, because the observation tick that scores the operation has
 * none of those and a demand number a tick cannot take is a demand number nobody acts on. What
 * that costs is stated rather than hidden: the rendered-input trigger is invisible here (it needs
 * the evidence read the run itself performs), so a session whose tail is only over the allowance
 * is no DEMAND, and the run reaches it by offering the tail to the seal decision anyway.
 *
 * Two groups exist and they are counted apart. A GROUP TO SEAL is a session whose unsealed tail
 * has reached the count or span trigger; a GROUP TO PUBLISH is a sealed chunk whose head is
 * unpublished and whose next attempt is due. Both consume one bounded unit of a run, which is why
 * a caller may add them, and both are reported separately so nothing divides a mixed total.
 *
 * What a census may COUNT and what a run may OFFER are different questions, which is what `reach`
 * below separates: the third seal trigger is the rendered input, and only the seal decision can
 * evaluate it.
 */

/** A source is admitted to a chunk only on a verified identity, so the two states are named. */
const VERIFIED = 'verified';

/**
 * The unsealed tail of a session, as the seal itself reads it: acknowledged up to the watermark,
 * carrying a capture position, and not already sealed into a chunk. The verification test is a
 * literal string comparison on a NOT NULL column, so no row disappears into a NULL comparison.
 */
export const SEAL_REMAINDER_POPULATION = `r.capture_order_value IS NOT NULL
       AND r.capture_order_value <= s.watermark
       AND NOT EXISTS (SELECT 1 FROM chunk_members m WHERE m.source_id = r.source_id)`;
const REMAINDER_PREDICATE = SEAL_REMAINDER_POPULATION;

export type DueChunkGroup = {
  readonly chunkId: string;
  readonly sessionId: string;
  /** The arrival clock the group's age is measured from: when its membership froze. */
  readonly sealedAt: string;
  /** The lowest capture position in the frozen membership, which is the nomination order. */
  readonly captureKey: string | null;
};

/**
 * Sealed chunks with no published head whose next attempt is due, oldest capture first.
 *
 * A chunk holding a blocked attempt is not here at all: a block clears on a changed prerequisite
 * and never on the clock, so nominating it would spend the run's allowance on work that cannot
 * move. A chunk is due when it holds no unblocked attempt at all, which is a chunk nobody has
 * tried yet, or when one of the attempts it holds has reached its retry time; a chunk whose every
 * attempt is dated later waits. Both exclusions stay visible through `blockedChunkSources` and
 * the revision rows themselves.
 *
 * A chunk that HAS published is out of this population on purpose. Its next revision is an
 * invalidation the regrounding operation nominates from stored dependencies; a seal run that
 * retried it would be a second scheduler for the same family.
 */
export function dueChunkGroups(
  db: SqliteHandle,
  now: Date,
  limit: number,
): readonly DueChunkGroup[] {
  if (limit <= 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT c.chunk_id, c.session_id, c.sealed_at,
              (SELECT MIN(r.capture_order_value)
                 FROM chunk_members m
                 JOIN source_records r ON r.source_id = m.source_id
                WHERE m.chunk_id = c.chunk_id) AS capture_key
         FROM chunks c
        WHERE ${DUE_INITIAL_CHUNK}
        ORDER BY capture_key, c.chunk_id
        LIMIT ?`,
    )
    .all(now.toISOString(), limit) as {
    chunk_id: string;
    session_id: string;
    sealed_at: string;
    capture_key: string | null;
  }[];
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    sessionId: row.session_id,
    sealedAt: row.sealed_at,
    captureKey: row.capture_key,
  }));
}

/**
 * Where a nomination page stopped: the group's capture position and the session that broke the
 * tie. A cursor says only that a run looked at a group; it settles nothing and discharges nothing,
 * and the group it moved past is nominated again on the pass after the cursor wraps.
 */
export type RemainderCursor = {
  readonly captureKey: string;
  readonly sessionId: string;
};

export type DueRemainderGroup = {
  readonly sessionId: string;
  readonly unsealed: number;
  /** Arrival, not `occurredAt`: a backdated conversation does not date its own tail. */
  readonly oldestArrivalAt: string;
  readonly captureKey: string;
};

/**
 * Sessions carrying an unsealed tail, in capture order.
 *
 * `reach` is which question is being asked, and the two callers ask different ones.
 *
 * `due` is provable demand: the tail has reached a trigger durable state can SEE — the member
 * count, or the elapsed arrival age of its oldest unsealed source. That is what a demand census
 * may count, because it is what a run could act on with no further reading.
 *
 * `any` is nomination. The third signed trigger is the rendered input, and no query can evaluate
 * it: what a member renders to is an evidence read, which the seal decision performs and this
 * does not. A nomination limited to the two visible triggers therefore never offers a single
 * oversized source to the one component that can admit it, and that source is never narrated. So
 * the operation offers the oldest tails whether or not durable state can prove them due, bounded
 * by the same page and the same cursor, and the seal answers `waiting` for the ones that are not.
 *
 * `created_at` is the substrate's own clock for the acceptance, which is what the span trigger
 * measures on both sides of the seam. `occurred_at` is the world time the caller stated, and a
 * source backdated to last year would otherwise make every tail it lands in permanently overdue.
 */
export function dueRemainderGroups(
  db: SqliteHandle,
  input: {
    readonly now: Date;
    readonly maxSpanMs: number;
    readonly maxMembers: number;
    readonly limit: number;
    /** `due` counts what is provably due; `any` offers every tail to the seal decision. */
    readonly reach?: 'due' | 'any';
    /** Resume strictly past this group, so a session a run cannot seal stops holding the front. */
    readonly after?: RemainderCursor;
  },
): readonly DueRemainderGroup[] {
  if (input.limit <= 0) {
    return [];
  }
  const cutoff = new Date(input.now.getTime() - input.maxSpanMs).toISOString();
  const after = input.after ?? { captureKey: '', sessionId: '' };
  const rows = db
    .prepare(
      `SELECT r.session_id, COUNT(*) AS unsealed,
              MIN(r.capture_order_value) AS capture_key,
              MIN(r.created_at) AS oldest_arrival_at
         FROM source_records r
         JOIN session_remainders s ON s.session_id = r.session_id
        WHERE ${REMAINDER_PREDICATE}
          AND r.verification_status = '${VERIFIED}'
        GROUP BY r.session_id
       HAVING (? = 1 OR COUNT(*) >= ? OR MIN(r.created_at) <= ?)
          AND (? = ''
               OR MIN(r.capture_order_value) > ?
               OR (MIN(r.capture_order_value) = ? AND r.session_id > ?))
        ORDER BY capture_key, r.session_id
        LIMIT ?`,
    )
    .all(
      input.reach === 'any' ? 1 : 0,
      input.maxMembers,
      cutoff,
      after.captureKey,
      after.captureKey,
      after.captureKey,
      after.sessionId,
      input.limit,
    ) as {
    session_id: string;
    unsealed: number;
    capture_key: string;
    oldest_arrival_at: string;
  }[];
  return rows.map((row) => ({
    sessionId: row.session_id,
    unsealed: row.unsealed,
    oldestArrivalAt: row.oldest_arrival_at,
    captureKey: row.capture_key,
  }));
}

export type BlockedSourceTally = {
  readonly reason: string;
  /** Sources inside the blocked chunks, which is the population a person has to unblock. */
  readonly sources: number;
  readonly oldestAt: string;
};

/**
 * Sources held out of publication, by the reason recorded against the attempt that stopped.
 *
 * These never reach a numerator and never set the oldest eligible age. They are counted so a
 * substrate whose seal demand reads zero can still be told from one whose whole backlog is
 * blocked, which is the difference between nothing to do and nothing that can be done.
 */
export function blockedChunkSources(db: SqliteHandle): readonly BlockedSourceTally[] {
  const rows = db
    .prepare(
      `SELECT b.blocked_reason AS reason, COUNT(m.source_id) AS sources,
              MIN(b.allocated_at) AS oldest_at
         FROM chunk_revisions b
         JOIN chunk_members m ON m.chunk_id = b.chunk_id
        WHERE b.state = 'allocated' AND b.blocked_reason IS NOT NULL
        GROUP BY b.blocked_reason
        ORDER BY b.blocked_reason`,
    )
    .all() as { reason: string; sources: number; oldest_at: string }[];
  return rows.map((row) => ({
    reason: row.reason,
    sources: row.sources,
    oldestAt: row.oldest_at,
  }));
}

export type HeldMembership = {
  readonly sources: number;
  readonly oldestAt: string | undefined;
};

/**
 * Unsealed sources a chunk may not take yet because their identity is not proved.
 *
 * A verified source identity is a precondition of membership, so an unresolved or pinned source
 * waits outside every chunk rather than freezing into one. Waiting silently is the
 * loss this read exists to prevent: the count travels with the demand so the source is visible by
 * reason and age instead of simply never being narrated.
 */
export function heldRemainderMembership(db: SqliteHandle): HeldMembership {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sources, MIN(r.created_at) AS oldest_at
         FROM source_records r
         JOIN session_remainders s ON s.session_id = r.session_id
        WHERE ${REMAINDER_PREDICATE}
          AND r.verification_status <> '${VERIFIED}'`,
    )
    .get() as { sources: number; oldest_at: string | null };
  return {
    sources: row.sources,
    oldestAt: row.oldest_at ?? undefined,
  };
}

/**
 * Sessions whose governing seal trigger is the INPUT rather than the count or the age.
 *
 * The third trigger is the rendered input, and the render is an evidence read the decision
 * performs. A census cannot perform one — the observation tick has no resolver — so what it has is
 * the only durable measure of how much a member carries: the archived payload it was accepted
 * with. What that measure can answer is which bound a tail will reach FIRST. A member carrying
 * more than an equal share of the allowance means the tail runs out of render before it runs out
 * of member slots, so its trigger is the input one and the count and age tests will never speak
 * for it however long it stands.
 *
 * This NOMINATES; the admission decision remains the authority, and its error is in the direction
 * of asking earlier rather than later. A tail it nominates that turns out to fit answers `waiting`
 * and costs one evidence read. Without it an input-full tail produced no demand at all: the
 * operation sealed it the moment anything forced a run, and the scheduler never asked for one.
 *
 * The archive is reached through the record's OWN pointer. Matching `episode_id` to `source_id`
 * assumes an equality the schema keeps apart: a record whose archive was correctly remapped still
 * names its row, and a join on the two identifiers stops finding it while every other reader
 * still does. Either address the pointer resolves at is accepted, the way the signed archive
 * grouping accepts both.
 */
export function inputFullRemainderGroups(
  db: SqliteHandle,
  input: { readonly allowance: number; readonly maxMembers: number; readonly limit: number },
): readonly DueRemainderGroup[] {
  if (input.limit <= 0 || input.allowance <= 0 || input.maxMembers <= 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT r.session_id, COUNT(*) AS unsealed,
              MIN(r.capture_order_value) AS capture_key,
              MIN(r.created_at) AS oldest_arrival_at
         FROM source_records r
         JOIN session_remainders s ON s.session_id = r.session_id
         JOIN experience_archive a
           ON a.id = r.canonical_archive_id OR a.episode_id = r.canonical_archive_id
        WHERE ${REMAINDER_PREDICATE}
          AND r.verification_status = '${VERIFIED}'
        GROUP BY r.session_id
       HAVING MAX(LENGTH(a.payload_json)) * ? >= ?
        ORDER BY capture_key, r.session_id
        LIMIT ?`,
    )
    .all(input.maxMembers, input.allowance, input.limit) as {
    session_id: string;
    unsealed: number;
    capture_key: string;
    oldest_arrival_at: string;
  }[];
  return rows.map((row) => ({
    sessionId: row.session_id,
    unsealed: row.unsealed,
    oldestArrivalAt: row.oldest_arrival_at,
    captureKey: row.capture_key,
  }));
}

export type PublishedChunkHead = {
  readonly chunkId: string;
  readonly nodeId: string;
  readonly revisionNo: number;
  /** What the head was published on, which is what invalidation is judged against. */
  readonly evidenceRevisionJson: string | null;
  /** The lowest capture position in its membership, which is the continuation order. */
  readonly captureKey: string | null;
};

/** Where a head page resumes, so a page of current heads cannot hide a stale one behind it. */
export type HeadCursor = {
  readonly captureKey: string;
  readonly chunkId: string;
};

/**
 * Published chunk heads, oldest capture first, resumable.
 *
 * Which of them is INVALIDATED is a question about the stored dependency set, and the verifier
 * that answers it is the same one the publication uses — so this offers the heads and does not
 * guess at their currency. It resumes because a fixed front page of current heads is a page a
 * stale head behind it is never reached from, however many times the pass runs.
 */
export function publishedChunkHeads(
  db: SqliteHandle,
  limit: number,
  after?: HeadCursor,
): readonly PublishedChunkHead[] {
  if (limit <= 0) {
    return [];
  }
  const resume = after ?? { captureKey: '', chunkId: '' };
  const rows = db
    .prepare(
      `SELECT r.chunk_id, r.node_id, r.revision_no, r.evidence_revision_json,
              (SELECT MIN(s.capture_order_value)
                 FROM chunk_members m
                 JOIN source_records s ON s.source_id = m.source_id
                WHERE m.chunk_id = r.chunk_id) AS capture_key
         FROM chunk_revisions r
        WHERE r.state = 'published'
          AND (? = ''
               OR (SELECT MIN(s.capture_order_value)
                     FROM chunk_members m
                     JOIN source_records s ON s.source_id = m.source_id
                    WHERE m.chunk_id = r.chunk_id) > ?
               OR ((SELECT MIN(s.capture_order_value)
                      FROM chunk_members m
                      JOIN source_records s ON s.source_id = m.source_id
                     WHERE m.chunk_id = r.chunk_id) = ? AND r.chunk_id > ?))
        ORDER BY capture_key, r.chunk_id
        LIMIT ?`,
    )
    .all(resume.captureKey, resume.captureKey, resume.captureKey, resume.chunkId, limit) as {
    chunk_id: string;
    node_id: string;
    revision_no: number;
    evidence_revision_json: string | null;
    capture_key: string | null;
  }[];
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    nodeId: row.node_id,
    revisionNo: row.revision_no,
    evidenceRevisionJson: row.evidence_revision_json,
    captureKey: row.capture_key,
  }));
}
