import {
  applyEntityMergeProposal,
  applySupersessionProposal,
  DEFAULT_APPLY_SCOPE,
  dismissEntityMergeProposal,
  dismissSupersessionProposal,
  getEntityMergeProposal,
  getSupersessionProposal,
  listEntityMergeProposals,
  listSupersessionProposals,
  markLedgerApplied,
  ProposalNotFoundError,
  reopenEntityMergeProposal,
  reopenSupersessionProposal,
  type ApplyEntityMergeProposalResult,
  type ApplyScope,
  type ClaimSubject,
  type EntityMergeProposal,
  type SqliteHandle,
  type SubjectSibling,
  type SupersessionProposal,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { short } from './format.js';
import { confirmOrExit, stdoutWriter, type Writer } from './output.js';
import { withSubstrate, type Substrate } from './substrate.js';

/**
 * Where a judged contradiction gets decided, when it is not decided on its own. Under the
 * shipped `unanimous` mode, a row here is a pair the second judge pass vetoed; the pipeline
 * already closed what both passes agreed on. `propose` is the kill switch: it stops the
 * pipeline from closing anything and queues every pair for this command instead.
 *
 * `apply` is the only writing subcommand and takes one id at a time on purpose: applying these
 * in bulk would reinstate auto-apply with an extra keystroke.
 */

const SUBCOMMANDS = ['ls', 'apply', 'dismiss', 'reopen'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const SPEC: ArgSpec<Subcommand> = {
  command: 'proposals',
  usage:
    'aion proposals [ls | apply <id> | dismiss <id> | reopen <id>] ' +
    '[--all] [--claim-only] [--episode] [--yes]',
  subcommands: SUBCOMMANDS,
  options: [{ flag: '--all' }, { flag: '--claim-only' }, { flag: '--episode' }, { flag: '--yes' }],
  maxPositionals: 1,
};

export type ProposalFlags = {
  readonly subcommand: Subcommand;
  readonly id?: string;
  /** Include already-resolved rows, which `ls` hides: the queue is the open ones. */
  readonly all: boolean;
  /** How wide the close cuts; `family` unless a flag narrows or widens it. */
  readonly scope: ApplyScope;
  readonly yes: boolean;
};

export function parseProposalFlags(argv: readonly string[]): ProposalFlags {
  const { subcommand, flags, positionals } = parseArgs(SPEC, argv);
  const [id] = positionals;
  const claimOnly = flags.has('--claim-only');
  const episode = flags.has('--episode');

  // Two scopes at once has no safe reading: one is narrower than the default and the other is
  // wider, so guessing would close either too little or far too much.
  if (claimOnly && episode) {
    throw new CliUsageError(
      'proposals apply takes one of --claim-only or --episode, not both ' +
        '(the default closes the judged claim and the siblings that name its subject)',
    );
  }
  if (subcommand !== 'ls' && id === undefined) {
    throw new CliUsageError(
      `proposals ${subcommand} needs a proposal id (see \`aion proposals ls\`)`,
    );
  }

  return {
    subcommand,
    ...(id === undefined ? {} : { id }),
    all: flags.has('--all'),
    scope: applyScope(claimOnly, episode),
    yes: flags.has('--yes'),
  };
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
        `${row.rightName} (${row.rightType}, ${short(row.rightId)}) at ` +
        `${row.similarity.toFixed(3)} ${row.similaritySource}`,
    );
  }
}

function isOpen(row: { readonly resolvedAt: string | null }): boolean {
  return row.resolvedAt === null;
}

type ProposalKind = 'supersession' | 'merge';

/**
 * `apply` and `dismiss` both take one bare id with nothing to say which queue it came from, so
 * both look it up in supersession first and fall back to entity-merge. An id in neither queue
 * throws the same not-found error either path already raises, with a message that says both
 * queues were searched rather than naming only the one this lookup tried first.
 */
function locateProposal(db: SqliteHandle, id: string): ProposalKind {
  if (getSupersessionProposal(db, id) !== undefined) {
    return 'supersession';
  }
  if (getEntityMergeProposal(db, id) !== undefined) {
    return 'merge';
  }
  const notFound = new ProposalNotFoundError(id);
  notFound.message = `no proposal with id ${id}: searched supersession and entity-merge proposals, found neither`;
  throw notFound;
}

