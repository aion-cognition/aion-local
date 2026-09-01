import type { Cue } from '@aion/protocol';
import { describe, expect, it, vi } from 'vitest';

import { embedCues, type StageReadDeps } from './stage-reads.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import {
  embedQueryPrefix,
  QUERY_PREFIX_SEAM_MODEL,
} from '../../infrastructure/providers/embed-models.js';
import type { Provider } from '../../infrastructure/providers/types.js';

const CUES: readonly Cue[] = [
  { text: 'what did we decide about the embed model', source: 'query', weight: 3 },
  { text: 'arctic2', source: 'summary', weight: 2 },
];

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function deps(embedModel: string, embed: Provider['embed']): StageReadDeps {
  return {
    provider: { embed } as unknown as Provider,
    config: { ...DEFAULTS, models: { ...DEFAULTS.models, embed: embedModel } },
    logger: silentLogger(),
  } as unknown as StageReadDeps;
}

describe('embedCues', () => {
  /**
   * The spelling comes from `embed-models.ts` and from nowhere else, so that one row decides it
   * for recall, `aion search`, `aion forget`, the doctor's field check and the committed
   * calibrations at once. Every row a model can be configured onto is raw today, which is why
   * the composition is asserted against the seam row: raw text is also what a build with the
   * prefix deleted would send, and Phase 4.4 turns a real row on.
   */
  it("composes the table's prefix in front of every cue, and leaves the cue text alone", async () => {
    const prefix = embedQueryPrefix(QUERY_PREFIX_SEAM_MODEL);
    const embed = vi.fn(async () => [[1], [2]]);
    const result = await embedCues(deps(QUERY_PREFIX_SEAM_MODEL, embed), CUES);

    expect(prefix).not.toBe('');
    expect(embed).toHaveBeenCalledWith(CUES.map((cue) => `${prefix}${cue.text}`));
    // The prefix marks the text sent to the model. What travels on with the seed is the cue the
    // caller asked with, and a prefix leaking into it would be matched and logged downstream.
    expect(result.cues.map((cue) => cue.text)).toEqual(CUES.map((cue) => cue.text));
    expect(result.cues[0]?.vector).toEqual([1]);
  });

  it('sends every cue in the spelling the table names for the configured model', async () => {
    const embed = vi.fn(async () => [[1], [2]]);
    const result = await embedCues(deps('snowflake-arctic-embed2', embed), CUES);

    expect(embed).toHaveBeenCalledWith(CUES.map((cue) => cue.text));
    expect(result.cues.map((cue) => cue.text)).toEqual(CUES.map((cue) => cue.text));
    expect(result.cues[0]?.vector).toEqual([1]);
  });

  it('sends a cue unchanged for a model with no query prefix', async () => {
    const embed = vi.fn(async () => [[1], [2]]);
    await embedCues(deps('nomic-embed-text', embed), CUES);

    expect(embed).toHaveBeenCalledWith(CUES.map((cue) => cue.text));
  });

  it('reports the embed rung rather than failing recall when the model errors', async () => {
    const embed = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const result = await embedCues(deps('snowflake-arctic-embed2', embed), CUES);

    expect(result.degradation).toEqual({ stage: 'embed', reason: 'model_error' });
    expect(result.cues).toEqual(CUES);
  });
});
