import type { CueExtractionInput } from './cues.js';
import { OFF_TOPIC_BATTERY } from './floors.data.js';

/**
 * Realistic recall calls an agent might issue, spanning query-only, query+summary, and
 * full-context shapes. Shared by the unit tests (weighting, dedupe) and the live smoke
 * test (`cues.int.test.ts`), so both exercise the same inputs the pipeline will see.
 */
export type CueFixtureScenario = {
  readonly id: string;
  readonly description: string;
  readonly input: CueExtractionInput;
};

export const CUE_FIXTURES: readonly CueFixtureScenario[] = [
  {
    id: 'query-only-preference',
    description: 'bare query, no conversation context',
    input: {
      query: 'what editor keybindings does the user prefer for multi-cursor editing',
    },
  },
  {
    id: 'query-only-error-token',
    description: 'bare query carrying an exact error token, for BM25 coverage',
    input: {
      query: 'SQLITE_BUSY on reflection_queue during two-process claiming',
    },
  },
  {
    id: 'query-with-summary',
    description: 'query plus a rolling conversation summary, no recent turns',
    input: {
      query: 'why did we split the migration into per-table transactions',
      summary:
        'Debugging a production deploy blocked by a Neo4j migration deadlock: read-only joins ' +
        'were colliding with a multi-table single-transaction DDL statement.',
    },
  },
  {
    id: 'query-with-recent-turns',
    description: 'query plus recent turns, no summary',
    input: {
      query: 'so is the fix already in the runbook',
      recentTurns: [
        { role: 'user', text: 'the wendy song revert needs a dry run against prod first' },
        { role: 'assistant', text: 'ran it, dry run came back green' },
      ],
    },
  },
  {
    id: 'query-with-full-context',
    description: 'query, summary, and recent turns together',
    input: {
      query: 'what was the actual root cause, not just the symptom',
      summary: 'Investigating a Datadog PHI log leak traced to two independent sources.',
      recentTurns: [
        { role: 'user', text: 'is it the claude error dump or the sql bind params' },
        {
          role: 'assistant',
          text: 'both, they are unrelated leaks that happened to land the same week',
        },
      ],
    },
  },
  {
    id: 'short-followup',
    description: 'a short, low-signal follow-up query with recent turns for context',
    input: {
      query: 'and the other one',
      recentTurns: [
        { role: 'user', text: 'how many active physician_patient rows did we find' },
        { role: 'assistant', text: 'three, sync-rendering-physicians resolves it' },
      ],
    },
  },
  {
    id: 'entity-heavy-query',
    description: 'query naming several entities at once, no context',
    input: {
      query: 'has POPS-1339 shipped, and did Ben already review the drift guard',
    },
  },
  {
    id: 'preference-with-summary',
    description: 'a standing-preference lookup with summary context',
    input: {
      query: 'does Ryan want Co-Authored-By trailers on commits',
      summary:
        'Setting up the git commit workflow for a new repo, deciding on commit message conventions.',
    },
  },
];

/**
 * The measured miss queries as bare recall calls: no summary, no turns, and a topic the
 * substrate has never held. Every one came back a full, budget-saturated pack, and on the
 * quantum query the cues were correct, so the failure sits downstream of cue
 * extraction. These fixtures hold that line: a hardened prompt must not start inventing
 * topics on a bare query, and whatever it returns, the raw query still has to be a cue.
 */
export const BARE_QUERY_FIXTURES: readonly CueFixtureScenario[] = OFF_TOPIC_BATTERY.map(
  (query, index) => ({
    id: `bare-query-${String(index)}`,
    description: 'a bare off-topic query, the shape that produced invented cues',
    input: { query },
  }),
);

/**
 * Four summaries against one query, verbatim, with the rank the answer came back at. No summary
 * improved on having none, and one destroyed the answer outright, which is why summary cues are
 * damped to 1x whatever they say (`cues.ts`, `SUMMARY_CUE_WEIGHT`).
 */
export type SummaryToneFixture = {
  readonly summary: string;
  /** What was measured for `SUMMARY_TONE_QUERY` under this summary. */
  readonly measured: string;
};

export const SUMMARY_TONE_FIXTURES: readonly SummaryToneFixture[] = [
  { summary: 'recalling my own recent work', measured: 'MISS, 22 items, 4 of 4 fresh sessions' },
  { summary: 'checking a specific measured number', measured: 'HIT at rank 9 of 23' },
  { summary: 'reviewing the on-call handoff for Frankfurt', measured: 'HIT at rank 7 of 24' },
  {
    summary:
      'Debugging a production deploy blocked by a Neo4j migration deadlock: read-only joins ' +
      'were colliding with a multi-table single-transaction DDL statement.',
    measured: 'a summary that names its subject, for contrast',
  },
];

/** The query run under each of those summaries, which HIT at rank 7 of 21 with none. */
export const SUMMARY_TONE_QUERY =
  'how long does the split migration take on a production sized copy';
