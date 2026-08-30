/**
 * The gate batteries, as data. Every string is content that was actually pushed or quoted when
 * the failures below were measured, so a pass here means the measured failure is closed rather
 * than that a new fixture happens to behave.
 *
 * The off-topic, on-topic and leaked-shape sets reuse fixtures that already live elsewhere
 * (`recall/application/floors.fixtures.ts` and
 * `redaction/test-support/leaked-shapes.fixture.ts`) and are imported at their gate file
 * rather than copied here.
 */

export type ChangeCase = {
  readonly key: string;
  /** What both statements are about, for the log line. */
  readonly subject: string;
  /** Stored first, enriched, then contradicted or not. */
  readonly baseline: string;
  readonly next: string;
  /**
   * A genuine correction (the answer must change) or a bait (nothing may close). The measured
   * six-case set was four genuine and two bait.
   */
  readonly kind: 'correction' | 'bait';
  /** Asked after both are enriched; only meaningful for a correction. */
  readonly query: string;
  /** The corrected value in words, for the measurement line. */
  readonly answer: string;
};

/**
 * Four corrections and two false baits, one six-case set. The corrections are the ones that
 * measured 3 of 4 questions still answering with the pre-correction value, every item stamped
 * `current`; the baits are two of the three measured false auto-applies, where the judge
 * closed a node that was still true.
 */
export const CHANGE_BATTERY: readonly ChangeCase[] = [
  {
    key: 'stripe-retry',
    subject: 'the Stripe webhook retry limit',
    baseline: 'The Stripe webhook retry limit is three attempts.',
    next: 'Raise the Stripe webhook retry limit to seven attempts; three did not survive the close-day burst.',
    kind: 'correction',
    query: 'what is the stripe webhook retry limit',
    answer: 'seven attempts',
  },
  {
    key: 'billing-deploy',
    subject: 'where the billing service deploys',
    baseline: 'The billing service deploys to AWS us-east-1.',
    next: 'The billing service deploys to Fly.io now; AWS us-east-1 is no longer used.',
    kind: 'correction',
    query: 'where is the billing service deployed',
    answer: 'Fly.io',
  },
  {
    key: 'merge-style',
    subject: 'how pull requests are merged',
    baseline: 'Ryan prefers squash merges for pull requests.',
    next: 'Ryan decided to prefer merge commits over squash merges to maintain bisectability.',
    kind: 'correction',
    query: 'what does Ryan prefer for merging pull requests',
    answer: 'merge commits',
  },
  {
    key: 'remittance-ingest',
    subject: 'how remittance files are ingested',
    baseline: 'Use a Postgres outbox table plus a polling worker for remittance ingest, not Kafka.',
    next: 'We went back on the outbox poller. Remittance ingest is Pub/Sub push to a Cloud Run endpoint now, because the burst on close day is twenty times our steady state.',
    kind: 'correction',
    query: 'do we still use the outbox poller, or did we replace it',
    answer: 'Pub/Sub push to a Cloud Run endpoint',
  },
  {
    key: 'bait-reconciliation',
    subject: 'how long the reconciliation job takes',
    baseline: 'The reconciliation job ran for four hours during the July close.',
    next: 'The reconciliation job now takes forty minutes, after the covering index landed.',
    kind: 'bait',
    query: 'how long does the reconciliation job take',
    answer: 'both are true of their own window',
  },
  {
    key: 'bait-disagreement',
    subject: 'the Meridian migration pause',
    baseline:
      'Sarah Chen believes Meridian and Halyard can run in parallel, reducing the need for a migration pause.',
    next: 'Marcus Delgado wants the Meridian migration paused until Halyard is on the new PostgreSQL primary.',
    kind: 'bait',
    query: 'should the meridian migration be paused',
    answer: 'a stated disagreement, not a correction',
  },
];

export type NarrativeFixture = {
  readonly identity: string;
  readonly payload: Record<string, unknown>;
  /** Words the session's own source does not support; every one of them was found stored. */
  readonly inventions: readonly string[];
};

/**
 * The fabrication fixture, verbatim and complete: 27 words of source that became eight
 * sentences of invented surveillance history, stored permanently with a content vector.
 */
export const THIN_NARRATIVE: NarrativeFixture = {
  identity: 'gate-narrative-thin',
  payload: {
    summary: 'close-mode probe terminate',
    observations: [
      'Close-hook probe using terminate. One observation so the session has an episode to narrate.',
    ],
  },
  inventions: [
    'surveillance',
    'gathering detailed data',
    'mission',
    'without further explanation',
    'No additional data was collected',
  ],
};

/**
 * The "wrong architecture invented" fixture: an episode stating four decisions produced a
 * narrative about a microservices architecture and a service mesh, neither of which appears in
 * the source. On this input the narrative has to name the decisions instead.
 */
export const PLANNING_NARRATIVE: NarrativeFixture = {
  identity: 'gate-narrative-planning',
  payload: {
    summary: 'planning the Meridian rollout: four decisions and two rejected alternatives',
    turns: [
      {
        role: 'user',
        text: 'walk through the rollout decisions we settled on for Meridian this afternoon',
        occurred_at: '2026-04-03T09:00:00Z',
      },
      {
        role: 'assistant',
        text:
          'four decisions: the orders table stays unsharded, session state moves to signed cookies, ' +
          'Meridian ships behind a flag with two weeks of shadow reads, and this service never writes ' +
          'to the finops-owned billing table',
        occurred_at: '2026-04-03T09:01:00Z',
      },
    ],
    observations: [
      'Shadow reads are the only way to compare Meridian against the current path without user-visible risk',
    ],
  },
  inventions: [
    'microservices architecture',
    'service mesh',
    'stakeholders',
    'increasing memory limits',
    'periodic garbage collection',
  ],
};

/**
 * Kept as a measurement rather than as a fix. The episode names Redis four times and the
 * cognitive stage names it too, while the entity stage's MENTIONS list did not carry it.
 * Batching the two extractions is out of scope for now, so the harness holds the fixture and
 * the check stays skipped until a measurement of that batching is on the table.
 */
export const CROSS_STAGE_ENTITY_MISS = {
  identity: 'gate-ex28-counter-evidence',
  payload: {
    summary: 'the checkout outage postmortem',
    observations: [
      'Redis evicted the session keys under memory pressure, which logged every user out mid-checkout.',
      'We run PostgreSQL as the system of record for orders and Redis as the session cache.',
      'Stripe kept retrying the webhook against a service that could not read its own sessions.',
    ],
  },
  /** Named in the source and, when measured, named by the cognitive stage in the same run. */
  central: ['redis', 'stripe', 'postgresql'],
} as const;
