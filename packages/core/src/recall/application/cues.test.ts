import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CueSchema, DegradationSchema } from '@aion/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { CueCache, extractCues, type CueExtractionDeps } from './cues.js';

const MODEL = 'qwen3:1.7b';
const BUDGET_MS = 2000;

let dataDir: string;
let generate: ReturnType<typeof vi.fn>;
let embed: ReturnType<typeof vi.fn>;
let deps: CueExtractionDeps;

function fullOutput(overrides: Partial<Record<'query_cues' | 'summary_cues' | 'recent_turn_cues', string[]>> = {}) {
  return {
    query_cues: overrides.query_cues ?? ['migration deadlock', 'per-table split'],
    summary_cues: overrides.summary_cues ?? ['production deploy'],
    recent_turn_cues: overrides.recent_turn_cues ?? ['dry run'],
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-cues-test-'));
  generate = vi.fn();
  embed = vi.fn(() => Promise.reject(new Error('cue extraction must never call embed')));
  const provider: Provider = {
    embed: embed as Provider['embed'],
    generate,
  };
  deps = {
    provider,
    model: MODEL,
    budgetMs: BUDGET_MS,
    cache: new CueCache(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
  };
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('bucket weighting', () => {
  it('assigns 3x to query cues, 2x to summary cues, 1x to recent-turn cues', async () => {
    generate.mockResolvedValue(fullOutput());

    const result = await extractCues(deps, {
      query: 'why did the migration deadlock',
      summary: 'debugging a production deploy blocked on a schema migration',
      recentTurns: [{ role: 'user', text: 'did the dry run come back clean' }],
    });

    expect(result.degraded).toBe(false);
    expect(result.cues).toEqual([
      { text: 'migration deadlock', source: 'query', weight: 3 },
      { text: 'per-table split', source: 'query', weight: 3 },
      { text: 'production deploy', source: 'summary', weight: 2 },
      { text: 'dry run', source: 'recent_turns', weight: 1 },
    ]);
    for (const cue of result.cues) {
      expect(CueSchema.parse(cue)).toEqual(cue);
    }
  });

  it('drops a bucket the caller never supplied, even if the model fills it in anyway', async () => {
    generate.mockResolvedValue(fullOutput());

    const result = await extractCues(deps, { query: 'why did the migration deadlock' });

    expect(result.cues).toEqual([
      { text: 'migration deadlock', source: 'query', weight: 3 },
      { text: 'per-table split', source: 'query', weight: 3 },
    ]);
  });

  it('dedupes case-insensitively across buckets, keeping the highest-weight instance', async () => {
    generate.mockResolvedValue(
      fullOutput({
        query_cues: ['deadlock fix', 'Migration'],
        summary_cues: ['migration', 'unique summary cue'],
        recent_turn_cues: ['deadlock fix', 'unique recent cue'],
      }),
    );

    const result = await extractCues(deps, {
      query: 'q',
      summary: 's',
      recentTurns: [{ role: 'user', text: 't' }],
    });

    expect(result.cues).toEqual([
      { text: 'deadlock fix', source: 'query', weight: 3 },
      { text: 'Migration', source: 'query', weight: 3 },
      { text: 'unique summary cue', source: 'summary', weight: 2 },
      { text: 'unique recent cue', source: 'recent_turns', weight: 1 },
    ]);
  });

  it('trims whitespace and drops blank entries', async () => {
    generate.mockResolvedValue(fullOutput({ query_cues: ['  padded  ', '', '   '] }));

    const result = await extractCues(deps, { query: 'q' });

    expect(result.cues).toEqual([{ text: 'padded', source: 'query', weight: 3 }]);
  });
});

describe('caching', () => {
  it('calls the model once for two identical inputs sharing a cache', async () => {
    generate.mockResolvedValue(fullOutput());
    const input = { query: 'why did the migration deadlock' };

    const first = await extractCues(deps, input);
    const second = await extractCues(deps, input);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('misses the cache when the query differs', async () => {
    generate.mockResolvedValue(fullOutput());

    await extractCues(deps, { query: 'first query' });
    await extractCues(deps, { query: 'second query' });

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('misses the cache when the model differs, even for the same input', async () => {
    generate.mockResolvedValue(fullOutput());
    const input = { query: 'why did the migration deadlock' };

    await extractCues(deps, input);
    await extractCues({ ...deps, model: 'qwen3:8b' }, input);

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not cache a degraded result', async () => {
    generate.mockRejectedValue(new Error('ollama unreachable'));
    const input = { query: 'why did the migration deadlock' };

    await extractCues(deps, input);
    await extractCues(deps, input);

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry once the cache is full (FIFO)', async () => {
    const cache = new CueCache(2);
    deps = { ...deps, cache };
    generate.mockResolvedValue(fullOutput());

    await extractCues(deps, { query: 'first' });
    await extractCues(deps, { query: 'second' });
    await extractCues(deps, { query: 'third' });
    expect(cache.size).toBe(2);

    await extractCues(deps, { query: 'first' });
    expect(generate).toHaveBeenCalledTimes(4);

    await extractCues(deps, { query: 'third' });
    expect(generate).toHaveBeenCalledTimes(4);
  });
});

describe('degradation ladder', () => {
  it('degrades to a raw-query cue when the model call rejects', async () => {
    generate.mockRejectedValue(new Error('ollama unreachable'));

    const result = await extractCues(deps, { query: '  why did the migration deadlock  ' });

    expect(result).toEqual({
      degraded: true,
      cues: [{ text: 'why did the migration deadlock', source: 'raw_query', weight: 3 }],
      degradation: { stage: 'cues', reason: 'model_error' },
    });
    expect(DegradationSchema.parse(result.degradation)).toEqual(result.degradation);
    expect(CueSchema.parse(result.cues[0])).toEqual(result.cues[0]);
  });

  it('carries the caller-supplied summary through the ladder at its 2x weight', async () => {
    generate.mockRejectedValue(new Error('ollama unreachable'));

    const result = await extractCues(deps, {
      query: 'why did we pick webhooks',
      summary: '  debugging the ingestion service rollout  ',
      recentTurns: [{ role: 'user', text: 'did the dry run come back clean' }],
    });

    expect(result.cues).toEqual([
      { text: 'why did we pick webhooks', source: 'raw_query', weight: 3 },
      { text: 'debugging the ingestion service rollout', source: 'raw_summary', weight: 2 },
    ]);
    for (const cue of result.cues) {
      expect(CueSchema.parse(cue)).toEqual(cue);
    }
  });

  it('emits only the raw-query cue when the summary is absent or blank', async () => {
    generate.mockRejectedValue(new Error('ollama unreachable'));

    const blank = await extractCues(deps, { query: 'why did we pick webhooks', summary: '   ' });

    expect(blank.cues).toEqual([
      { text: 'why did we pick webhooks', source: 'raw_query', weight: 3 },
    ]);
  });

  it('degrades with reason invalid_output when the response fails schema validation', async () => {
    generate.mockResolvedValue({ cues: ['not', 'the', 'right', 'shape'] });

    const result = await extractCues(deps, { query: 'why did the migration deadlock' });

    expect(result.degraded).toBe(true);
    expect(result.degradation).toEqual({ stage: 'cues', reason: 'invalid_output' });
  });

  it('degrades with reason invalid_output when a required bucket has the wrong type', async () => {
    generate.mockResolvedValue({ query_cues: 'not an array', summary_cues: [], recent_turn_cues: [] });

    const result = await extractCues(deps, { query: 'why did the migration deadlock' });

    expect(result.degraded).toBe(true);
    expect(result.degradation).toEqual({ stage: 'cues', reason: 'invalid_output' });
  });

  it('degrades with reason timeout when the budget elapses before the model responds', async () => {
    vi.useFakeTimers();
    generate.mockImplementation(
      (req: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const pending = extractCues(deps, { query: 'why did the migration deadlock' });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const result = await pending;

    expect(result.degraded).toBe(true);
    expect(result.degradation).toEqual({ stage: 'cues', reason: 'timeout' });
  });

  it('passes the budget to the provider as an AbortSignal that has not fired before the deadline', async () => {
    generate.mockImplementation((req: { signal?: AbortSignal }) => {
      expect(req.signal).toBeInstanceOf(AbortSignal);
      expect(req.signal?.aborted).toBe(false);
      return Promise.resolve(fullOutput());
    });

    const result = await extractCues(deps, { query: 'why did the migration deadlock' });

    expect(result.degraded).toBe(false);
  });
});

describe('the one generate() call', () => {
  it('never calls embed', async () => {
    generate.mockResolvedValue(fullOutput());

    await extractCues(deps, { query: 'why did the migration deadlock' });

    // Asserted rather than inferred from the rejecting mock: `callCueModel` catches every
    // throw, so an embed call inside it would degrade silently instead of failing the test.
    expect(embed).not.toHaveBeenCalled();
  });

  it('sends the configured cue model and the JSON-schema format on the single call', async () => {
    generate.mockResolvedValue(fullOutput());

    await extractCues(deps, { query: 'why did the migration deadlock' });

    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0]?.[0];
    expect(request.model).toBe(MODEL);
    expect(request.schema).toMatchObject({
      type: 'object',
      required: ['query_cues', 'summary_cues', 'recent_turn_cues'],
    });
  });
});
