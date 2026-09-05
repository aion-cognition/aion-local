import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  listOldestOpenEntityMergeProposals,
  resolveEntityMergeProposal,
  type EntityMergeProposal,
} from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  listOldestOpenSupersessionProposals,
  resolveSupersessionProposal,
  type SupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import {
  judgeEntityMerge,
  reviewEntityMerge,
  type EntityMergePair,
} from '../../../reflection/application/entity-merge-judge.js';
import { applyEntityMergeProposal } from '../../../reflection/application/entity-merge-review.js';
import {
  applySupersessionProposal,
  INTROSPECTOR_RESOLUTION,
} from '../../../reflection/application/proposals.js';
import {
  judgeContradiction,
  type ContradictionPair,
} from '../../../reflection/application/stages/supersession-judge.js';
import {
  describeVeto,
  reviewContradiction,
} from '../../../reflection/application/stages/supersession-review.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';
import {
  contradictionPair,
  readClaimEvidence,
  readMergeEvidence,
} from '../proposal-resolution-evidence.js';

/**
 * Decides the open proposal queues on their merits, instead of leaving both to a person and to
 * the hygiene horizon behind them. A row reaches a terminal state in the run that reads it: two
 * agreeing judge passes apply it through the same applier and the same blade
 * `aion proposals apply` uses, anything else dismisses it, and the grounds go to the ops ledger
 * either way. A model call that throws or comes back unusable decides nothing and leaves the row
 * open for the next run.
 *
 * Both passes read wider evidence than the pass that filed the row was given
 * (`proposal-resolution-evidence.ts`), which is the only way a call at temperature 0 reaches an
 * answer the filing judge did not already give.
 *
 * Nothing here is one-way. A supersession it applies is reopened by `aion unsupersede`, a merge
 * by `aion unmerge`, and a dismissal by `aion proposals reopen`, exactly as each reverses a
 * person's own decision. `AION_PROPOSAL_RESOLUTION=false` stops the operation entirely and
 * leaves both queues waiting for a person.
 */

export const PROPOSAL_RESOLUTION_OPERATION = 'proposal_resolution';

/** Permanent, keyed by table and id: one decision per row, and the record stands alone. */
export const RESOLUTION_LEDGER_PREFIX = 'introspection:resolution:';

export type ResolutionProposalTable = 'supersession' | 'entity_merge';

export function resolutionLedgerKey(table: ResolutionProposalTable, id: string): string {
  return `${RESOLUTION_LEDGER_PREFIX}${table}:${id}`;
}

/**
 * Relevance reads the shipped batch rather than the live config, matching every other
 * operation's own relevance function: the contract hands it only the health snapshot. One run's
 * worth of open rows is as urgent as this gets, and an empty queue reads zero, which is the
 * reading a run that drained it earned.
 */
export function proposalResolutionRelevance(health: HealthSnapshot): number {
  const open = health.proposals.supersessionOpen + health.proposals.entityMergeOpen;
  return Math.min(1, open / DEFAULTS.maintenance.resolutionBatch);
}

type ResolutionCandidate =
  | { readonly table: 'supersession'; readonly proposal: SupersessionProposal }
  | { readonly table: 'entity_merge'; readonly proposal: EntityMergeProposal };

/**
 * The oldest open rows of both tables, each bounded in SQL and the merge cut to the batch
 * again. Oldest first, so a queue drains in the order it filled rather than by table.
 */
function loadCandidates(db: SqliteHandle, batch: number): readonly ResolutionCandidate[] {
  const supersessions: ResolutionCandidate[] = listOldestOpenSupersessionProposals(db, batch).map(
    (proposal) => ({ table: 'supersession', proposal }),
  );
  const merges: ResolutionCandidate[] = listOldestOpenEntityMergeProposals(db, batch).map(
    (proposal) => ({ table: 'entity_merge', proposal }),
  );
  return [...supersessions, ...merges]
    .sort((a, b) => Date.parse(a.proposal.createdAt) - Date.parse(b.proposal.createdAt))
    .slice(0, batch);
}

/**
 * What one row's two passes decided. `unanswered` is the only non-terminal answer, and it is a
 * technical failure rather than a reading: the row keeps its place in the queue.
 */
type Verdict =
  | { readonly decision: 'apply'; readonly grounds: string }
  | { readonly decision: 'dismiss'; readonly grounds: string }
  | { readonly decision: 'unanswered'; readonly detail: string };

type JudgeOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};

function judgeOptions(ctx: OperationContext): JudgeOptions {
  return {
    model: ctx.config.models.reflect,
    timeoutMs: ctx.config.reflection.stageTimeoutMs,
    signal: ctx.signal,
  };
}

/**
 * Both passes are asked on every row, including one the first pass declines. The verdict is the
 * same either way, and a record carrying two independent readings is what a later judgment of
 * these decisions has to work from.
 */
