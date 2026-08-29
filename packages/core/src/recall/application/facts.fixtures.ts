/**
 * The evidence behind `recall.restatementFloor` and behind the exercise's own facts-bucket scenario, as fixtures
 * rather than as lore, in the shape `floors.fixtures.ts` established.
 *
 * Two distributions decide the floor, and both are Goal and Plan text scored against the query
 * that would retrieve it. The one that has to be caught is a node whose text is the question
 * said back; the one that must not be is a node whose text answers it. Measuring only the
 * first would produce a floor that also swallows every Goal a user legitimately asked about.
 *
 * `facts-calibration.int.test.ts` embeds both against live Ollama and asserts the committed
 * floor still separates them. `facts-battery.int.test.ts` runs `DECISION_PROBE` through the
 * whole pipeline against `DECISION_SUBSTRATE`. Both are exported for the round's re-exercise
 * harness.
 */

export type FactsPair = {
  /** The query a user would ask. */
  readonly query: string;
  /** The Goal or Plan text that surfaces for it. */
  readonly content: string;
};

/**
 * Goals and Plans that restate the query and carry no answer — the exercise's own shape, where facts
 * rank 1 for "what did we decide about the remittance ingest transport and why" was the Goal
 * "Select an appropriate transport mechanism for remittance ingest."
 */
export const RESTATING_GOALS: readonly FactsPair[] = [
  {
    query: 'what did we decide about the remittance ingest transport and why',
    content: 'Select an appropriate transport mechanism for remittance ingest.',
  },
  {
    query: 'what did we decide about how the remittance files get ingested',
    content: 'Decide how the remittance files get ingested.',
  },
  {
    query: 'did we decide to shard the orders table',
    content: 'Decide whether to shard the orders table.',
  },
  {
    query: 'what did we decide about the finops billing table',
    content: 'Determine what to do about the finops billing table.',
  },
  {
    query: 'how long does the split migration take on a production sized copy',
    content: 'Measure how long the split migration takes on a production sized copy.',
  },
  {
    query: 'why did we reject the kafka proposal',
    content: 'Evaluate and reject the Kafka proposal.',
  },
  {
    query: 'what is the idempotency key supposed to hash',
    content: 'Establish what the idempotency key should hash.',
  },
  { query: 'what is our q3 latency goal', content: 'Determine the Q3 latency goal.' },
];

/**
 * Goals and Plans that answer the query: they name a target, a number, a state, or a date.
 * These are what the floor is not allowed to swallow, and the exercise judged their extraction
 * faithful ("Get the Halyard ledger onto the new PostgreSQL primary", status completed).
 */
export const ANSWERING_GOALS: readonly FactsPair[] = [
  {
    query: 'what is our q3 latency goal',
    content: 'Get p95 API latency under 200ms by the end of Q3.',
  },
  {
    query: 'what are we doing about the halyard ledger',
    content: 'Get the Halyard ledger onto the new PostgreSQL primary.',
  },
  {
    query: 'what is the plan for the remittance ingest',
    content: 'Ship the outbox poller behind a flag with two weeks of shadow reads.',
  },
  {
    query: 'what is the migration plan for the orders table',
    content: 'Add a covering index on the join column and revisit sharding next quarter.',
  },
  {
    query: 'what are we doing about the leaked connection string',
    content: 'Rotate the exposed credential and move it into the secret store by Friday.',
  },
  {
    query: 'what is the goal for the split migration',
    content: 'Cut the split migration under two minutes on a production-sized copy.',
  },
  {
    query: 'what is the plan for kafka',
    content: 'Stay on Postgres and revisit Kafka only past 10k events per second.',
  },
  {
    query: 'what is our onboarding goal',
    content: 'Onboard forty new advocates before the end of the quarter.',
  },
];

/** One node of the battery substrate, written with the graph label it is packed under. */
export type SubstrateNode = {
  readonly id: string;
  readonly label: 'Decision' | 'Goal' | 'Entity' | 'Concept' | 'Insight';
  readonly content: string;
};

/**
 * The exercise's measured pack, rebuilt as a substrate: the Decision that answers the question, the
 * query-shaped Goals that outranked it, and the entity glosses that took 58% of the exercise's
 * fact slots. The Decision and the leading Goal are quoted verbatim from the report; the rest
 * is what an extraction of that episode mints. The exercise served the Goal at facts rank 1 and
 * the Decision in none of the five queries that asked for the transport decision.
 */
export const DECISION_SUBSTRATE: readonly SubstrateNode[] = [
  {
    id: 'decision-outbox',
    label: 'Decision',
    content: 'Use a Postgres outbox table plus a polling worker for remittance ingest.',
  },
  {
    id: 'insight-replay',
    label: 'Insight',
    content:
      'Webhook delivery cannot be replayed, which is why remittance ingest needs a durable log.',
  },
  {
    id: 'goal-restating',
    label: 'Goal',
    content: 'Select an appropriate transport mechanism for remittance ingest.',
  },
  {
    id: 'entity-remittance',
    label: 'Entity',
    content: 'remittance ingest (concept): the path remittance files take into the ledger.',
  },
  {
    id: 'entity-outbox',
    label: 'Entity',
    content: 'outbox table (pattern): a table written in the same transaction as the business row.',
  },
  {
    id: 'entity-postgres',
    label: 'Entity',
    content: 'Postgres (technology): the primary datastore behind the ledger.',
  },
  {
    id: 'entity-poller',
    label: 'Entity',
    content: 'polling worker (component): reads the outbox and forwards each row downstream.',
  },
  {
    id: 'entity-webhooks',
    label: 'Entity',
    content: 'webhooks (technology): push delivery from the payor to an HTTP endpoint.',
  },
  {
    id: 'concept-durability',
    label: 'Concept',
    content: 'Durable ingest means the transport can be replayed after a consumer outage.',
  },
];

/**
 * The exercise's own query, and the cue set the pinned cue model returns for it, recorded from three
 * identical live runs. Recorded rather than invented so the battery measures the facts rules
 * against the cues the pipeline actually produces, and recorded rather than called live so a
 * ranking assertion does not move with the model's mood.
 */
export const DECISION_PROBE = {
  query: 'what did we decide about the remittance ingest transport and why',
  cues: ['remittance ingest transport', 'decision about', 'why'],
  intent: 'decision',
  /** The `DECISION_SUBSTRATE` id the facts bucket has to carry back, in its top three. */
  expects: 'decision-outbox',
  /** The `DECISION_SUBSTRATE` id the pack must not carry at all. */
  excludes: ['goal-restating'],
} as const;
