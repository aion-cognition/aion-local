import type { SqliteHandle } from './database.js';

/**
 * What a refused attempt recorded about itself, and what that says about whether it may run again.
 *
 * Kept apart from the nomination reads because it answers a different question: nomination asks
 * what is DUE, and this asks what a recorded refusal was actually about. The reason word cannot
 * answer the second one, which is the whole reason this module exists.
 */

export type BlockedAttempt = {
  readonly chunkId: string;
  readonly revisionNo: number;
  readonly reason: string;
  /**
   * The moment of the READ that refused, from the block's own record, falling back to the
   * allocation for a row blocked before this was written down. They are not the same instant: a
   * reused allocation is older than the reading that refused on it, and a prerequisite asked about
   * the allocation finds a state that was already over when the attempt ran.
   */
  readonly blockedAt: string;
  /** The chunk's frozen membership, which is what a prerequisite test is asked about. */
  readonly members: readonly string[];
  /** The exact scopes the refusal could not count, external requirement sources included. */
  readonly uncountedScopes: readonly { readonly sourceId: string; readonly scope: string }[];
  /** Which members the refusal actually READ as suppressed, where it recorded them. */
  readonly suppressedMembers: readonly string[] | undefined;
  /** The bounds that attempt ran under, where it recorded them. */
  readonly policy: Record<string, number> | undefined;
};

/**
 * Blocked attempts of the named reasons, with what a prerequisite test needs to decide them.
 *
 * The reason alone cannot establish a CAUSE. `no_admissible_input` is what a chunk answers when
 * every member is suppressed AND what it answers when no member fits the allowance, so a rule
 * that read the word as "suppression" would offer a budget refusal as though a forget had
 * cleared. This read therefore decides nothing: it returns the attempt, what the attempt recorded
 * about itself, and the membership, and the caller asks the records what actually happened.
 */
export function blockedAttempts(
  db: SqliteHandle,
  input: {
    readonly reasons: readonly string[];
    readonly limit: number;
    readonly cohortId?: string;
    readonly sessionId?: string;
    readonly initialOnly?: boolean;
    /**
     * Where a previous page stopped, in this read's own order. Which blocks a caller may CLEAR is
     * decided from the records after they are read, so a caller bounded to one output that always
     * starts at the front sees the same still-blocked row every run and never reaches the one
     * whose prerequisite moved.
     */
    readonly after?: { readonly chunkId: string; readonly revisionNo: number };
  },
): readonly BlockedAttempt[] {
  if (input.limit <= 0 || input.reasons.length === 0) {
    return [];
  }
  const placeholders = input.reasons.map(() => '?').join(', ');
  const resume = input.after ?? { chunkId: '', revisionNo: 0 };
  const rows = db
    .prepare(
      `SELECT b.chunk_id, b.revision_no, b.blocked_reason, b.allocated_at,
              b.blocked_context_json, b.attempt_policy_json
         FROM chunk_revisions b
        WHERE b.state = 'allocated' AND b.blocked_reason IN (${placeholders})
          AND (? IS NULL OR EXISTS (SELECT 1 FROM migration_progress m WHERE m.cohort_id = ? AND m.partition_assignment = b.chunk_id))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM chunks c WHERE c.chunk_id = b.chunk_id AND c.session_id = ?))
          AND (? = 0 OR EXISTS (SELECT 1 FROM chunks c WHERE c.chunk_id = b.chunk_id AND c.published_revision_no IS NULL))
          AND (? = '' OR b.chunk_id > ? OR (b.chunk_id = ? AND b.revision_no > ?))
        ORDER BY b.chunk_id, b.revision_no
        LIMIT ?`,
    )
    .all(
      ...input.reasons,
      input.cohortId ?? null,
      input.cohortId ?? null,
      input.sessionId ?? null,
      input.sessionId ?? null,
      input.initialOnly ? 1 : 0,
      resume.chunkId,
      resume.chunkId,
      resume.chunkId,
      resume.revisionNo,
      input.limit,
    ) as {
    chunk_id: string;
    revision_no: number;
    blocked_reason: string;
    allocated_at: string;
    blocked_context_json: string | null;
    attempt_policy_json: string | null;
  }[];
  const members = db.prepare(
    'SELECT source_id FROM chunk_members WHERE chunk_id = ? ORDER BY member_ordinal',
  );
  return rows.map((row) => {
    const context = parseObject(row.blocked_context_json);
    return {
      chunkId: row.chunk_id,
      revisionNo: row.revision_no,
      reason: row.blocked_reason,
      blockedAt: typeof context?.at === 'string' ? context.at : row.allocated_at,
      members: (members.all(row.chunk_id) as { source_id: string }[]).map((m) => m.source_id),
      uncountedScopes: readScopeList(context?.uncountedScopes),
      suppressedMembers: Array.isArray(context?.suppressedMembers)
        ? (context.suppressedMembers as string[])
        : undefined,
      policy: readNumbers(parseObject(row.attempt_policy_json)),
    };
  });
}

