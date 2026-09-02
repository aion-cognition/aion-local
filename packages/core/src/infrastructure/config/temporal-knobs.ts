import { z } from 'zod';

import { positiveInt } from './knob-types.js';

/**
 * The `temporal` group's own table, split out of `knobs.ts` the same way `maintenance` is: a
 * decay design over a fact node's temporal class is the group's likely next addition, and any
 * per-aspect override table this group ever needs lands here without `knobs.ts` absorbing it.
 * `knobs.ts` folds this back in as its `temporal` leaf, so the split is invisible to every
 * reader of `KNOBS` or `KNOB_TABLE`.
 */

export const TEMPORAL_KNOBS = {
  // How far past a reading's own occurrence its horizon falls: `occurredAt + readingHorizonDays`,
  // computed once at write and never against the wall clock. Thirty is a placeholder pending a
  // graph with enough readings to measure a real distribution against, not a calibrated value.
  readingHorizonDays: ['AION_READING_HORIZON_DAYS', positiveInt, 30],
  // Whether a reading past its horizon renders as `expired` at read: down-ranked and labeled,
  // never dropped. On by default. Off falls back to the read-side behavior from before a
  // reading horizon existed, reporting every node as `current` or `superseded` only, with no
  // stored `valid_horizon` touched.
  expiryAnnotation: ['AION_TEMPORAL_EXPIRY_ANNOTATION', z.boolean(), true],
} as const;
