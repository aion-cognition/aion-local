/**
 * The supersession precision battery, as data: 24 designed pairs with ground truth committed
 * here rather than decided after the model answers.
 *
 * The set reproduces the one measured against the local judge, which reported precision 0.400
 * over a live substrate and 0.667 over its own designed pairs, with 15 of 16 judgments at
 * confidence 1.0. Where that run's report quotes a case verbatim the wording is kept; the rest
 * are written to the same shapes its error table names, so the classes of mistake the number
 * came from are all represented: a generic noun shared by two subjects, a restatement, a past
 * observation against a standing rule, two people disagreeing, a widened scope, and two claims
 * about different attributes of one subject.
 *
 * Each case is a pair, not a session. The pair is what the judge sees, so a battery built on
 * pairs measures the judge and nothing upstream of it: extraction fidelity and candidate
 * generation are separate failures with their own numbers.
 */

export type CaseClass = 'true' | 'bait' | 'hard';

export type PrecisionCase = {
  readonly key: string;
  readonly caseClass: CaseClass;
  /** The pre-committed answer: does the new statement reverse the earlier one. */
  readonly contradicts: boolean;
  /** What both statements are about, passed to the judge as the shared subject. */
  readonly subject: string;
  readonly priorLabel: string;
  readonly prior: string;
  readonly currentLabel: string;
  readonly current: string;
  /** Why the answer is what it is, for the line the battery prints when it disagrees. */
  readonly truthNote: string;
};

/** Eight reversals: same subject, and the new value replaces the old one. */
const TRUE_CONTRADICTIONS: readonly PrecisionCase[] = [
  {
    key: 'export-timeout',
    caseClass: 'true',
    contradicts: true,
    subject: 'report export timeout',
    priorLabel: 'Concept',
    prior: 'The report export timeout is 30 seconds.',
    currentLabel: 'Decision',
    current:
      'Raise the report export timeout to 90 seconds; 30 seconds did not survive the quarter-end run.',
    truthNote: 'one parameter, two values, and the new one is stated as a replacement',
  },
  {
    key: 'solstice-branching',
    caseClass: 'true',
    contradicts: true,
    subject: 'Priya Raghunathan',
    priorLabel: 'Insight',
    prior: 'Priya Raghunathan prefers trunk-based development for the Solstice repo.',
    currentLabel: 'Decision',
    current: 'Priya Raghunathan now prefers release branches for the Solstice repo.',
    truthNote: 'the same person holds a different preference about the same repo',
  },
  {
    key: 'marlin-host',
    caseClass: 'true',
    contradicts: true,
    subject: 'Marlin billing worker',
    priorLabel: 'Concept',
    prior: 'The Marlin billing worker deploys to Hetzner Falkenstein.',
    currentLabel: 'Decision',
    current:
      'The Marlin billing worker deploys to Hetzner Helsinki now; Falkenstein is decommissioned.',
    truthNote: 'one deployment target, and the old one is stated as gone',
  },
  {
    key: 'thornbury-duration',
    caseClass: 'true',
    contradicts: true,
    subject: 'Thornbury index rebuild',
    priorLabel: 'Concept',
    prior: 'The Thornbury index rebuild takes six hours.',
    currentLabel: 'Event',
    current:
      'The Thornbury index rebuild now finishes in forty minutes after the partitioning change.',
    truthNote: 'a standing duration corrected by a stated change, not by a one-off measurement',
  },
  {
    key: 'quillon-owner',
    caseClass: 'true',
    contradicts: true,
    subject: 'Quillon ingest pipeline',
    priorLabel: 'Concept',
    prior: 'Quillon ingest pipeline is owned by Dmitri Volkov.',
    currentLabel: 'Decision',
    current: 'Anneke Vos owns the Quillon ingest pipeline now; Dmitri Volkov no longer owns it.',
    truthNote: 'ownership transferred, with the reversal stated outright',
  },
  {
    key: 'bramble-session-store',
    caseClass: 'true',
    contradicts: true,
    subject: 'Bramble session state',
    priorLabel: 'Decision',
    prior: 'Bramble session state is stored in Redis.',
    currentLabel: 'Decision',
    current: 'Bramble session state moves to signed cookies; Redis no longer holds it.',
    truthNote: 'one store replaced by another for the same data',
  },
  {
    key: 'hollis-rotation',
    caseClass: 'true',
    contradicts: true,
    subject: 'Hollis on-call rotation',
    priorLabel: 'Concept',
    prior: 'The Hollis on-call rotation hands over weekly.',
    currentLabel: 'Decision',
    current: 'The Hollis on-call rotation hands over fortnightly from now on.',
    truthNote: 'one cadence, two values, and both cannot be the current rule',
  },
  {
    key: 'wisteria-store',
    caseClass: 'true',
    contradicts: true,
    subject: 'Wisteria time-series store',
    priorLabel: 'Decision',
    prior: 'ScyllaDB was selected as the leading candidate for the Wisteria time-series store.',
    currentLabel: 'Decision',
    current:
      'TimescaleDB is the choice for the Wisteria time-series store; ScyllaDB lost the write benchmark.',
    truthNote: 'one selection, reversed to the other candidate',
  },
];

