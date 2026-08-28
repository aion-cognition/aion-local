import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CueSchema, DegradationSchema } from '@aion/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import { CUE_FIXTURES } from './cues.fixtures.js';
import { CueCache, extractCues, type CueExtractionDeps } from './cues.js';

/**
 * Live smoke test against host Ollama: proves the one `generate` call round-trips against
 * the real cue model, records latency, and gates the two aggregate quality numbers that
 * decide whether Algorithm 1 is running at all. Per-fixture assertions stay structural
 * (protocol shape, not cue content) so the suite never flakes on what a real model happens
 * to return; the aggregates are what would have caught a config whose every extraction
 * degraded while every structural assertion still passed.
 */

/**
 * The degradation ladder is a fallback, so a healthy install never rides it: any degraded
 * fixture means the budget or the model is misconfigured, which is a defect and not a flake.
 */
const MAX_DEGRADED = 0;

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
  it.each(CUE_FIXTURES)('extracts a structurally valid result for: $description', async (fixture) => {
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
  }, 30_000);

  // Last, so every fixture above has already pushed its row. Vitest runs a file's tests in
  // declaration order, which is what makes an aggregate assertion a test rather than a hook.
  it('extracts cues rather than riding the degradation ladder', () => {
    const emptyCount = rows.filter((row) => row.cues === 0).length;
    const degradedCount = rows.filter((row) => row.degraded).length;
    const latencies = rows.map((row) => row.latencyMs).sort((left, right) => left - right);

    console.table(rows);
    console.log(
      `cue quality: ${String(rows.length)} queries, ` +
        `empty ${String(emptyCount)}/${String(rows.length)}, ` +
        `degraded ${String(degradedCount)}/${String(rows.length)}, ` +
        `latency min ${String(latencies[0])}ms median ${String(latencies[Math.floor(latencies.length / 2)])}ms ` +
        `max ${String(latencies.at(-1))}ms, model ${CUE_MODEL}, budget ${String(deps.budgetMs)}ms`,
    );

    expect(rows).toHaveLength(CUE_FIXTURES.length);
    expect(degradedCount).toBeLessThanOrEqual(MAX_DEGRADED);
    expect(emptyCount / rows.length).toBeLessThanOrEqual(MAX_EMPTY_RATE);
  });
});
