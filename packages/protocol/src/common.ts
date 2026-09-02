import { z } from 'zod';

/**
 * ISO 8601, date-only ("2026-03-01") or full datetime with offset. `as_of` and `knew_at`
 * examples are date-only; reflection per-item timestamps may carry time-of-day. Handlers
 * parse this to a `Date` at the substrate boundary; the wire stays a plain string.
 */
export const IsoTimestampSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/**
 * A node is the live fact, lineage kept for time-travel, or a reading that aged past the
 * horizon it was written with. `expired` is its own value rather than a second use of
 * `superseded` because an aged-out reading has no successor: nothing corrected it, so there is
 * no lineage to print, and folding the two together renders it as an ordinary current memory.
 */
export const CurrencySchema = z.enum(['current', 'superseded', 'expired']);

export type Currency = z.infer<typeof CurrencySchema>;

/** The node that closed this one's validity, and when. This supersedes lineage. */
export const SupersededBySchema = z.strictObject({
  id: z.string().min(1),
  at: IsoTimestampSchema,
});

export type SupersededBy = z.infer<typeof SupersededBySchema>;
