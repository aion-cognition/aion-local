import {
  ConfigError,
  fetchNodeProvenance,
  forgetNode,
  GraphConnection,
  loadConfig,
  OllamaProvider,
  openLogger,
  selectSeeds,
  type Config,
  type Logger,
  type Seed,
  type SeedCue,
} from '@aion/core';
import { createInterface } from 'node:readline/promises';

import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/**
 * `aion forget <id|query>`: the one true suppression, and the only writing command in this
 * file. By id it asks before it writes; by query it resolves through the same seed layer
 * `aion search` uses and refuses to guess among more than one match. Nothing is deleted:
 * `forgetNode` sets `forgotten_at`, and `as_of`/`knew_at` reads keep seeing the row
 * (`read-modes.ts`) so the audit trail survives.
 */

export class UnknownForgetOptionError extends Error {
  constructor(option: string) {
    super(`unknown option '${option}' for forget (supported: --yes)`);
    this.name = 'UnknownForgetOptionError';
  }
}

export class MissingForgetTargetError extends Error {
  constructor() {
    super('forget needs an id or a query: `aion forget <id|query>`');
    this.name = 'MissingForgetTargetError';
  }
}

export type ForgetFlags = {
  readonly target: string;
  readonly yes: boolean;
};

export function parseForgetFlags(argv: readonly string[]): ForgetFlags {
  let target: string | undefined;
  let yes = false;

  for (const arg of argv) {
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UnknownForgetOptionError(arg);
    }
    target = target === undefined ? arg : `${target} ${arg}`;
  }

  if (target === undefined || target.trim().length === 0) {
    throw new MissingForgetTargetError();
  }
  return { target, yes };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `deriveCognitiveNodeId` mints the nine cognitive types' ids this way (sha256 hex). */
const HEX_ID_SHAPE = /^[0-9a-f]{64}$/i;

/** Shape only, no graph read: a query never happens to look like an id, and this stays sync. */
export function looksLikeNodeId(value: string): boolean {
  return UUID_SHAPE.test(value) || HEX_ID_SHAPE.test(value);
}

function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** `--yes` skips the ask; with no terminal to ask on, `--yes` is the only way through. */
async function confirm(assumeYes: boolean, write: Writer): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    write('re-run with --yes to forget it (no terminal to confirm on)');
    return false;
  }
  const answer = (await askOnTerminal('forget it? [y/N] ')).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function reportForgotten(
  write: Writer,
  logger: Logger,
  id: string,
  result: { readonly forgottenAt: Date; readonly justForgotten: boolean },
): void {
  logger.warn({ nodeId: id, forgottenAt: result.forgottenAt.toISOString() }, 'node forgotten');
  write(
    result.justForgotten
      ? `forgot ${id} at ${result.forgottenAt.toISOString()}`
      : `${id} was already forgotten, at ${result.forgottenAt.toISOString()}`,
  );
  write('nothing was deleted; --as-of/--knew-at reads on `aion search` still find it');
}

type ForgetDeps = {
  readonly connection: GraphConnection;
  readonly config: Config;
  readonly logger: Logger;
};

async function forgetById(
  deps: ForgetDeps,
  id: string,
  flags: ForgetFlags,
  write: Writer,
): Promise<number> {
  const provenance = await fetchNodeProvenance(deps.connection.driver, id);
  if (provenance === undefined) {
    stderrWriter(`no node found for '${id}' (it may not exist, or already be forgotten)`);
    return 1;
  }

  write(`about to forget ${id} (${provenance.labels.join(', ')}): ${preview(provenance.content)}`);
  const confirmed = await confirm(flags.yes, write);
  if (!confirmed) {
    write('cancelled');
    return 1;
  }

  const result = await forgetNode(deps.connection.driver, { id });
  reportForgotten(write, deps.logger, id, result);
  return 0;
}

function renderMatches(matches: readonly Seed[], write: Writer): void {
  matches.forEach((seed, index) => {
    write(
      `  ${String(index + 1)}. ${seed.id} (${seed.labels.join(', ')}) ` +
        `score=${seed.score.toFixed(3)}: ${preview(seed.content)}`,
    );
  });
}

async function forgetByQuery(
  deps: ForgetDeps,
  query: string,
  flags: ForgetFlags,
  write: Writer,
): Promise<number> {
  const provider = new OllamaProvider({
    baseUrl: deps.config.ollama.url,
    embedModel: deps.config.models.embed,
  });
  const [vector] = await provider.embed([query]);
  if (vector === undefined) {
    stderrWriter(`${deps.config.models.embed} returned no embedding for the query`);
    return 1;
  }

  const cue: SeedCue = { text: query, source: 'raw_query', weight: 3, vector };
  const selection = await selectSeeds(
    { driver: deps.connection.driver, config: deps.config, logger: deps.logger },
    { cues: [cue] },
  );
  const matches = selection.seeds;

  if (matches.length === 0) {
    write(`no matches for '${query}'`);
    return 1;
  }

  if (matches.length > 1) {
    write(
      `${String(matches.length)} matches for '${query}'; forget takes an id when there is more than one`,
    );
    renderMatches(matches, write);
    write('re-run `aion forget <id>` with the one you mean');
    return 1;
  }

  const [only] = matches as [Seed];
  write(`1 match: ${only.id} (${only.labels.join(', ')}): ${preview(only.content)}`);
  if (!flags.yes) {
    write('re-run with --yes to forget it');
    return 0;
  }

  const result = await forgetNode(deps.connection.driver, { id: only.id });
  reportForgotten(write, deps.logger, only.id, result);
  return 0;
}

export async function runForget(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  let flags: ForgetFlags;
  let config: Config;
  try {
    flags = parseForgetFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-forget' });
  const connection = new GraphConnection(config.neo4j);
  try {
    const health = await connection.health();
    if (!health.reachable) {
      stderrWriter(
        `forget needs Neo4j: ${connection.uri} unreachable: ${health.error ?? 'unknown error'}`,
      );
      return 1;
    }

    const deps: ForgetDeps = { connection, config, logger };
    if (looksLikeNodeId(flags.target)) {
      return await forgetById(deps, flags.target, flags, write);
    }
    return await forgetByQuery(deps, flags.target, flags, write);
  } catch (err) {
    logger.error({ err: describeError(err) }, 'forget failed');
    stderrWriter(describeError(err));
    return 1;
  } finally {
    await connection.close();
  }
}
