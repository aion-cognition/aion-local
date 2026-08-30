import { CueSchema, DegradationSchema } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  BARE_QUERY_FIXTURES,
  CUE_FIXTURES,
  SUMMARY_TONE_FIXTURES,
  SUMMARY_TONE_QUERY,
} from './cues.fixtures.js';
import { CueCache, extractCues, type CueExtractionDeps } from './cues.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';

/**
 * Live smoke test against host Ollama: proves the one `generate` call round-trips against
 * the real cue model, records latency, and gates the two aggregate quality numbers that
 * decide whether cue extraction is running at all. Per-fixture assertions stay structural
 * (protocol shape, not cue content) so the suite never flakes on what a real model happens
 * to return; the aggregates are what would have caught a config whose every extraction
 * degraded while every structural assertion still passed.
 */

/**
 * The degradation ladder is a fallback, so a healthy install never rides it: a degraded
 * fixture means the budget or the model is misconfigured, which is a defect and not a flake.
 *
 * Split by reason, because only one of them is a fact about the code. A model that returns
 * an unusable shape or errors outright is broken however busy the machine is, so that count
 * stays at zero. A single `timeout` is a fact about the wall clock, since this suite shares a
 * laptop with a live Neo4j, a reflection pipeline and the same Ollama it is measuring, and
 * a misconfigured budget shows up as most of the set timing out, not one of eight.
 */
const MAX_DEGRADED = 0;
const MAX_TIMED_OUT = 1;

/**
 * Empty cue sets are the one place model nondeterminism is tolerated. A quarter of the
 * fixture set is loose enough that a single unlucky generation passes and tight enough that
 * an extraction which has stopped working does not.
 */
const MAX_EMPTY_RATE = 0.25;

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const CUE_MODEL = process.env.AION_CUE_MODEL ?? DEFAULTS.models.cue;

type SpotRow = {
  readonly id: string;
  readonly cues: number;
  readonly degraded: boolean;
  readonly reason: string;
  readonly latencyMs: number;
};

const dataDir = mkdtempSync(join(tmpdir(), 'aion-cues-int-'));
const rows: SpotRow[] = [];

// The local cue model is the subject, so this builds `OllamaProvider` directly rather than
// taking the test route that sends generations to a remote model. A remote pass here would
// report latency and quality numbers for a model the install never runs.
const deps: CueExtractionDeps = {
  provider: new OllamaProvider({ baseUrl: OLLAMA_URL, embedModel: DEFAULTS.models.embed }),
  model: CUE_MODEL,
  budgetMs: DEFAULTS.recall.cueBudgetMs,
  cache: new CueCache(),
  logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
};

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cue extraction against live host Ollama', () => {
  it.each(CUE_FIXTURES)(
    'extracts a structurally valid result for: $description',
    async (fixture) => {
      const start = Date.now();
      const result = await extractCues(deps, fixture.input);
      const latencyMs = Date.now() - start;

      rows.push({
        id: fixture.id,
        cues: result.cues.length,
        degraded: result.degraded,
        reason: result.degradation?.reason ?? '',
        latencyMs,
      });

      expect(Array.isArray(result.cues)).toBe(true);
      for (const cue of result.cues) {
        expect(CueSchema.parse(cue)).toEqual(cue);
      }
      expect(typeof result.degraded).toBe('boolean');
      if (result.degraded) {
        expect(DegradationSchema.parse(result.degradation)).toEqual(result.degradation);
      } else {
        expect(result.degradation).toBeUndefined();
      }
    },
    30_000,
  );

  // Last, so every fixture above has already pushed its row. Vitest runs a file's tests in
  // declaration order, which is what makes an aggregate assertion a test rather than a hook.
  it('extracts cues rather than riding the degradation ladder', () => {
    const emptyCount = rows.filter((row) => row.cues === 0).length;
    const timedOut = rows.filter((row) => row.degraded && row.reason === 'timeout');
    const degradedCount = rows.filter((row) => row.degraded).length - timedOut.length;
    const latencies = rows.map((row) => row.latencyMs).sort((left, right) => left - right);

    console.table(rows);
    console.log(
      `cue quality: ${String(rows.length)} queries, ` +
        `empty ${String(emptyCount)}/${String(rows.length)}, ` +
        `degraded ${String(degradedCount)}/${String(rows.length)}, ` +
        `timed out ${String(timedOut.length)}/${String(rows.length)}, ` +
        `latency min ${String(latencies[0])}ms median ${String(latencies[Math.floor(latencies.length / 2)])}ms ` +
        `max ${String(latencies.at(-1))}ms, model ${CUE_MODEL}, budget ${String(deps.budgetMs)}ms`,
    );

    expect(rows).toHaveLength(CUE_FIXTURES.length);
    expect(degradedCount).toBeLessThanOrEqual(MAX_DEGRADED);
    expect(timedOut.length).toBeLessThanOrEqual(MAX_TIMED_OUT);
    expect(emptyCount / rows.length).toBeLessThanOrEqual(MAX_EMPTY_RATE);
  });
});

/**
 * The three A5 behaviours the live model has to hold up, as opposed to the ones the mocked
 * tests pin. The raw-query rule is code and is asserted here only because a live run is where
 * a prompt change would silently break it; the intent and genericness judgments are the
 * model's own and this is the only place they are measured.
 */
describe('the hardened prompt against the live cue model', () => {
  it.each(BARE_QUERY_FIXTURES)(
    'keeps the raw query and stays terse on a bare off-topic query: $input.query',
    async (fixture) => {
      const result = await extractCues(deps, fixture.input);

      console.log(`"${fixture.input.query}" -> ${result.cues.map((cue) => cue.text).join(' | ')}`);
      expect(result.cues[0]).toEqual({
        text: fixture.input.query,
        source: 'query',
        weight: 3,
      });
      // A query naming nothing the substrate could hold should not turn into a topic list.
      // Six is loose enough for one unlucky generation and tight enough to catch a prompt
      // that has gone back to inventing.
      expect(result.cues.length).toBeLessThanOrEqual(6);
    },
    30_000,
  );

  it('judges a decision-shaped query decision-shaped and a measurement query not', async () => {
    const decision = await extractCues(deps, {
      query: 'what did we decide about the remittance ingest transport and why',
    });
    const measurement = await extractCues(deps, {
      query: 'how long does the split migration take on a production sized copy',
    });

    console.log(
      `intent: decision-shaped -> ${String(decision.cues[0]?.intent)}, ` +
        `measurement -> ${String(measurement.cues[0]?.intent)}`,
    );
    expect(decision.cues.every((cue) => cue.intent === 'decision')).toBe(true);
    expect(measurement.cues.every((cue) => cue.intent === undefined)).toBe(true);
  }, 60_000);

  it.each(SUMMARY_TONE_FIXTURES)(
    'damps the summary to 1x whatever it says: $summary',
    async (fixture) => {
      const result = await extractCues(deps, {
        query: SUMMARY_TONE_QUERY,
        summary: fixture.summary,
      });
      const summaryCues = result.cues.filter((cue) => cue.source === 'summary');

      console.log(
        `"${fixture.summary.slice(0, 48)}" -> ${String(summaryCues.length)} summary cues ` +
          `(${fixture.measured})`,
      );
      expect(result.cues[0]?.text).toBe(SUMMARY_TONE_QUERY);
      for (const cue of summaryCues) {
        expect(cue.weight).toBe(1);
      }
    },
    30_000,
  );
});