/** Eight baits: nothing may close, and each one is a shape the local judge closed anyway. */
const FALSE_BAITS: readonly PrecisionCase[] = [
  {
    key: 'vantage-disagreement',
    caseClass: 'bait',
    contradicts: false,
    subject: 'Vantage migration',
    priorLabel: 'Insight',
    prior:
      'The Vantage migration can proceed in parallel with the Redis cutover, as noted by Ines Okafor.',
    currentLabel: 'Decision',
    current: 'Rafael Duarte wants the Vantage migration to wait until the Redis cutover finishes.',
    truthNote: 'two people holding different positions; a stated opinion is not made untrue',
  },
  {
    key: 'kafka-vocabulary',
    caseClass: 'bait',
    contradicts: false,
    subject: 'Kafka',
    priorLabel: 'Concept',
    prior: 'The Kestrel exporter publishes to Kafka.',
    currentLabel: 'Concept',
    current: 'The Marlin billing worker reads from Kafka.',
    truthNote: 'two services sharing one piece of corpus vocabulary; both stay true',
  },
  {
    key: 'orders-table',
    caseClass: 'bait',
    contradicts: false,
    subject: 'orders table',
    priorLabel: 'Concept',
    prior: 'The orders table in the Meridian store is unsharded.',
    currentLabel: 'Concept',
    current: 'The orders table in the Halyard warehouse is partitioned by month.',
    truthNote: 'one table name in two systems; different subjects',
  },
  {
    key: 'timeout-collision',
    caseClass: 'bait',
    contradicts: false,
    subject: 'timeout',
    priorLabel: 'Concept',
    prior: 'The Bramble upload timeout is 30 seconds.',
    currentLabel: 'Concept',
    current: 'The Quillon fetch timeout is 15 seconds.',
    truthNote: 'two parameters that share a word, not a subject',
  },
  {
    key: 'thornbury-restatement',
    caseClass: 'bait',
    contradicts: false,
    subject: 'Thornbury index rebuild',
    priorLabel: 'Concept',
    prior: 'The Thornbury index rebuild takes six hours.',
    currentLabel: 'Insight',
    current: 'Rebuilding the Thornbury index is a six-hour job.',
    truthNote: 'a restatement in other words replaces nothing',
  },
  {
    key: 'reconciliation-window',
    caseClass: 'bait',
    contradicts: false,
    subject: 'reconciliation job',
    priorLabel: 'Event',
    prior: 'The reconciliation job ran for four hours during the July close.',
    currentLabel: 'Concept',
    current: 'The reconciliation job takes forty minutes since the covering index landed.',
    truthNote: 'a record of one run and a later standing duration; each is true of its window',
  },
  {
    key: 'alderwood-precision',
    caseClass: 'bait',
    contradicts: false,
    subject: 'Alderwood CLI',
    priorLabel: 'Concept',
    prior: 'The Alderwood CLI has a sync subcommand.',
    currentLabel: 'Concept',
    current: 'The Alderwood CLI sync subcommand pushes manifest changes to the registry.',
    truthNote: 'the second is more precise about the same thing; neither displaces the other',
  },
  {
    key: 'foxglove-widening',
    caseClass: 'bait',
    contradicts: false,
    subject: 'Foxglove retry policy',
    priorLabel: 'Concept',
    prior: 'The Foxglove retry policy applies to webhook deliveries.',
    currentLabel: 'Event',
    current:
      'The Foxglove retry policy was updated to apply to every outbound call, not only webhook deliveries.',
    truthNote: 'a widened scope leaves the narrower statement true under it',
  },
];

