import type { ReflectionContent } from '../../domain/content.js';

export type QualityFixture = {
  readonly id: string;
  readonly title: string;
  readonly content: ReflectionContent;
};

/**
 * Dev-work episodes shaped like a real `reflection` payload. `renderEpisodeText` produces
 * the same text the real pipeline would extract. Varied length and kind stress different
 * parts of both extraction prompts: decisions, debugging, tool output, and observation-only episodes.
 */
export const QUALITY_FIXTURES: readonly QualityFixture[] = [
  {
    id: 'migration-deadlock',
    title: 'Migration deadlock diagnosis',
    content: {
      summary: 'diagnosed a deploy-blocking migration deadlock',
      turns: [
        { role: 'user', text: 'the prod migration is hanging, can you check what is going on' },
        { role: 'assistant', text: 'looking at the lock waits now' },
        {
          role: 'assistant',
          text: 'found it: two migrations each alter a different table inside one transaction, and they grab locks in opposite order under concurrent load',
        },
        { role: 'user', text: 'so we need to split them per table?' },
        {
          role: 'assistant',
          text: 'yes, one transaction per table removes the cross-table lock ordering problem entirely',
        },
      ],
      tool_executions: [
        {
          tool: 'bash',
          input: 'npm run migrate:up-all',
          status: 'error',
          output: {
            stderr:
              'deadlock detected while waiting for ShareLock on relation "orders"; process holds ShareLock on "invoices"',
          },
          duration_ms: 42000,
        },
      ],
      observations: [
        'root cause: multi-table DDL in a single transaction, no lock_timeout convention in the repo',
        'fix: per-table migration split is the only structural fix; a retry loop just narrows the window',
      ],
    },
  },
  {
    id: 'auth-token-decision',
    title: 'Token refresh strategy decision',
    content: {
      summary: 'picked a refresh-token rotation strategy for the mobile client',
      turns: [
        {
          role: 'user',
          text: 'should we do silent refresh or rotate the refresh token on every use',
        },
        {
          role: 'assistant',
          text: 'rotation is safer: a stolen refresh token becomes useless after its first replay, and we can detect reuse as a compromise signal',
        },
        { role: 'user', text: 'what about clients that queue two requests and race the refresh' },
        {
          role: 'assistant',
          text: 'grace window: the old token stays valid for a few seconds after rotation so a racing request does not fail',
        },
      ],
      observations: [
        'decision: rotate the refresh token on every use, with a 10s grace window and reuse detection',
      ],
    },
  },
  {
    id: 'flaky-test-bisect',
    title: 'Bisecting a flaky integration test',
    content: {
      summary: 'found the cause of an intermittently failing integration test',
      tool_executions: [
        {
          tool: 'bash',
          input: 'git bisect run npm test -- --grep "session ordering"',
          status: 'ok',
          output: 'first bad commit: 7a1f9c2 "batch session writes"',
          duration_ms: 210000,
        },
        {
          tool: 'bash',
          input: 'npm test -- --grep "session ordering" --repeat 20',
          status: 'error',
          output: '3 of 20 runs failed with out-of-order session ids',
          duration_ms: 18000,
        },
      ],
      turns: [
        {
          role: 'assistant',
          text: 'the batched write path sorts sessions by Date.now() at enqueue time, and two sessions created in the same millisecond tie and sort arbitrarily',
        },
      ],
      observations: [
        'insight: Date.now() has millisecond resolution, not enough to order same-tick writes; switch the sort key to the monotonic sequence already on the row',
      ],
    },
  },
  {
    id: 'onboarding-notes',
    title: 'New engineer onboarding notes',
    content: {
      observations: [
        'local dev needs docker compose up and a seeded .env, no separate database setup step',
        'the test suite is serial and bails on first failure, expect a full run to take a few minutes',
        'PRs need a green build and one approving review before merge',
      ],
    },
  },
  {
    id: 'perf-regression',
    title: 'Query performance regression',
    content: {
      summary: 'diagnosed and fixed a slow dashboard query',
      tool_executions: [
        {
          tool: 'bash',
          input:
            'EXPLAIN ANALYZE SELECT * FROM events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50',
          status: 'ok',
          output: 'Seq Scan on events (cost=0..48213 rows=910000) actual time=812.441..812.443',
          duration_ms: 820,
        },
      ],
      turns: [
        { role: 'user', text: 'the dashboard got slow this week, can you take a look' },
        {
          role: 'assistant',
          text: 'the events query is doing a full table scan; there is no index on (workspace_id, created_at)',
        },
        { role: 'user', text: 'go ahead and add it' },
      ],
      observations: [
        'plan: add a composite index on events(workspace_id, created_at desc), then re-run EXPLAIN ANALYZE to confirm the scan drops',
        'decision: add the index in a migration rather than a manual DDL, so it is reproducible',
      ],
    },
  },
  {
    id: 'oncall-incident',
    title: 'Oncall incident retro',
    content: {
      summary: 'retro on a deploy-time healthcheck flap that paged oncall',
      tool_executions: [
        {
          tool: 'bash',
          input: 'curl -sf https://internal/healthz',
          status: 'error',
          output: 'connection refused',
          duration_ms: 1200,
        },
        {
          tool: 'bash',
          input: 'curl -sf https://internal/healthz',
          status: 'ok',
          output: '{"status":"ok"}',
          duration_ms: 90,
        },
      ],
      turns: [
        {
          role: 'user',
          text: "the pager went off again during last night's deploy, same as the last three deploys",
        },
        {
          role: 'assistant',
          text: 'the healthcheck starts polling before the new pod finishes its migration step, so it sees a connection refused for a few seconds every time',
        },
        { role: 'user', text: 'that is a pattern then, not a one-off' },
        {
          role: 'assistant',
          text: 'right, it has happened on every deploy this week; the fix is a startup probe with a longer initial delay instead of tuning the liveness probe',
        },
      ],
      observations: [
        'pattern: healthcheck flaps on every deploy, not intermittent',
        'event: three pages this week, all during the same migration-then-serve startup window',
      ],
    },
  },
  {
    id: 'refactor-plan',
    title: 'Planning a module refactor',
    content: {
      summary: 'scoped a plan to split the billing module into sub-modules',
      turns: [
        {
          role: 'user',
          text: 'billing.service.ts is over two thousand lines now, what is the plan to break it up',
        },
        {
          role: 'assistant',
          text: 'goal is to split it along the three things it currently does: invoicing, payouts, and reconciliation',
        },
        {
          role: 'assistant',
          text: 'plan: extract invoicing first since it has the fewest cross-calls into the other two, then payouts, then reconciliation last since it reads from both',
        },
        { role: 'user', text: 'sounds right, start with invoicing' },
      ],
      observations: [
        'decision: extract in dependency order (invoicing, payouts, reconciliation) rather than by line count',
      ],
    },
  },
  {
    id: 'dependency-upgrade',
    title: 'Upgrading a flaky test dependency',
    content: {
      summary: 'pinned a test-runner dependency after an upgrade broke parallel runs',
      tool_executions: [
        {
          tool: 'bash',
          input: 'npm install vitest@latest',
          status: 'ok',
          output: 'added vitest@4.2.0',
          duration_ms: 8000,
        },
        {
          tool: 'bash',
          input: 'npm test',
          status: 'error',
          output: '12 suites failed with "worker exited unexpectedly"',
          duration_ms: 34000,
        },
      ],
      turns: [
        {
          role: 'assistant',
          text: "the 4.2.0 release changed the default worker pool and it is crashing on this machine's sandboxed fork() calls",
        },
      ],
      observations: [
        'decision: pin vitest to 4.1.11 until the sandbox issue is fixed upstream, tracked as a follow-up',
      ],
    },
  },
  {
    id: 'design-review-notes',
    title: 'Design review: search response cache invalidation',
    content: {
      summary: 'design review notes on a response cache for the search endpoint',
      turns: [
        {
          role: 'user',
          text: 'walk me through the cache invalidation approach for the new search cache',
        },
        {
          role: 'assistant',
          text: 'key on the query plus a version stamp from the underlying index; a write bumps the stamp so every cached entry for that index goes stale in one step instead of a scan-and-delete',
        },
        { role: 'user', text: 'and read latency has been creeping up this week, is that related' },
        {
          role: 'assistant',
          text: 'no, that is the unrelated growth in result set size; the cache does not touch that',
        },
      ],
      observations: [
        'concept: version-stamp invalidation avoids a scan over cached keys on write',
        'trend: read latency has been rising over the week, unrelated to the cache design, worth its own investigation',
      ],
    },
  },
];
