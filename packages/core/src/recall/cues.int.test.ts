import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CueSchema, DegradationSchema } from '@aion/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config/defaults.js';
import { openLogger } from '../logging/logger.js';
import { OllamaProvider } from '../providers/ollama-provider.js';
import { CUE_FIXTURES } from './cues.fixtures.js';
import { CueCache, extractCues, type CueExtractionDeps } from './cues.js';

/**
 * Live smoke test against host Ollama: proves the one `generate` call round-trips against
 * the real cue model and records latency, not a quality gate. Assertions stay structural
 * (protocol shape, not cue content) so the suite never flakes on what a real model happens
 * to return — the spot table printed in `afterAll` is what a human reads for quality.
 */

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
  console.table(rows);
  const emptyCount = rows.filter((row) => row.cues === 0).length;
  const degradedCount = rows.filter((row) => row.degraded).length;
  console.log(
    `cue quality: ${String(rows.length)} queries, empty rate ${((emptyCount / rows.length) * 100).toFixed(0)}%, ` +
      `degraded ${String(degradedCount)}/${String(rows.length)}, model ${CUE_MODEL}, budget ${String(deps.budgetMs)}ms`,
  );
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
});
