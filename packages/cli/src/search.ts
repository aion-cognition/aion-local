import {
  asOf,
  bitemporalAt,
  ConfigError,
  GraphConnection,
  knewAt,
  loadConfig,
  OllamaProvider,
  openLogger,
  selectSeeds,
  withCurrency,
  type Config,
  type ReadMode,
  type Seed,
  type SeedCue,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/**
 * The seed layer with nothing built on top of it: no cue-model expansion, no traversal, no
 * resonance, no pack assembly. The query embeds once and rides the same four strategies and
 * budget curve `recall` uses (`selectSeeds`), which is what makes this a debugging window on
 * the real thing rather than a second search implementation. `--as-of`/`--knew-at` bind the
 * same bitemporal read mode `recall` does, so a time-travel search sees exactly what a
 * time-travel recall would have found.
 */

export class UnknownSearchOptionError extends Error {
  constructor(option: string) {
    super(`unknown option '${option}' for search (supported: --as-of, --knew-at, --json)`);
    this.name = 'UnknownSearchOptionError';
  }
}

export class MissingSearchValueError extends Error {
  constructor(option: string) {
    super(`${option} needs a value`);
    this.name = 'MissingSearchValueError';
  }
}

export class InvalidTimestampError extends Error {
  constructor(option: string, value: string) {
    super(`${option} got '${value}', expected an ISO timestamp`);
    this.name = 'InvalidTimestampError';
  }
}

export class MissingSearchQueryError extends Error {
  constructor() {
    super('search needs a query: `aion search "<query>"`');
    this.name = 'MissingSearchQueryError';
  }
}

export type SearchFlags = {
  readonly query: string;
  readonly asOf?: Date;
  readonly knewAt?: Date;
  readonly json: boolean;
};

function parseTimestamp(option: string, value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidTimestampError(option, value);
  }
  return parsed;
}

export function parseSearchFlags(argv: readonly string[]): SearchFlags {
  let query: string | undefined;
  let asOfFlag: Date | undefined;
  let knewAtFlag: Date | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--as-of' || arg === '--knew-at') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new MissingSearchValueError(arg);
      }
      const parsed = parseTimestamp(arg, value);
      if (arg === '--as-of') {
        asOfFlag = parsed;
      } else {
        knewAtFlag = parsed;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UnknownSearchOptionError(arg);
    }
    // An unquoted multi-word query arrives as several argv entries; join them back.
    query = query === undefined ? arg : `${query} ${arg}`;
  }

  if (query === undefined || query.trim().length === 0) {
    throw new MissingSearchQueryError();
  }
  return {
    query,
    json,
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

function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderSearchResults(seeds: readonly Seed[], write: Writer): void {
  if (seeds.length === 0) {
    write('no matches');
    return;
  }
  write('score   method              currency    label          id                                    content');
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

export async function runSearch(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  let flags: SearchFlags;
  let config: Config;
  try {
    flags = parseSearchFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-search' });
  const connection = new GraphConnection(config.neo4j);
  try {
    const health = await connection.health();
    if (!health.reachable) {
      stderrWriter(`search needs Neo4j: ${connection.uri} unreachable: ${health.error ?? 'unknown error'}`);
      return 1;
    }

    const provider = new OllamaProvider({ baseUrl: config.ollama.url, embedModel: config.models.embed });
    const [vector] = await provider.embed([flags.query]);
    if (vector === undefined) {
      stderrWriter(`${config.models.embed} returned no embedding for the query`);
      return 1;
    }

    const cue: SeedCue = { text: flags.query, source: 'raw_query', weight: 3, vector };
    const mode = readModeFor(flags);
    const selection = await selectSeeds({ driver: connection.driver, config, logger }, { cues: [cue], mode });

    if (flags.json) {
      write(JSON.stringify(toJson(selection.seeds)));
    } else {
      renderSearchResults(selection.seeds, write);
    }
    logger.info({ query: flags.query, results: selection.seeds.length }, 'search served');
    return 0;
  } catch (err) {
    logger.error({ err: describeError(err) }, 'search failed');
    stderrWriter(describeError(err));
    return 1;
  } finally {
    await connection.close();
  }
}
