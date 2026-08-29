/**
 * Held-out claim and question pairs: what a session stored, and the natural ways the same
 * person asks for it back a day later. The point of holding the questions out from the claims
 * is that no question repeats the words of its answer, so a pack that carries the answer
 * carries it because retrieval measured the meaning rather than matched a token.
 *
 * This is the set an on-topic non-empty check cannot see. A pack can be full, confident and
 * on-topic while omitting the one thing it was asked for, and counting items or asserting the
 * pack is not empty passes exactly that failure.
 *
 * The first three cases are recorded: their claims are the text that was stored when six
 * natural phrasings of one question each returned a pack of six to thirteen items and not one
 * of them stated the fix, while the three answering nodes measured 0.60 to 0.80 cosine against
 * the query. The remaining six are new pairs in the same shape. `DISTRACTORS` are the
 * neighbours that were admitted instead, stored so the questions face the same competition.
 */

export type HeldOutCase = {
  readonly key: string;
  /** One session's worth of observations, stored as a single episode. */
  readonly observations: readonly string[];
  /** Asked in a later session, in the words a person uses rather than the words that were stored. */
  readonly questions: readonly string[];
  /**
   * Lowercased fragments of the answer. A pack answers the question when a returned item
   * carries one of them, which is a weaker claim than naming the node and a stronger one than
   * counting items.
   */
  readonly answerTerms: readonly string[];
};

export const HELD_OUT_CASES: readonly HeldOutCase[] = [
  {
    key: 'checkout-latency',
    observations: [
      'Checkout p95 jumped from 240 milliseconds to 3.1 seconds at 14:20 UTC.',
      'The orders.customer_id index was missing, so every checkout read fell back to a sequential scan.',
      'The orders.customer_id index was created concurrently at 15:05 UTC.',
      'Recreate the missing index on orders.customer_id to resolve the sequential scan performance issue.',
      'Concurrent index creation can effectively reduce checkout latency without compromising data integrity.',
    ],
    questions: [
      'how did we fix the checkout latency',
      'what fixed the checkout latency spike',
      'what did we do to bring checkout p95 back down',
      'why did checkout get slow',
      'what was the root cause of the checkout slowdown',
      'did we ever recreate that index on the orders table',
    ],
    answerTerms: ['index'],
  },
  {
    key: 'refund-locking',
    observations: [
      'Two refund workers can process the same refund at once, so the refund path needs a lock.',
      "Rejecting the Redis mutex approach in favor of PostgreSQL's row-level lock.",
      'A Redis mutex puts a second system in the failure path for a guarantee Postgres already gives us.',
    ],
    questions: [
      'how do we stop two refunds going out at once',
      'did we go with redis or postgres for refund locking',
      'what did we settle on for locking the refund path',
    ],
    answerTerms: ['row-level', 'postgres'],
  },
  {
    key: 'remittance-transport',
    observations: [
      'We went back on the outbox poller. Remittance ingest is Pub/Sub push to a Cloud Run endpoint now.',
      'The close-day burst on remittance ingest is twenty times our steady state, which the poller could not absorb.',
    ],
    questions: [
      'how do remittance files get in these days',
      'what replaced the outbox poller',
      'is remittance ingest still polling for work',
    ],
    answerTerms: ['pub/sub', 'cloud run'],
  },
  {
    key: 'signing-key-rotation',
    observations: [
      'The session signing key rotates every ninety days.',
      'The previous signing key stays valid for one rotation, so a session in flight is never logged out.',
    ],
    questions: [
      'how often does the session signing key rotate',
      'do people get logged out when we rotate the signing key',
    ],
    answerTerms: ['ninety days', 'one rotation'],
  },
  {
    key: 'reconciliation-window',
    observations: [
      'The nightly reconciliation job runs at 02:15 UTC.',
      'Reconciliation waits for the processor settlement file, which lands at 01:50 UTC.',
    ],
    questions: [
      'when does reconciliation run',
      'why is reconciliation scheduled so late at night',
    ],
    answerTerms: ['02:15', 'settlement'],
  },
  {
    key: 'webhook-backoff',
    observations: [
      'The webhook consumer backs off exponentially from two seconds to five minutes.',
      'After the last retry the event is parked in the dead-letter table rather than dropped.',
    ],
    questions: [
      'what happens to a webhook we cannot process',
      'how long do we keep retrying before we give up on an event',
    ],
    answerTerms: ['dead-letter', 'five minutes'],
  },
  {
    key: 'payments-oncall',
    observations: [
      'Payments on-call hands over on Wednesday morning.',
      'A Tuesday payments deploy is owned by whoever shipped it, because the rotation has not turned over yet.',
    ],
    questions: [
      'who owns a tuesday payments deploy',
      'when does payments on-call change hands',
    ],
    answerTerms: ['wednesday', 'shipped it'],
  },
  {
    key: 'pdf-storage',
    observations: [
      'Uploaded remittance PDFs are stored in object storage.',
      'Postgres keeps only the checksum and the object key for an uploaded remittance PDF.',
    ],
    questions: [
      'where do the uploaded remittance pdfs live',
      'what do we keep in the database for an uploaded pdf',
    ],
    answerTerms: ['object storage', 'checksum'],
  },
  {
    key: 'eligibility-timeout',
    observations: [
      'The upstream eligibility API times out at eight seconds.',
      'The eligibility client budget is six seconds with one retry, so a slow upstream cannot hold a request open.',
    ],
    questions: [
      'what is the eligibility api timeout',
      'how long do we wait on eligibility before giving up',
    ],
    answerTerms: ['eight seconds', 'six seconds'],
  },
];

/**
 * Stored with the cases and never the answer to any of them. The first is the item that filled
 * the packs instead of the checkout fix: a quarterly goal about the same service, on-topic and
 * silent about what was done. The metric gloss that came second is not stored here, because
 * enrichment writes that one itself from this goal.
 */
export const DISTRACTORS: readonly string[] = [
  'Cut checkout p99 latency from 2.4 seconds to under 800 milliseconds by the end of Q3.',
  'The Redis session cache evicted keys under memory pressure during the March outage.',
  'The remittance importer ran as a nightly cron before the outbox poller existed.',
  'Search traffic doubles in the last week of the quarter, mostly from the reporting page.',
];

export function heldOutCase(key: string): HeldOutCase {
  const found = HELD_OUT_CASES.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`no held-out case named ${key}`);
  }
  return found;
}

export type HeldOutProbe = {
  readonly key: string;
  readonly question: string;
  readonly answerTerms: readonly string[];
};

/** One row per question, which is the unit a recall battery iterates. */
export const HELD_OUT_PROBES: readonly HeldOutProbe[] = HELD_OUT_CASES.flatMap((entry) =>
  entry.questions.map((question) => ({
    key: entry.key,
    question,
    answerTerms: entry.answerTerms,
  })),
);