function parseObject(value: string | null): Record<string, unknown> | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readScopeList(value: unknown): readonly { sourceId: string; scope: string }[] {
  return Array.isArray(value) ? (value as { sourceId: string; scope: string }[]) : [];
}

function readNumbers(
  value: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [name, held] of Object.entries(value)) {
    if (typeof held === 'number') {
      out[name] = held;
    }
  }
  return out;
}

/**
 * Whether a member this attempt could not read was suppressed AT THE READ and is not now.
 *
 * The state at a moment, not the presence of an event before it. A member forgotten and restored
 * before the attempt ever ran leaves a forget in the record that had nothing to do with the
 * refusal, and reading that as the cause offers a budget refusal as though suppression had
 * cleared. What is asked is the NEWEST committed state at or before the read: if that state was
 * `forgotten` and the newest state now is not, the prerequisite this attempt recorded has moved.
 *
 * Both readings are of COMMITTED states — a version whose operation the coordinator acknowledged —
 * so a forget or a restore that is prepared and unsettled moves nothing.
 */
export function suppressionCleared(db: SqliteHandle, attempt: BlockedAttempt): boolean {
  const newestNow = db.prepare(
    `SELECT v.state_kind FROM source_state_versions v
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
      WHERE v.source_id = ? AND v.known_from IS NOT NULL
      ORDER BY v.known_from DESC, v.version DESC LIMIT 1`,
  );
  if (attempt.suppressedMembers !== undefined) {
    // What the attempt SAW, which is the only reading that cannot be argued with. A member it read
    // as suppressed and that nothing suppresses now is the prerequisite this attempt recorded,
    // moved.
    return attempt.suppressedMembers.some(
      (sourceId) =>
        (newestNow.get(sourceId) as { state_kind: string } | undefined)?.state_kind !== 'forgotten',
    );
  }
  const asOf = db.prepare(
    `SELECT v.state_kind FROM source_state_versions v
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
      WHERE v.source_id = ? AND v.known_from IS NOT NULL AND v.known_from <= ?
      ORDER BY v.known_from DESC, v.version DESC LIMIT 1`,
  );
  const newest = db.prepare(
    `SELECT v.state_kind FROM source_state_versions v
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
      WHERE v.source_id = ? AND v.known_from IS NOT NULL
      ORDER BY v.known_from DESC, v.version DESC LIMIT 1`,
  );
  return attempt.members.some((sourceId) => {
    const then = asOf.get(sourceId, attempt.blockedAt) as { state_kind: string } | undefined;
    if (then?.state_kind !== 'forgotten') {
      return false;
    }
    const now = newest.get(sourceId) as { state_kind: string } | undefined;
    return now?.state_kind !== 'forgotten';
  });
}

/**
 * Blocked attempts whose recorded SUPPRESSION prerequisite has actually cleared.
 *
 * The reason names a class; the records name the cause. An attempt is offered again only where a
 * member it could not read was suppressed at the moment it was taken and is not suppressed now —
 * so a budget refusal that happens to share the reason word is not offered, and a suppression
 * that is still standing is not either.
 */
export function reconsiderableBlockedAttempts(
  db: SqliteHandle,
  input: { readonly reasons: readonly string[]; readonly limit: number },
): readonly BlockedAttempt[] {
  return blockedAttempts(db, input).filter((attempt) => suppressionCleared(db, attempt));
}
