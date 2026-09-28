#!/usr/bin/env node
// A few real recalls, assessed by each provider that has a key, side by side.
//
// The candidates are what each session was last served (`last_pack`), and the query is the first
// cue that pack searched on. That is a narrower pool than a live recall shows the model, since it
// holds only what the ranking admitted, but it is real content and a real question. The store is
// opened read-only and nothing is written anywhere; the calls bypass the service's spend ledger,
// so each one's cost is printed instead.
//
//   npm run build
//   node scripts/compare-recall-assessment.mjs --show-prompt          # the input, no calls
//   AION_ANTHROPIC_API_KEY=... AION_OPENAI_API_KEY=... \
//     node scripts/compare-recall-assessment.mjs [--count 5] [--store ~/.aion/aion.sqlite]
//
// Keys are read from the environment only and never printed.

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AnthropicProvider } from '../packages/core/dist/infrastructure/providers/anthropic-provider.js';
import { estimateApiCost } from '../packages/core/dist/infrastructure/providers/api-pricing.js';
import { OpenAiProvider } from '../packages/core/dist/infrastructure/providers/openai-provider.js';
import {
  assessCandidates,
  buildAssessmentMessages,
} from '../packages/core/dist/recall/application/assessment.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const storePath = option('--store', join(homedir(), '.aion', 'aion.sqlite'));
const count = Number(option('--count', '5'));
/** Long enough to learn the real latency rather than time out on it; the shipped guard is 8s. */
const budgetMs = Number(option('--budget-ms', '30000'));

/**
 * A stored pack keeps the bucket and not the graph label, so the two buckets that sort by how a
 * memory was found rather than what it is get a neutral kind instead of a guessed one.
 */
const LABEL_BY_BUCKET = {
  facts: 'Fact',
  episodes: 'Episode',
  narratives: 'Narrative',
  intentions: 'Intention',
  preferences: 'Preference',
  resonant: 'Memory',
};
const POPULATION_BY_BUCKET = { resonant: 'associated', intentions: 'reminder' };
const EMPTY_VIEW = {
  provenance: new Map(),
  relatedClaims: new Map(),
  ownership: new Map(),
  degraded: new Set(),
  issues: [],
};
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

function recalls() {
  const db = new Database(storePath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT pack_json FROM last_pack ORDER BY ts DESC')
      .all()
      .map((row) => JSON.parse(row.pack_json))
      .map((pack) => {
        const query = (pack.metadata?.cues ?? []).find((cue) =>
          ['query', 'raw_query'].includes(cue.source),
        )?.text;
        const entries = Object.keys(LABEL_BY_BUCKET).flatMap((bucket) =>
          (pack[bucket] ?? []).map((item) => ({
            population: POPULATION_BY_BUCKET[bucket] ?? 'found',
            item: {
              id: item.id,
              labels: [LABEL_BY_BUCKET[bucket]],
              content: item.content,
              ...(item.occurred_at === undefined ? {} : { occurredAt: new Date(item.occurred_at) }),
              currency: item.currency,
              ...(item.superseded_by === undefined
                ? {}
                : {
                    supersededBy: {
                      id: item.superseded_by.id,
                      at: new Date(item.superseded_by.at),
                    },
                  }),
              ...(item.why === undefined ? {} : { why: item.why }),
              ...(item.context === undefined ? {} : { context: item.context }),
              rationale: item.rationale,
              relevance: 0,
              measured: 0,
              score: 0,
            },
          })),
        );
        const order = { found: 0, associated: 1, reminder: 2 };
        entries.sort((left, right) => order[left.population] - order[right.population]);
        return { query, pool: { entries, omitted: 0 } };
      })
      .filter((recall) => recall.query !== undefined && recall.pool.entries.length > 1)
      .slice(0, count);
  } finally {
    db.close();
  }
}

function routes() {
  const found = [];
  const anthropic = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
  const openai = (process.env.AION_OPENAI_API_KEY ?? '').trim();
  const calls = [];
  const recordApiCall = (call) => calls.push(call);
  if (anthropic !== '') {
    const model = process.env.AION_ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
    found.push({
      name: `anthropic:${model}`,
      backend: new AnthropicProvider({ apiKey: anthropic, model, recordApiCall }),
      route: { provider: 'anthropic', model },
    });
  }
  if (openai !== '') {
    const model = process.env.AION_OPENAI_MODEL ?? 'gpt-6-luna';
    found.push({
      name: `openai:${model}`,
      backend: new OpenAiProvider({ apiKey: openai, model, recordApiCall }),
      route: { provider: 'openai', model },
    });
  }
  return { found, calls };
}

function short(text, length = 90) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= length ? flat : `${flat.slice(0, length)}...`;
}

async function main() {
  const sample = recalls();
  if (sample.length === 0) {
    process.stdout.write(`no served recall with two or more memories in ${storePath}\n`);
    return;
  }
  if (flag('--show-prompt')) {
    const [first] = sample;
    for (const message of buildAssessmentMessages({ query: first.query }, first.pool, EMPTY_VIEW)) {
      process.stdout.write(`--- ${message.role}\n${message.content}\n`);
    }
    return;
  }
  const { found, calls } = routes();
  if (found.length === 0) {
    process.stdout.write('set AION_ANTHROPIC_API_KEY and/or AION_OPENAI_API_KEY to compare\n');
    process.exitCode = 1;
    return;
  }
  for (const [index, recall] of sample.entries()) {
    process.stdout.write(
      `\n#${String(index + 1)} ${short(recall.query, 110)}  (${String(recall.pool.entries.length)} candidates)\n`,
    );
    for (const route of found) {
      const provider = {
        generate: (request) => route.backend.generate(request),
        embed: () => Promise.reject(new Error('this comparison embeds nothing')),
        route: route.route,
      };
      const before = calls.length;
      const started = Date.now();
      const outcome = await assessCandidates(
        { provider, budgetMs, logger: QUIET },
        { query: recall.query },
        recall.pool,
        EMPTY_VIEW,
      );
      const elapsed = Date.now() - started;
      const spent = calls.slice(before);
      const usd = spent.reduce((total, call) => total + (estimateApiCost(call) ?? Number.NaN), 0);
      const tokens = spent.map(
        (call) =>
          `in ${String(call.inputTokens + call.cacheReadTokens + call.cacheCreationTokens)} ` +
          `out ${String(call.outputTokens)}${call.thinkingTokens === undefined ? '' : ` (reasoning ${String(call.thinkingTokens)})`}`,
      );
      process.stdout.write(
        `  ${route.name}  ${String(elapsed)}ms  ${tokens.join('; ')}  $${usd.toFixed(5)}\n`,
      );
      if (outcome.kind === 'failed') {
        process.stdout.write(`    failed: ${outcome.reason}\n`);
        continue;
      }
      const byId = new Map(recall.pool.entries.map((entry, n) => [entry.item.id, n + 1]));
      if (outcome.ids.length === 0) {
        process.stdout.write('    selected nothing\n');
      }
      for (const id of outcome.ids) {
        const entry = recall.pool.entries.find((candidate) => candidate.item.id === id);
        process.stdout.write(
          `    #${String(byId.get(id))} ${entry?.population ?? '?'}: ${short(entry?.item.content ?? '')}\n`,
        );
      }
      if (outcome.note !== undefined) {
        process.stdout.write(`    note: ${outcome.note}\n`);
      }
    }
  }
}

await main();
