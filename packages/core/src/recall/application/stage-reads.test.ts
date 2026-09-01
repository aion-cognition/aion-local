import type { Cue } from '@aion/protocol';
import { describe, expect, it, vi } from 'vitest';

import { embedCues, type StageReadDeps } from './stage-reads.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
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
  it('marks every cue as a query for a model trained on asymmetric retrieval', async () => {
    const embed = vi.fn(async () => [[1], [2]]);
    const result = await embedCues(deps('snowflake-arctic-embed2', embed), CUES);

    expect(embed).toHaveBeenCalledWith([
      'query: what did we decide about the embed model',
      'query: arctic2',
    ]);
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
