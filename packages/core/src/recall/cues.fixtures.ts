import type { CueExtractionInput } from './cues.js';

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
        { role: 'assistant', text: 'both, they are unrelated leaks that happened to land the same week' },
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
      summary: 'Setting up the git commit workflow for a new repo, deciding on commit message conventions.',
    },
  },
];
