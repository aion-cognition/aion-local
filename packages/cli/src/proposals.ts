import {
  applySupersessionProposal,
  ConfigError,
  DEFAULT_APPLY_SCOPE,
  dismissSupersessionProposal,
  GraphConnection,
  listEntityMergeProposals,
  listSupersessionProposals,
  loadConfig,
  openLogger,
  SqliteStore,
  type ApplyScope,
  type ClaimSubject,
  type Config,
  type EntityMergeProposal,
  type Logger,
  type SqliteHandle,
  type SubjectSibling,
  type SupersessionProposal,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/**
 * Where a judged contradiction gets decided. Supersession is propose-only, because the judge
 * answers with one confidence for every firing whichever model it runs on, so nothing in the
 * pipeline closes a claim on its own. Without a command the proposal tables are write-only, and
 * a stored correction can never change what recall answers, which was the user-visible failure
 * the posture change was meant to fix.
 *
 * `apply` is the only writing subcommand and takes one id at a time on purpose: applying these
 * in bulk would reinstate auto-apply with an extra keystroke.
 */

const SUBCOMMANDS = ['ls', 'apply', 'dismiss'] as const;

const OPTIONS = ['--all', '--claim-only', '--episode'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export class UnknownProposalSubcommandError extends Error {
  constructor(name: string) {
    super(`unknown proposals subcommand '${name}' (supported: ${SUBCOMMANDS.join(', ')})`);
    this.name = 'UnknownProposalSubcommandError';
  }
}

export class UnknownProposalOptionError extends Error {
  constructor(option: string) {
    super(`unknown option '${option}' for proposals (supported: ${OPTIONS.join(', ')})`);
    this.name = 'UnknownProposalOptionError';
  }
}

export class MissingProposalIdError extends Error {
  constructor(subcommand: string) {
    super(`proposals ${subcommand} needs a proposal id (see \`aion proposals ls\`)`);
    this.name = 'MissingProposalIdError';
  }
}

export class ConflictingApplyScopeError extends Error {
  constructor() {
    super(
      'proposals apply takes one of --claim-only or --episode, not both ' +
        '(the default closes the judged claim and the siblings that name its subject)',
    );
    this.name = 'ConflictingApplyScopeError';
  }
}

export type ProposalFlags = {
  readonly subcommand: Subcommand;
  readonly id?: string;
  /** Include already-resolved rows, which `ls` hides: the queue is the open ones. */
  readonly all: boolean;
  /** How wide the close cuts; `family` unless a flag narrows or widens it. */
  readonly scope: ApplyScope;
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
  let claimOnly = false;
  let episode = false;

  for (const arg of rest) {
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--claim-only') {
      claimOnly = true;
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

  if (claimOnly && episode) {
    throw new ConflictingApplyScopeError();
  }
  if (first !== 'ls' && id === undefined) {
    throw new MissingProposalIdError(first);
  }

  return { subcommand: first, ...(id === undefined ? {} : { id }), all, scope: applyScope(claimOnly, episode) };
}

function applyScope(claimOnly: boolean, episode: boolean): ApplyScope {
  if (episode) {
    return 'episode';
  }
  if (claimOnly) {
    return 'claim';
  }
  return DEFAULT_APPLY_SCOPE;
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

/** What the mode just did, and what the other two would have done instead. */
const SCOPE_NOTES: Readonly<Record<ApplyScope, string>> = {
  family:
    'the judged claim and the siblings naming its subject are closed; ' +
    '--claim-only closes the one claim, --episode closes everything its observation produced',
  claim:
    'the claim alone is closed, so a sibling from the same observation may still state the old value; ' +
    'the default also closes the siblings that name its subject',
  episode:
    'the whole observation is closed, definitions and historical records included; ' +
    'the default closes only what names the subject of the judged claim',
};

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
      scope: flags.scope,
      relatednessFloor: deps.config.reflection.supersedeFamilyRelatednessFloor,
    });
    deps.logger.warn(
      {
        proposalId: id,
        scope: applied.scope,
        closed: applied.closedIds,
        supersededBy: applied.supersededBy,
        subjects: applied.subjects,
        held: applied.heldSiblings.map((sibling) => sibling.id),
        retiredGlosses: applied.retiredGlosses.map((gloss) => gloss.entityId),
        openGlosses: applied.openGlosses.map((gloss) => gloss.entityId),
      },
      'supersession proposal applied',
    );
    deps.write(
      `applied ${id} (${applied.scope}): closed ${String(applied.closedIds.length)} node(s), ` +
        `superseded by ${short(applied.supersededBy)}`,
    );
    renderClosed(applied.closedIds, applied.siblings, deps.write);
    renderHeldSiblings(applied.heldSiblings, deps.write);
    renderRetiredGlosses(applied.retiredGlosses, deps.write);
    renderOpenGlosses(applied.openGlosses, deps.write);
    deps.write(SCOPE_NOTES[applied.scope]);
    return 0;
  } finally {
    await connection.close();
  }
}

function renderClosed(
  closedIds: readonly string[],
  siblings: readonly SubjectSibling[],
  write: Writer,
): void {
  const bySubject = new Map(siblings.map((sibling) => [sibling.id, sibling]));
  for (const closed of closedIds) {
    const sibling = bySubject.get(closed);
    if (sibling === undefined) {
      write(`  closed ${closed}`);
      continue;
    }
    write(`  closed ${closed}  ${sibling.label}, on subject "${sibling.subject}"`);
  }
}

/**
 * What the correction named but did not answer. Two claims out of one observation can share a
 * subject and be about different things, and closing the second because it said the same name
 * takes a fact that is still true; the person who meant to take the whole observation has
 * `--episode` and now knows what it would cost.
 */
function renderHeldSiblings(siblings: readonly SubjectSibling[], write: Writer): void {
  if (siblings.length === 0) {
    return;
  }
  write(`${String(siblings.length)} sibling(s) name this subject and stand:`);
  for (const sibling of siblings) {
    const reading =
      sibling.relatedness === undefined
        ? 'no vector to compare yet'
        : `relatedness ${sibling.relatedness.toFixed(2)}`;
    write(`  ${short(sibling.id)}  ${sibling.label}, ${reading}: ${sibling.text}`);
  }
}

/**
 * The carrier that kept a corrected substrate answering with the old value at rank 1. The
 * entity itself is untouched, so every mention still resolves through it; what went is the
 * one sentence written about it when it was first named.
 */
function renderRetiredGlosses(glosses: readonly ClaimSubject[], write: Writer): void {
  if (glosses.length === 0) {
    return;
  }
  write(`${String(glosses.length)} entity description(s) retired, entities kept:`);
  for (const gloss of glosses) {
    write(`  ${short(gloss.entityId)}  ${gloss.name} no longer reads "${gloss.gloss ?? ''}"`);
  }
}

/** Descriptions of the same subjects that assert something the correction did not touch. */
function renderOpenGlosses(glosses: readonly ClaimSubject[], write: Writer): void {
  if (glosses.length === 0) {
    return;
  }
  write(`${String(glosses.length)} entity description(s) name this subject and stand:`);
  for (const gloss of glosses) {
    write(`  ${short(gloss.entityId)}  ${gloss.name}: ${gloss.gloss ?? ''}`);
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