async function decideContradiction(
  ctx: OperationContext,
  pair: ContradictionPair,
): Promise<Verdict> {
  const options = judgeOptions(ctx);
  const first = await judgeContradiction(ctx.provider, pair, options);
  if (first.status !== 'judged') {
    return { decision: 'unanswered', detail: `the first pass came back ${first.status}` };
  }
  const second = await reviewContradiction(ctx.provider, pair, options);
  if (second.status !== 'reviewed') {
    return { decision: 'unanswered', detail: `the second pass came back ${second.status}` };
  }
  const rationale = first.judgment.rationale === undefined ? '' : ` (${first.judgment.rationale})`;
  const read = first.judgment.contradicts ? 'the correction holds' : 'the earlier claim stands';
  const grounds = `first pass: ${read}${rationale}; second pass: ${describeVeto(second.verdict)}`;
  const holds = first.judgment.contradicts && second.verdict.outcome === 'unanimous';
  return { decision: holds ? 'apply' : 'dismiss', grounds };
}

async function decideMerge(ctx: OperationContext, pair: EntityMergePair): Promise<Verdict> {
  const options = judgeOptions(ctx);
  const first = await judgeEntityMerge(ctx.provider, pair, options);
  if (first.status !== 'judged') {
    return { decision: 'unanswered', detail: `the first pass failed: ${first.detail}` };
  }
  const second = await reviewEntityMerge(ctx.provider, pair, options);
  if (second.status !== 'reviewed') {
    return { decision: 'unanswered', detail: `the second pass failed: ${second.detail}` };
  }
  const grounds =
    `first pass: ${first.judgment.same ? 'one referent' : 'two referents'} ` +
    `(${first.judgment.rationale}); ` +
    `second pass: ${second.review.same ? 'nothing separates them' : 'two referents'} ` +
    `(${second.review.rationale})`;
  const holds = first.judgment.same && second.review.same;
  return { decision: holds ? 'apply' : 'dismiss', grounds };
}

/**
 * One run's counters, mutated through methods rather than field writes: the tally is threaded
 * by reference through the two resolvers below, and a plain object's fields being written from
 * outside the type that owns them is what `no-param-reassign` catches.
 */
class ResolutionTally {
  #applied = 0;
  #dismissed = 0;
  #open = 0;

  get applied(): number {
    return this.#applied;
  }

  get dismissed(): number {
    return this.#dismissed;
  }

  /** Rows this run read and could not decide. Neither a verdict nor a failure of the run. */
  get open(): number {
    return this.#open;
  }

  get decided(): number {
    return this.#applied + this.#dismissed;
  }

  recordApplied(): void {
    this.#applied += 1;
  }

  recordDismissed(): void {
    this.#dismissed += 1;
  }

  recordOpen(): void {
    this.#open += 1;
  }
}

type Dismiss = (
  table: ResolutionProposalTable,
  id: string,
  resolvedAt: string,
  summary: unknown,
) => boolean;

/** A row nobody could decide this run, named in the log so a standing one is visible. */
function leaveOpen(
  ctx: OperationContext,
  id: string,
  reason: string,
  tally: ResolutionTally,
): void {
  tally.recordOpen();
  ctx.logger.info(
    { proposalId: id, reason },
    'proposal resolution left a row open for the next run',
  );
}

async function resolveContradiction(
  ctx: OperationContext,
  proposal: SupersessionProposal,
  dismiss: Dismiss,
  tally: ResolutionTally,
): Promise<void> {
  const prior = await readClaimEvidence(ctx.driver, proposal.oldId, ctx.now);
  const current = await readClaimEvidence(ctx.driver, proposal.newId, ctx.now);
  if (prior === undefined || current === undefined) {
    leaveOpen(ctx, proposal.id, 'a side of the pair is no longer readable', tally);
    return;
  }

  const verdict = await decideContradiction(ctx, contradictionPair(prior, current));
  if (verdict.decision === 'unanswered') {
    leaveOpen(ctx, proposal.id, verdict.detail, tally);
    return;
  }

  const base = {
    grounds: verdict.grounds,
    oldId: proposal.oldId,
    newId: proposal.newId,
    episodeId: proposal.episodeId,
  };
  if (verdict.decision === 'dismiss') {
    const summary = { verdict: 'dismissed', ...base };
    if (!dismiss('supersession', proposal.id, ctx.now.toISOString(), summary)) {
      leaveOpen(ctx, proposal.id, 'the row was resolved by someone else first', tally);
      return;
    }
    tally.recordDismissed();
    ctx.logger.info(
      { proposalId: proposal.id, grounds: verdict.grounds },
      'proposal resolution dismissed a contradiction',
    );
    return;
  }

  try {
    const applied = await applySupersessionProposal(ctx.driver, ctx.db, {
      id: proposal.id,
      relatednessFloor: ctx.config.reflection.supersedeFamilyRelatednessFloor,
      keyedCloseMode: ctx.config.reflection.keyedCloseMode,
      attribution: INTROSPECTOR_RESOLUTION,
      now: ctx.now,
    });
    // After the applier, which resolves the row itself once the close has landed. A crash in
    // this gap loses the ledger line and nothing else: the lineage edge carries the resolver's
    // own provenance, so the close is still attributable and still reversible.
    markLedgerApplied(ctx.db, resolutionLedgerKey('supersession', proposal.id), {
      verdict: 'applied',
      ...base,
      scope: applied.scope,
      closed: applied.closedIds,
      supersededBy: applied.supersededBy,
    });
    tally.recordApplied();
    ctx.logger.warn(
      {
        proposalId: proposal.id,
        closed: applied.closedIds,
        supersededBy: applied.supersededBy,
        grounds: verdict.grounds,
      },
      'proposal resolution applied a contradiction',
    );
  } catch (error) {
    leaveOpen(ctx, proposal.id, 'the close failed', tally);
    ctx.logger.warn(
      { err: error, proposalId: proposal.id },
      'proposal resolution could not apply a contradiction',
    );
  }
}