function runLs(substrate: Substrate, flags: ProposalFlags): number {
  const db = substrate.db();
  const { write } = substrate;
  const supersessions = listSupersessionProposals(db).filter((row) => flags.all || isOpen(row));
  const merges = listEntityMergeProposals(db).filter((row) => flags.all || isOpen(row));
  renderSupersessions(supersessions, write);
  renderMerges(merges, write);
  if (!flags.all) {
    write('');
    write('open rows only; --all includes what has already been decided');
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

/**
 * Routes on what the id names before touching the graph, so a merge id with a supersession-only
 * scope flag is refused as a usage error rather than opening a connection first.
 */
async function runApply(substrate: Substrate, flags: ProposalFlags): Promise<number> {
  const id = flags.id ?? '';
  const kind = locateProposal(substrate.db(), id);
  if (kind === 'merge' && flags.scope !== DEFAULT_APPLY_SCOPE) {
    const flag = flags.scope === 'episode' ? '--episode' : '--claim-only';
    throw new CliUsageError(
      `proposals apply ${id}: ${flag} is a supersession scope and does not apply to an entity merge`,
    );
  }
  if (!(await confirmOrExit('apply it? [y/N] ', flags.yes, substrate.write))) {
    substrate.write('cancelled');
    return 1;
  }
  return kind === 'merge'
    ? await runApplyMerge(substrate, id)
    : await runApplySupersession(substrate, flags);
}

async function runApplySupersession(substrate: Substrate, flags: ProposalFlags): Promise<number> {
  const id = flags.id ?? '';
  const { config, write } = substrate;
  const connection = await substrate.requireGraph('apply');
  if (connection === undefined) {
    return 1;
  }
  const applied = await applySupersessionProposal(connection.driver, substrate.db(), {
    id,
    scope: flags.scope,
    relatednessFloor: config.reflection.supersedeFamilyRelatednessFloor,
    keyedCloseMode: config.reflection.keyedCloseMode,
  });
  substrate.logger().warn(
    {
      proposalId: id,
      scope: applied.scope,
      closed: applied.closedIds,
      supersededBy: applied.supersededBy,
      subjects: applied.subjects,
      held: applied.heldSiblings.map((sibling) => sibling.id),
      regroundedNarratives: applied.regroundedNarratives,
      retiredGlosses: applied.retiredGlosses.map((gloss) => gloss.entityId),
      openGlosses: applied.openGlosses.map((gloss) => gloss.entityId),
    },
    'supersession proposal applied',
  );
  write(
    `applied ${id} (${applied.scope}): closed ${String(applied.closedIds.length)} node(s), ` +
      `superseded by ${short(applied.supersededBy)}`,
  );
  renderClosed(applied.closedIds, applied.siblings, write);
  renderHeldSiblings(applied.heldSiblings, write);
  renderRetiredGlosses(applied.retiredGlosses, write);
  renderOpenGlosses(applied.openGlosses, write);
  renderRegrounded(applied.regroundedNarratives, write);
  write(SCOPE_NOTES[applied.scope]);
  return 0;
}

async function runApplyMerge(substrate: Substrate, id: string): Promise<number> {
  const { write } = substrate;
  const connection = await substrate.requireGraph('apply');
  if (connection === undefined) {
    return 1;
  }
  const logger = substrate.logger();
  const result = await applyEntityMergeProposal(
    { driver: connection.driver, db: substrate.db(), logger },
    { id },
  );
  logger.warn({ proposalId: id, ...result }, 'entity merge proposal applied');
  renderMergeApply(result, write);
  return 0;
}

/** One honest line per outcome; only a genuine merge earns the undo pointer and the edge count. */
function renderMergeApply(result: ApplyEntityMergeProposalResult, write: Writer): void {
  if (result.outcome === 'applied') {
    write(
      `applied ${result.id}: merged "${result.absorbed.name}" (${result.absorbed.type}, ` +
        `${short(result.absorbed.id)}) into "${result.canonical.name}" (${result.canonical.type}, ` +
        `${short(result.canonical.id)}), ${String(result.edgesRedirected)} edge(s) redirected`,
    );
    write(`\`aion unmerge\` splits it back out, citing decision ${short(result.decisionId)}`);
    if (result.vectorCleanupDeferred) {
      write('  vector cleanup deferred; the absorbed node keeps its old vectors for now');
    }
    return;
  }
  if (result.outcome === 'already_applied') {
    write(
      `applied ${result.id}: already merged, "${result.absorbed.name}" is inside ` +
        `"${result.canonical.name}"; the row is now resolved`,
    );
    return;
  }
  if (result.outcome === 'nothing_to_merge') {
    write(
      `applied ${result.id}: both sides are "${result.canonical.name}" ` +
        `(${short(result.canonical.id)}), so there was nothing to merge; the row is now resolved`,
    );
    return;
  }
  if (result.outcome === 'stale') {
    const gone =
      result.missingSide === 'both'
        ? 'neither side still holds currency'
        : `the ${result.missingSide} side no longer holds currency`;
    write(`applied ${result.id}: stale, ${gone}; the row is now resolved`);
    return;
  }
  write(`applied ${result.id}: already resolved at ${result.resolvedAt}; nothing to do`);
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

/**
 * A narrative compresses a session's claims and carries no lineage of its own, so a correction
 * leaves it standing and still stating the old value. It is marked here and rewritten by the
 * maintenance loop, which is a cadence rather than an instant, so the apply says so.
 */
function renderRegrounded(ids: readonly string[], write: Writer): void {
  if (ids.length === 0) {
    return;
  }
  write(
    `${String(ids.length)} narrative(s) marked for regrounding; ` +
      'maintenance rewrites them from the claims that are open now',
  );
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

function runDismiss(substrate: Substrate, flags: ProposalFlags): number {
  const id = flags.id ?? '';
  const kind = locateProposal(substrate.db(), id);
  if (kind === 'merge') {
    return runDismissMerge(substrate, id);
  }
  const dismissed = dismissSupersessionProposal(substrate.db(), id);
  substrate
    .logger()
    .info({ proposalId: id, oldId: dismissed.oldId }, 'supersession proposal dismissed');
  substrate.write(`dismissed ${id}: nothing was closed and ${short(dismissed.oldId)} stands`);
  return 0;
}

function runDismissMerge(substrate: Substrate, id: string): number {
  const result = dismissEntityMergeProposal(substrate.db(), id);
  if (!result.dismissed) {
    substrate.write(`dismissed ${id}: already resolved at ${result.resolvedAt}; nothing to do`);
    return 0;
  }
  substrate
    .logger()
    .info(
      { proposalId: id, leftId: result.left.id, rightId: result.right.id },
      'entity merge proposal dismissed',
    );
  substrate.write(
    `dismissed ${id}: ${result.left.name} (${result.left.type}) and ` +
      `${result.right.name} (${result.right.type}) stay separate`,
  );
  return 0;
}

/**
 * The undo for a dismissal, whoever made it: hygiene aging a row out, or a person clicking
 * dismiss on one that deserved another look. `reopen()` guards the same way `resolve()` does,
 * in the other direction, so a row already open is refused rather than silently accepted.
 * The ledger entry is permanent and separate from any dismissal stamp: it names what reopened
 * and when, without touching or needing to know about whatever stamped the row resolved.
 */
function reopenLedgerKey(kind: ProposalKind, id: string): string {
  const table = kind === 'merge' ? 'entity_merge' : 'supersession';
  return `proposal_reopen:${table}:${id}`;
}

function runReopen(substrate: Substrate, flags: ProposalFlags): number {
  const id = flags.id ?? '';
  const db = substrate.db();
  const kind = locateProposal(db, id);
  const reopened =
    kind === 'merge' ? reopenEntityMergeProposal(db, id) : reopenSupersessionProposal(db, id);
  if (!reopened) {
    substrate.write(`reopen ${id}: already open; nothing to do`);
    return 0;
  }
  markLedgerApplied(db, reopenLedgerKey(kind, id), {
    id,
    kind,
    reopenedAt: new Date().toISOString(),
  });
  substrate.logger().info({ proposalId: id, kind }, 'proposal reopened');
  substrate.write(`reopened ${id}: back in the open queue for \`aion proposals ls\``);
  return 0;
}

export function runProposals(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseProposalFlags,
    run: async (substrate, flags) => {
      if (flags.subcommand === 'apply') {
        return await runApply(substrate, flags);
      }
      if (flags.subcommand === 'dismiss') {
        return runDismiss(substrate, flags);
      }
      if (flags.subcommand === 'reopen') {
        return runReopen(substrate, flags);
      }
      return runLs(substrate, flags);
    },
  });
}
