import {
  asOf,
  bitemporalAt,
  embedQueryPrefix,
  knewAt,
  OllamaProvider,
  selectSeeds,
  withCurrency,
  type ReadMode,
  type Seed,
  type SeedCue,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { preview } from './format.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * The seed layer with nothing built on top of it: no cue-model expansion, no traversal, no
 * resonance, no pack assembly. The query embeds once and rides the same four strategies and
 * budget curve `recall` uses (`selectSeeds`), which is what makes this a debugging window on
 * the real thing rather than a second search implementation. `--as-of`/`--knew-at` bind the
 * same bitemporal read mode `recall` does, so a time-travel search sees exactly what a
 * time-travel recall would have found.
 */

const SPEC: ArgSpec = {
  command: 'search',
  usage: 'aion search <query> [--as-of <ts>] [--knew-at <ts>] [--json]',
  options: [
    { flag: '--as-of', takesValue: true },
    { flag: '--knew-at', takesValue: true },
    { flag: '--json' },
  ],
  maxPositionals: Number.POSITIVE_INFINITY,
};

export type SearchFlags = {
  readonly query: string;
  readonly asOf?: Date;
  readonly knewAt?: Date;
  readonly json: boolean;
};

function timestampOf(values: ReadonlyMap<string, string>, option: string): Date | undefined {
  const value = values.get(option);
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliUsageError(`${option} got '${value}', expected an ISO timestamp`);
  }
  return parsed;
}

export function parseSearchFlags(argv: readonly string[]): SearchFlags {
  const { flags, values, positionals } = parseArgs(SPEC, argv);
  // An unquoted multi-word query arrives as several argv entries; join them back.
  const query = positionals.join(' ');
  if (query.trim().length === 0) {
    throw new CliUsageError('search needs a query: `aion search "<query>"`');
  }
  const asOfFlag = timestampOf(values, '--as-of');
  const knewAtFlag = timestampOf(values, '--knew-at');
  return {
    query,
    json: flags.has('--json'),
    ...(asOfFlag === undefined ? {} : { asOf: asOfFlag }),
    ...(knewAtFlag === undefined ? {} : { knewAt: knewAtFlag }),
  };
}

function readModeFor(flags: SearchFlags): ReadMode {
  if (flags.asOf !== undefined && flags.knewAt !== undefined) {
    return bitemporalAt(flags.asOf, flags.knewAt);
  }
  if (flags.asOf !== undefined) {
    return asOf(flags.asOf);
  }
  if (flags.knewAt !== undefined) {
    return knewAt(flags.knewAt);
  }
  return withCurrency();
}

/** The best of a seed's own strategies: what a reader reads as "how this was found." */
function methodOf(seed: Seed): string {
  return seed.provenance[0]?.strategy ?? '-';
}

export function renderSearchResults(seeds: readonly Seed[], write: Writer): void {
  if (seeds.length === 0) {
    write('no matches');
    return;
  }
  write(
    'score   method              currency    label          id                                    content',
  );
  for (const seed of seeds) {
    write(
      [
        seed.score.toFixed(3).padStart(5),
        methodOf(seed).padEnd(18),
        seed.currency.padEnd(10),
        (seed.labels[0] ?? '-').padEnd(13),
        seed.id,
        preview(seed.content),
      ].join('  '),
    );
  }
}

function toJson(seeds: readonly Seed[]): unknown {
  return seeds.map((seed) => ({
    id: seed.id,
    labels: seed.labels,
    content: seed.content,
    score: seed.score,
    relevance: seed.relevance,
    method: methodOf(seed),
    provenance: seed.provenance,
    currency: seed.currency,
    ...(seed.supersededBy === undefined
      ? {}
      : { superseded_by: { id: seed.supersededBy.id, at: seed.supersededBy.at.toISOString() } }),
  }));
}

export function runSearch(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseSearchFlags,
    needsGraph: 'search',
    run: async (substrate, flags) => {
      const { config } = substrate;
      const logger = substrate.logger();
      const provider = new OllamaProvider({
        baseUrl: config.ollama.url,
        embedModel: config.models.embed,
      });
      // The stored side is raw and the query side carries the model's prefix, which is the
      // asymmetry recall embeds with. A query spelled differently here would score against the
      // same vectors under floors nobody measured for it.
      const [vector] = await provider.embed([
        `${embedQueryPrefix(config.models.embed)}${flags.query}`,
      ]);
      if (vector === undefined) {
        stderrWriter(`${config.models.embed} returned no embedding for the query`);
        return 1;
      }

      const cue: SeedCue = { text: flags.query, source: 'raw_query', weight: 3, vector };
      const selection = await selectSeeds(
        { driver: substrate.connection().driver, config, logger },
        { cues: [cue], mode: readModeFor(flags) },
      );

      if (flags.json) {
        write(JSON.stringify(toJson(selection.seeds)));
      } else {
        renderSearchResults(selection.seeds, write);
      }
      logger.info({ query: flags.query, results: selection.seeds.length }, 'search served');
      return 0;
    },
  });
}
