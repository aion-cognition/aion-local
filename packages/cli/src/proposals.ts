import {
  applySupersessionProposal,
  ConfigError,
  dismissSupersessionProposal,
  GraphConnection,
  listEntityMergeProposals,
  listSupersessionProposals,
  loadConfig,
  openLogger,
  SqliteStore,
  type Config,
  type EntityMergeProposal,
  type Logger,
  type SqliteHandle,
  type SupersessionProposal,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/**
 * Where a judged contradiction gets decided. Supersession is propose-only, because the judge
 * emits 1.0 on every firing and three of three live firings were false, so nothing in the
 * pipeline closes a claim any more. Without a command the proposal tables are write-only, and a stored
 * correction can never change what recall answers, which was the user-visible failure the
 * posture change was meant to fix.
 *
 * `apply` is the only writing subcommand and takes one id at a time on purpose: these are the
 * judgments the model got wrong three times out of three, so applying them in bulk would
 * reinstate auto-apply with an extra keystroke.
 */

const SUBCOMMANDS = ['ls', 'apply', 'dismiss'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export class UnknownProposalSubcommandError extends Error {
  constructor(name: string) {
    super(`unknown proposals subcommand '${name}' (supported: ${SUBCOMMANDS.join(', ')})`);
    this.name = 'UnknownProposalSubcommandError';
  }
}

export class UnknownProposalOptionError extends Error {
  constructor(option: string) {
    super(`unknown option '${option}' for proposals (supported: --all, --episode)`);
    this.name = 'UnknownProposalOptionError';
  }
}

export class MissingProposalIdError extends Error {
  constructor(subcommand: string) {
    super(`proposals ${subcommand} needs a proposal id (see \`aion proposals ls\`)`);
    this.name = 'MissingProposalIdError';
  }
}

export type ProposalFlags = {
  readonly subcommand: Subcommand;
  readonly id?: string;
  /** Include already-resolved rows, which `ls` hides: the queue is the open ones. */
  readonly all: boolean;
  /** Close the claim's whole source episode and its derived family, not the one claim. */
  readonly episode: boolean;
};

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export function parseProposalFlags(argv: readonly string[]): ProposalFlags {
  const [first = 'ls', ...rest] = argv;
  if (!isSubcommand(first)) {
    throw new UnknownProposalSubcommandError(first);
  }

  let id: string | undefined;
  let all = false;
  let episode = false;

  for (const arg of rest) {
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--episode') {
      episode = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UnknownProposalOptionError(arg);
    }
    id = arg;
  }

  if (first !== 'ls' && id === undefined) {
    throw new MissingProposalIdError(first);
  }
  return { subcommand: first, ...(id === undefined ? {} : { id }), all, episode };
}

type ProposalDeps = {
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
  readonly write: Writer;
};

/** Short enough to read in a list, long enough to paste back as an unambiguous id prefix. */
function short(id: string): string {
  return id.slice(0, 8);
}

function renderSupersessions(rows: readonly SupersessionProposal[], write: Writer): void {
  write(`supersession proposals (${String(rows.length)})`);
  if (rows.length === 0) {
    write('  none');
    return;
  }
  for (const row of rows) {
    const state = row.resolvedAt === null ? 'open' : `resolved ${row.resolvedAt}`;
    write(`  ${row.id}  ${state}`);
    write(`    would close ${short(row.oldId)} in favour of ${short(row.newId)}`);
    write(`    from episode ${short(row.episodeId)}, confidence ${row.confidence.toFixed(2)}`);
    if (row.rationale !== null) {
      write(`    rationale: ${row.rationale}`);
    }
  }
}

function renderMerges(rows: readonly EntityMergeProposal[], write: Writer): void {
  write('');
  write(`entity-merge proposals (${String(rows.length)})`);
  if (rows.length === 0) {
    write('  none');
    return;
  }
  for (const row of rows) {
    const state = row.resolvedAt === null ? 'open' : `resolved ${row.resolvedAt}`;
    write(`  ${row.id}  ${state}`);
    write(
      `    ${row.leftName} (${row.leftType}, ${short(row.leftId)}) and ` +
        `${row.rightName} (${row.rightType}, ${short(row.rightId)}) at ${row.similarity.toFixed(3)}`,
    );
  }
}

function isOpen(row: { readonly resolvedAt: string | null }): boolean {
  return row.resolvedAt === null;
}

function runLs(deps: ProposalDeps, flags: ProposalFlags): number {
  const supersessions = listSupersessionProposals(deps.db).filter((row) => flags.all || isOpen(row));
  const merges = listEntityMergeProposals(deps.db).filter((row) => flags.all || isOpen(row));
  renderSupersessions(supersessions, deps.write);
  renderMerges(merges, deps.write);
  if (!flags.all) {
    deps.write('');
    deps.write('open rows only; --all includes what has already been decided');
  }
  return 0;
}

async function runApply(deps: ProposalDeps, flags: ProposalFlags): Promise<number> {
  const id = flags.id ?? '';
  const connection = new GraphConnection(deps.config.neo4j);
  try {
    const health = await connection.health();
    if (!health.reachable) {
      stderrWriter(
        `apply needs Neo4j: ${connection.uri} unreachable: ${health.error ?? 'unknown error'}`,
      );
      return 1;
    }
    const applied = await applySupersessionProposal(connection.driver, deps.db, {
      id,
      ...(flags.episode ? { episode: true } : {}),
    });
    deps.logger.warn(
      { proposalId: id, closed: applied.closedIds, supersededBy: applied.supersededBy },
      'supersession proposal applied',
    );
    deps.write(
      `applied ${id}: closed ${String(applied.closedIds.length)} node(s), superseded by ${short(applied.supersededBy)}`,
    );
    for (const closed of applied.closedIds) {
      deps.write(`  closed ${closed}`);
    }
    if (!flags.episode) {
      deps.write('the claim alone is closed; --episode also closes its source episode’s family');
    }
    return 0;
  } finally {
    await connection.close();
  }
}

function runDismiss(deps: ProposalDeps, flags: ProposalFlags): number {
  const id = flags.id ?? '';
  const dismissed = dismissSupersessionProposal(deps.db, id);
  deps.logger.info({ proposalId: id, oldId: dismissed.oldId }, 'supersession proposal dismissed');
  deps.write(`dismissed ${id}: nothing was closed and ${short(dismissed.oldId)} stands`);
  return 0;
}

export async function runProposals(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  let flags: ProposalFlags;
  let config: Config;
  try {
    flags = parseProposalFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-proposals' });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const deps: ProposalDeps = { db: store.db, config, logger, write };
  try {
    if (flags.subcommand === 'apply') {
      return await runApply(deps, flags);
    }
    if (flags.subcommand === 'dismiss') {
      return runDismiss(deps, flags);
    }
    return runLs(deps, flags);
  } catch (err) {
    logger.error({ err: describeError(err) }, 'proposals command failed');
    stderrWriter(describeError(err));
    return 1;
  } finally {
    store.close();
  }
}