async function resolveMerge(
  ctx: OperationContext,
  proposal: EntityMergeProposal,
  dismiss: Dismiss,
  tally: ResolutionTally,
): Promise<void> {
  const pair = await readMergeEvidence(ctx.driver, proposal);
  if (pair === undefined) {
    leaveOpen(ctx, proposal.id, 'a side of the pair has lost currency', tally);
    return;
  }

  const verdict = await decideMerge(ctx, pair);
  if (verdict.decision === 'unanswered') {
    leaveOpen(ctx, proposal.id, verdict.detail, tally);
    return;
  }

  const base = {
    grounds: verdict.grounds,
    leftId: proposal.leftId,
    leftName: proposal.leftName,
    rightId: proposal.rightId,
    rightName: proposal.rightName,
    episodeId: proposal.episodeId,
  };
  if (verdict.decision === 'dismiss') {
    const summary = { verdict: 'dismissed', ...base };
    if (!dismiss('entity_merge', proposal.id, ctx.now.toISOString(), summary)) {
      leaveOpen(ctx, proposal.id, 'the row was resolved by someone else first', tally);
      return;
    }
    tally.recordDismissed();
    ctx.logger.info(
      { proposalId: proposal.id, grounds: verdict.grounds },
      'proposal resolution dismissed a merge',
    );
    return;
  }

  try {
    const applied = await applyEntityMergeProposal(
      { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
      { id: proposal.id, now: ctx.now },
    );
    markLedgerApplied(ctx.db, resolutionLedgerKey('entity_merge', proposal.id), {
      verdict: 'applied',
      ...base,
      outcome: applied.outcome,
    });
    tally.recordApplied();
    ctx.logger.warn(
      { proposalId: proposal.id, outcome: applied.outcome, grounds: verdict.grounds },
      'proposal resolution applied a merge',
    );
  } catch (error) {
    leaveOpen(ctx, proposal.id, 'the merge failed', tally);
    ctx.logger.warn(
      { err: error, proposalId: proposal.id },
      'proposal resolution could not apply a merge',
    );
  }
}

export function proposalResolutionOperation(): IntrospectionOperation {
  return {
    name: PROPOSAL_RESOLUTION_OPERATION,
    bucket: 'hour',
    enabled: (config) => config.maintenance.proposalResolution,
    relevance: proposalResolutionRelevance,
    // No `measure`. The open count is the only proposal gauge the snapshot carries, and an
    // operation scored on lowering it would be rewarded for applying a correction as much as
    // for declining one, which scores emptying the queue rather than deciding it.
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.proposalResolution) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'proposal resolution disabled by AION_PROPOSAL_RESOLUTION; no rows examined',
        };
      }

      const candidates = loadCandidates(ctx.db, ctx.config.maintenance.resolutionBatch);
      // Resolve and record as one commit, the way hygiene dismisses: a crash between the two
      // would leave a resolved row with no record of why, which is indistinguishable from a
      // bug. An apply cannot take this path, since the applier resolves its own row.
      const dismiss = ctx.db.transaction(
        (table: ResolutionProposalTable, id: string, resolvedAt: string, summary: unknown) => {
          const resolved =
            table === 'supersession'
              ? resolveSupersessionProposal(ctx.db, id, resolvedAt)
              : resolveEntityMergeProposal(ctx.db, id, resolvedAt);
          if (resolved) {
            markLedgerApplied(ctx.db, resolutionLedgerKey(table, id), summary);
          }
          return resolved;
        },
      );

      const tally = new ResolutionTally();
      let seen = 0;
      for (const candidate of candidates) {
        if (ctx.signal.aborted) {
          break;
        }
        seen += 1;
        if (candidate.table === 'supersession') {
          await resolveContradiction(ctx, candidate.proposal, dismiss, tally);
          continue;
        }
        await resolveMerge(ctx, candidate.proposal, dismiss, tally);
      }

      return {
        status: tally.decided === 0 ? 'noop' : 'applied',
        itemsProcessed: seen,
        itemsAffected: tally.decided,
        detail:
          `${String(tally.applied)} applied and ${String(tally.dismissed)} dismissed of ` +
          `${String(seen)} open proposal(s) read; ${String(tally.open)} left open for the next run`,
      };
    },
  };
}
