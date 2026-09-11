/** Shared initial-publication eligibility; the caller binds its own population and the due clock. */
export const DUE_INITIAL_CHUNK = `c.published_revision_no IS NULL
          AND NOT EXISTS (SELECT 1 FROM chunk_revisions b
                           WHERE b.chunk_id = c.chunk_id
                             AND b.state = 'allocated' AND b.blocked_reason IS NOT NULL)
          AND (NOT EXISTS (SELECT 1 FROM chunk_revisions a
                            WHERE a.chunk_id = c.chunk_id
                              AND a.state = 'allocated' AND a.blocked_reason IS NULL)
               OR EXISTS (SELECT 1 FROM chunk_revisions a
                           WHERE a.chunk_id = c.chunk_id
                             AND a.state = 'allocated' AND a.blocked_reason IS NULL
                             AND COALESCE(a.next_attempt_at, a.allocated_at) <= ?))`;
