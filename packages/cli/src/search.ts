import {
  checkCoverage,
  coverageLines,
  CoverageRequestError,
  embedQueryPrefix,
  OllamaProvider,
  readCoverageFence,
  refusalLines,
  refuseCheckedRead,
  selectSeeds,
  type CheckedRead,
  type Seed,
  type SeedCue,
  type SqliteHandle,
} from '@aion/core';
import { IsoTimestampSchema, type CoverageEnvelope, type CoverageRefusal } from '@aion/protocol';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { preview } from './format.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * The seed layer with nothing built on top of it: no cue-model expansion, no traversal, no
 * resonance, no pack assembly. The query embeds once and rides the same four strategies and
 * budget curve `recall` uses (`selectSeeds`), which is what makes this a debugging window on
 * the real thing rather than a second search implementation. `--as-of`/`--knew-at` go through
 * the same coverage checker and bind the same read mode `recall` does, so a time-travel search
 * sees exactly what a time-travel recall would have found and is refused where recall is.
 */

/**
 * The break this command's `--json` makes, said where whoever types it will read it. A coverage
 * statement cannot be attached to a bare array, and dropping it would let a partial answer print
 * as a complete one; `schema_version` is how a consumer tells the two apart.
 */
const JSON_ENVELOPE_NOTE =
  '--json prints {"schema_version":1,"results":[…]} with the coverage statement beside the results, not a bare array';

const SPEC: ArgSpec = {
  command: 'search',
  usage: `aion search <query> [--as-of <ts>] [--knew-at <ts>] [--json]\n  ${JSON_ENVELOPE_NOTE}`,
  options: [
    { flag: '--as-of', takesValue: true },
    { flag: '--knew-at', takesValue: true },
    { flag: '--json' },
  ],
  maxPositionals: Number.POSITIVE_INFINITY,
};

export type SearchFlags = {
  readonly query: string;
  /** As typed. The grammar accepted it; the checker is what turns it into an instant. */
  readonly asOf?: string;
  readonly knewAt?: string;
  readonly json: boolean;
};

/**
 * The protocol's own grammar, so a date this command accepts is one the tool accepts and lands
 * on the same instant. What it rejects is a usage error: the substrate has said nothing about
 * its reach yet, and an unparseable date asks no question coverage can answer.
 */