/**
 * Eight hard cases, four true and four false, where the surface reads the other way: a
 * reversal with no negation word, and a refusal that has to survive a shared subject.
 */
const HARD_CASES: readonly PrecisionCase[] = [
  {
    key: 'tamarisk-sink',
    caseClass: 'hard',
    contradicts: true,
    subject: 'Tamarisk ingest',
    priorLabel: 'Concept',
    prior: 'The Tamarisk ingest runs every fifteen minutes and writes to BigQuery.',
    currentLabel: 'Decision',
    current: 'The Tamarisk ingest runs every fifteen minutes and writes to Snowflake now.',
    truthNote: 'one of two attributes changed; the sink cannot be both',
  },
  {
    key: 'halyard-primary',
    caseClass: 'hard',
    contradicts: true,
    subject: 'Halyard',
    priorLabel: 'Concept',
    prior: 'Halyard runs on the PostgreSQL 14 primary.',
    currentLabel: 'Event',
    current: 'Halyard was cut over to the PostgreSQL 16 primary.',
    truthNote: 'an event that does end a standing state, unlike a record of a one-off run',
  },
  {
    key: 'ledger-rounding',
    caseClass: 'hard',
    contradicts: true,
    subject: 'ledger amounts',
    priorLabel: 'Decision',
    prior: 'Ledger amounts round half up.',
    currentLabel: 'Decision',
    current: 'Ledger amounts round half to even, so the close-day totals reconcile.',
    truthNote: 'two rounding rules for one field, stated without a negation',
  },
  {
    key: 'corvid-ownership',
    caseClass: 'hard',
    contradicts: true,
    subject: 'Corvid alerting',
    priorLabel: 'Concept',
    prior: 'Corvid alerting is owned by the platform team.',
    currentLabel: 'Decision',
    current: 'Corvid alerting moves to the payments team.',
    truthNote: 'a transfer implies the old owner stopped owning it',
  },
  {
    key: 'bramble-replicas',
    caseClass: 'hard',
    contradicts: false,
    subject: 'Bramble worker',
    priorLabel: 'Concept',
    prior: 'The Bramble worker runs two replicas in staging.',
    currentLabel: 'Concept',
    current: 'The Bramble worker runs eight replicas in production.',
    truthNote: 'one subject, two environments, and both counts stand',
  },
  {
    key: 'wisteria-benchmark-record',
    caseClass: 'hard',
    contradicts: false,
    subject: 'Wisteria time-series store',
    priorLabel: 'Event',
    prior: 'A write benchmark compared ScyllaDB and TimescaleDB for the Wisteria store.',
    currentLabel: 'Decision',
    current: 'TimescaleDB is the choice for the Wisteria time-series store.',
    truthNote: 'a record of what happened stays true after the decision it fed',
  },
  {
    key: 'foxglove-retry-count',
    caseClass: 'hard',
    contradicts: false,
    subject: 'webhook deliveries',
    priorLabel: 'Concept',
    prior: 'Webhook deliveries use exponential backoff with a maximum of five retries.',
    currentLabel: 'Event',
    current: 'The Foxglove retry policy was updated to apply to every outbound call.',
    truthNote: 'a scope claim and a retry-count claim are different attributes, not rival values',
  },
  {
    key: 'solstice-cadence',
    caseClass: 'hard',
    contradicts: false,
    subject: 'Solstice releases',
    priorLabel: 'Insight',
    prior: 'Solstice releases are cut on Thursdays.',
    currentLabel: 'Insight',
    current: 'Solstice release notes are published on Fridays.',
    truthNote: 'two adjacent facts about one release train; neither replaces the other',
  },
];

export const PRECISION_BATTERY: readonly PrecisionCase[] = [
  ...TRUE_CONTRADICTIONS,
  ...FALSE_BAITS,
  ...HARD_CASES,
];

export function casesOfClass(caseClass: CaseClass): readonly PrecisionCase[] {
  return PRECISION_BATTERY.filter((entry) => entry.caseClass === caseClass);
}
