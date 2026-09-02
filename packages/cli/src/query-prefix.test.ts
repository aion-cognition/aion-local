import { DEFAULTS, type Config, type GraphConnection, type SeedCue } from '@aion/core';
import {
  embedQueryPrefix,
  QUERY_PREFIX_SEAM_MODEL,
} from '@aion/core/infrastructure/providers/embed-models.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDoctorChecks } from './doctor.js';
import { runForget } from './forget.js';
import { runSearch } from './search.js';
import type { Substrate, SubstrateCommand } from './substrate.js';

/**
 * Three commands embed a query the way recall does, each composing the model's prefix in front
 * of the text itself. Every row a model can be configured onto carries an empty prefix, so a run
 * on the shipped model cannot tell the composition from a build with it deleted; these drive the
 * real call sites on the seam row `embed-models.ts` keeps for exactly that, and pin which text
 * carries the prefix ahead of turning the measured row on.
 */

const QUERY = 'webhooks ingestion';
const PREFIX = embedQueryPrefix(QUERY_PREFIX_SEAM_MODEL);

const seam = vi.hoisted(() => ({
  /** Every batch handed to the provider, in order. */
  embedded: [] as string[][],
  /** The cues the seed layer was asked with, which travel on with what surfaces. */
  cues: [] as SeedCue[][],
  /** The model each provider was constructed on, which has to be the one the prefix was read from. */
  models: [] as string[],
}));

vi.mock('@aion/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    OllamaProvider: class {
      constructor(options: { readonly embedModel: string }) {
        seam.models.push(options.embedModel);
      }
      async embed(texts: readonly string[]): Promise<number[][]> {
        seam.embedded.push([...texts]);
        return texts.map(() => [1, 0, 0]);
      }
    },
    selectSeeds: async (_deps: unknown, input: { readonly cues: readonly SeedCue[] }) => {
      seam.cues.push([...input.cues]);
      return { seeds: [], budget: 0, graphUnavailable: false, lists: [] };
    },
  };
});

/**
 * Every command opens its own config, logger, database and driver through this; the stub hands
 * back the seam model and a driver nothing here reaches, so the command runs to the embed call
 * without a substrate to talk to.
 */
vi.mock('./substrate.js', () => ({
  withSubstrate: async (command: SubstrateCommand<unknown>): Promise<number> =>
    await command.run(stubSubstrate(), command.parse(command.argv)),
}));

function seamConfig(): Config {
  return { ...DEFAULTS, models: { ...DEFAULTS.models, embed: QUERY_PREFIX_SEAM_MODEL } };
}

function stubSubstrate(): Substrate {
  const noop = (): void => {
    // A command under test prints and logs; neither is what these pin.
  };
  return {
    config: seamConfig(),
    write: noop,
    logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    connection: () => ({ driver: {} }) as unknown as GraphConnection,
    db: () => ({}),
  } as unknown as Substrate;
}

beforeEach(() => {
  seam.embedded.length = 0;
  seam.cues.length = 0;
  seam.models.length = 0;
});

describe('the query prefix at every command that embeds a query', () => {
  it('is composed once, in front of the text `aion search` sends the model', async () => {
    const exit = await runSearch([QUERY], () => {
      // Rendering is `renderSearchResults`'s test, not this one.
    });

    expect(exit).toBe(0);
    expect(PREFIX).not.toBe('');
    expect(seam.embedded).toEqual([[`${PREFIX}${QUERY}`]]);
    // The prefix marks the text sent to the model and never the cue: what is scored, logged and
    // rendered downstream is the query the operator typed.
    expect(seam.cues[0]?.map((cue) => cue.text)).toEqual([QUERY]);
    expect(seam.models).toEqual([QUERY_PREFIX_SEAM_MODEL]);
  });

  it('is composed once, in front of the text `aion forget` resolves on', async () => {
    const exit = await runForget([QUERY], () => {
      // No match, so nothing is written; the embed call is what this pins.
    });

    expect(exit).toBe(1);
    expect(PREFIX).not.toBe('');
    expect(seam.embedded).toEqual([[`${PREFIX}${QUERY}`]]);
    expect(seam.cues[0]?.map((cue) => cue.text)).toEqual([QUERY]);
    expect(seam.models).toEqual([QUERY_PREFIX_SEAM_MODEL]);
  });

  /**
   * The doctor measures the two committed distributions on this machine's model, and it has to
   * measure them the way recall reads them: the cue side prefixed, the content side raw. Both
   * sides prefixed describes a distribution the runtime never produces, and a doctor that
   * reports `ok` where the committed test fails is the one failure a field check must not have.
   */
  it('goes on the cue side only of the doctor floor check', async () => {
    const check = buildDoctorChecks({
      config: seamConfig(),
      connection: undefined as unknown as GraphConnection,
      db: undefined as unknown as never,
    }).find((candidate) => candidate.name === 'floor-calibration');

    const result = await check?.run();

    expect(result?.ok).toBe(true);
    const texts = seam.embedded.flat();
    const prefixed = texts.filter((text) => text.startsWith(PREFIX));
    expect(PREFIX).not.toBe('');
    expect(texts.length).toBeGreaterThan(0);
    // Each measured pair is one prefixed cue against one raw content, and the mutually-unrelated
    // set is embedded in both spellings, so exactly half the batch carries the prefix.
    expect(prefixed).toHaveLength(texts.length / 2);
    expect(texts[0]?.startsWith(PREFIX)).toBe(true);
    expect(texts[1]?.startsWith(PREFIX)).toBe(false);
  });
});