function timestampOf(values: ReadonlyMap<string, string>, option: string): string | undefined {
  const value = values.get(option);
  if (value === undefined) {
    return undefined;
  }
  if (!IsoTimestampSchema.safeParse(value).success) {
    throw new CliUsageError(`${option} got '${value}', expected an ISO timestamp`);
  }
  return value;
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

export type SearchCoverage =
  | { readonly status: 'checked'; readonly read: CheckedRead }
  | { readonly status: 'refused'; readonly refusal: CoverageRefusal };

/**
 * The one coverage decision, taken before the query is embedded. A refused search calls no
 * model and reads no graph, which is the whole reason it comes first.
 */
export function searchCoverage(
  db: SqliteHandle,
  flags: SearchFlags,
  now: Date,
  expiryAnnotation = true,
): SearchCoverage {
  let checked;
  try {
    checked = checkCoverage(db, {
      ...(flags.asOf === undefined ? {} : { asOf: flags.asOf }),
      ...(flags.knewAt === undefined ? {} : { knewAt: flags.knewAt }),
      now,
      expiryAnnotation,
    });
  } catch (err) {
    // The flags already passed this grammar; a rejection here means the two disagree, and a
    // disagreement about what a date means is a usage error rather than a coverage answer.
    if (err instanceof CoverageRequestError) {
      throw new CliUsageError(err.message);
    }
    throw err;
  }
  return checked.status === 'refused'
    ? { status: 'refused', refusal: checked.refusal }
    : { status: 'checked', read: { context: checked.context, coverage: checked.coverage } };
}

/**
 * The same completion policy a checked recall commits under, for a read with nothing to commit.
 *
 * A search writes nothing, so it has no effects to hold back; what it owes is the same refusal:
 * an epoch that moved is `coverage_changed` against the bounds now verified, and a registry that
 * stopped being readable is `coverage_store_unavailable` with no bounds at all. The refusal is
 * built by the shared helper rather than assembled here, so both surfaces refuse in one voice.
 */
export function searchCompletion(db: SqliteHandle, read: CheckedRead): SearchCoverage {
  const fence = readCoverageFence(db);
  if (fence === read.context.coverageEpoch) {
    return { status: 'checked', read };
  }
  const refused = refuseCheckedRead(
    db,
    read,
    fence === undefined ? 'coverage_store_unavailable' : 'coverage_changed',
  );
  return refused.status === 'refused'
    ? { status: 'refused', refusal: refused.refusal }
    : { status: 'checked', read };
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

type SeedJson = ReturnType<typeof seedJson>;

function seedJson(seed: Seed): Record<string, unknown> {
  return {
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
  };
}

/**
 * The versioned envelope, always. The results ride inside it beside what the answer covers, and
 * a refusal rides in it with no results at all: a refused search made no answer, and an empty
 * array is one.
 */
export function searchEnvelope(
  outcome: SearchCoverage,
  seeds: readonly Seed[],
): CoverageEnvelope<SeedJson> {
  if (outcome.status === 'refused') {
    return { schema_version: 1, results: [], coverage_refusal: outcome.refusal };
  }
  return { schema_version: 1, results: seeds.map(seedJson), coverage: outcome.read.coverage };
}

/**
 * Both shapes from one place, so what the text says and what the JSON carries cannot drift: a
 * coverage line dropped from the printed answer is how a reader comes to believe it covers more
 * than it does, and a refusal printed as "no matches" is the same mistake with worse manners.
 */
export function writeSearchAnswer(
  outcome: SearchCoverage,
  seeds: readonly Seed[],
  json: boolean,
  write: Writer,
): void {
  if (json) {
    write(JSON.stringify(searchEnvelope(outcome, seeds)));
    return;
  }
  if (outcome.status === 'refused') {
    for (const line of refusalLines(outcome.refusal)) {
      write(line);
    }
    return;
  }
  for (const line of coverageLines(outcome.read.coverage)) {
    write(line);
  }
  renderSearchResults(seeds, write);
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
    // The graph requirement is asked inside the command, after coverage: a request the substrate
    // will not answer is refused from the registry alone, and a reader whose Neo4j is down is
    // owed that refusal rather than a connection error about a search that was never going to run.
    run: async (substrate, flags) => {
      const { config } = substrate;
      const logger = substrate.logger();
      // Before the graph check and before the embedding call, so a refused search spends nothing
      // and reads nothing. The same knob the tool reads, so this binds the mode recall binds.
      const coverage = searchCoverage(
        substrate.db(),
        flags,
        new Date(),
        config.temporal.expiryAnnotation,
      );
      if (coverage.status === 'refused') {
        writeSearchAnswer(coverage, [], flags.json, write);
        logger.info({ reason: coverage.refusal.reason }, 'search refused');
        return 1;
      }
      if ((await substrate.requireGraph('search')) === undefined) {
        return 1;
      }
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
        { cues: [cue], mode: coverage.read.context.mode },
      );

      // The contract is checked again before a result is printed. Embedding and seed selection
      // are awaits, and a contract that moved across them makes this answer one the substrate no
      // longer stands behind: printing it under the statement taken beforehand would describe
      // coverage that is not in force, and printing it under the new one would relabel a stale
      // reading. Neither is on offer, so the completion refuses and the reader asks again.
      const completed = searchCompletion(substrate.db(), coverage.read);
      if (completed.status === 'refused') {
        writeSearchAnswer(completed, [], flags.json, write);
        logger.info({ reason: completed.refusal.reason }, 'search refused at completion');
        return 1;
      }
      writeSearchAnswer(coverage, selection.seeds, flags.json, write);
      logger.info({ query: flags.query, results: selection.seeds.length }, 'search served');
      return 0;
    },
  });
}
